// Customers Foundation — synthesize layer.
//
// Lê shopify_orders_raw + shopify_order_attribution para uma empresa,
// agrupa por email_hash, e produz a tabela canónica `customers` com
// lifetime aggregates + acquisition derivada do PRIMEIRO order.
//
// Idempotente via unique constraint (empresa_id, platform, email_hash).
// Re-correr é seguro e barato — recomputa a partir do raw sempre.
//
// Cross-platform: este ficheiro só lida com platform='shopify'. Quando
// adicionarmos custom sites, criar lib/synthesize/customers-custom-site.ts
// que segue o mesmo padrão. A tabela `customers` aceita ambos via coluna
// platform.
//
// Lookback: depende do que estiver em shopify_orders_raw. Para customers
// que tenham orders fora do raw, first_order_at fica IMPRECISO (mostra
// o primeiro que vemos, não o real). Mitigado quando read_all_orders
// for aprovado e fizermos backfill total (PR A.6).

import crypto from 'node:crypto';
import { supabase } from '../supabase.js';

const PLATFORM = 'shopify' as const;
const BATCH_SIZE = 500;

interface OrderRow {
  shopify_order_id: number;
  email: string | null;
  created_at: string;
  total_price: number | null;
  customer_id: number | null;
}

interface AttributionRow {
  shopify_order_id: number;
  first_touch_source: string | null;
  first_touch_medium: string | null;
  utm_campaign: string | null;
  landing_site: string | null;
  primary_discount_code: string | null;
}

interface CustomerRow {
  empresa_id: string;
  platform: 'shopify';
  email_hash: string;
  email: string;
  external_customer_id: string | null;
  first_order_at: string;
  last_order_at: string;
  orders_count: number;
  total_revenue: number;
  acquisition_source: string | null;
  acquisition_medium: string | null;
  acquisition_campaign: string | null;
  acquisition_landing_site: string | null;
  acquisition_discount_code: string | null;
  acquisition_first_touch_confidence: 'high' | 'medium' | 'low';
  synced_at: string;
}

export interface SynthesizeCustomersResult {
  customers_synthesized: number;
  orders_processed: number;
  orders_skipped_no_email: number;
}

function hashEmail(email: string): string {
  return crypto
    .createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex');
}

function computeConfidence(
  hasUtm: boolean,
  source: string | null,
): 'high' | 'medium' | 'low' {
  if (hasUtm) return 'high';
  if (source && source !== 'direct') return 'medium';
  return 'low';
}

export async function synthesizeCustomersShopify(
  empresa_id: string,
): Promise<SynthesizeCustomersResult> {
  // 1. Fetch orders + attribution para a empresa.
  // 2 queries em vez de join SQL para ficar simples e portável.
  const [ordersQ, attrQ] = await Promise.all([
    supabase
      .from('shopify_orders_raw')
      .select('shopify_order_id, email, created_at, total_price, customer_id')
      .eq('empresa_id', empresa_id)
      .limit(50000),
    supabase
      .from('shopify_order_attribution')
      .select('shopify_order_id, first_touch_source, first_touch_medium, utm_campaign, landing_site, primary_discount_code')
      .eq('empresa_id', empresa_id)
      .limit(50000),
  ]);

  if (ordersQ.error) {
    throw new Error(`fetch orders for customers synth: ${ordersQ.error.message}`);
  }
  if (attrQ.error) {
    throw new Error(`fetch attribution for customers synth: ${attrQ.error.message}`);
  }

  const orders = (ordersQ.data ?? []) as OrderRow[];
  const attributions = (attrQ.data ?? []) as AttributionRow[];

  if (orders.length === 0) {
    return {
      customers_synthesized: 0,
      orders_processed: 0,
      orders_skipped_no_email: 0,
    };
  }

  // 2. Index attribution por order_id para join O(1)
  const attrByOrderId = new Map<number, AttributionRow>();
  for (const a of attributions) {
    attrByOrderId.set(a.shopify_order_id, a);
  }

  // 3. Agrupar orders por email_hash. Guest checkouts (email null)
  // são saltados — não contam para a customer base.
  interface OrderEnriched {
    shopify_order_id: number;
    created_at: string;
    total_price: number;
    customer_id: number | null;
    attr: AttributionRow | undefined;
  }
  interface CustomerGroup {
    email: string;
    customer_id: number | null;
    orders: OrderEnriched[];
  }

  const groups = new Map<string, CustomerGroup>();
  let skippedNoEmail = 0;
  for (const o of orders) {
    if (!o.email) {
      skippedNoEmail++;
      continue;
    }
    const hash = hashEmail(o.email);
    const enriched: OrderEnriched = {
      shopify_order_id: o.shopify_order_id,
      created_at: o.created_at,
      total_price: Number(o.total_price) || 0,
      customer_id: o.customer_id,
      attr: attrByOrderId.get(o.shopify_order_id),
    };
    const existing = groups.get(hash);
    if (existing) {
      existing.orders.push(enriched);
      // Capture customer_id se ainda não temos
      if (!existing.customer_id && enriched.customer_id) {
        existing.customer_id = enriched.customer_id;
      }
    } else {
      groups.set(hash, {
        email: o.email,
        customer_id: enriched.customer_id,
        orders: [enriched],
      });
    }
  }

  // 4. Para cada group, build customer row
  const now = new Date().toISOString();
  const customerRows: CustomerRow[] = [];
  for (const [emailHash, group] of groups) {
    // Sort ascending para descobrir primeiro order
    const sorted = group.orders.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const totalRevenue = sorted.reduce((sum, o) => sum + o.total_price, 0);

    const firstAttr = first.attr;
    const hasUtm = !!(firstAttr?.utm_campaign || firstAttr?.first_touch_source);
    const acqSource = firstAttr?.first_touch_source ?? null;

    customerRows.push({
      empresa_id,
      platform: PLATFORM,
      email_hash: emailHash,
      email: group.email,
      external_customer_id: group.customer_id ? String(group.customer_id) : null,
      first_order_at: first.created_at,
      last_order_at: last.created_at,
      orders_count: sorted.length,
      total_revenue: totalRevenue,
      acquisition_source: acqSource,
      acquisition_medium: firstAttr?.first_touch_medium ?? null,
      acquisition_campaign: firstAttr?.utm_campaign ?? null,
      acquisition_landing_site: firstAttr?.landing_site ?? null,
      acquisition_discount_code: firstAttr?.primary_discount_code ?? null,
      acquisition_first_touch_confidence: computeConfidence(hasUtm, acqSource),
      synced_at: now,
    });
  }

  // 5. Upsert em batches
  for (let i = 0; i < customerRows.length; i += BATCH_SIZE) {
    const batch = customerRows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('customers')
      .upsert(batch, { onConflict: 'empresa_id,platform,email_hash' });
    if (error) {
      throw new Error(`upsert customers: ${error.message}`);
    }
  }

  return {
    customers_synthesized: customerRows.length,
    orders_processed: orders.length - skippedNoEmail,
    orders_skipped_no_email: skippedNoEmail,
  };
}
