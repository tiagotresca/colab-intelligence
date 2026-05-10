// Customers Foundation — synthesize layer.
//
// Lê de DUAS fontes para platform='shopify':
//   - shopify_orders_raw + shopify_order_attribution (API ETL daily)
//   - manual_orders_raw com source_platform='shopify_export' (CSV import)
//
// Dedup quando o mesmo external_order_id está nas 2 fontes:
// **API ganha** (mais fresca, com refunds/edits posteriores ao import).
//
// Para platforms custom (sites próprios), usar
// synthesizeCustomersFromManual(empresa_id, source_platform).
//
// Idempotente via unique constraint (empresa_id, platform, email_hash).

import crypto from 'node:crypto';
import { supabase } from '../supabase.js';
import { assertNoLimitHit } from '../util/limits.js';

const SHOPIFY_PLATFORM = 'shopify' as const;
const SHOPIFY_BACKFILL_SOURCE = 'shopify_export' as const;
const BATCH_SIZE = 500;

interface ApiOrderRow {
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
  utm_source: string | null;
  utm_campaign: string | null;
  landing_site: string | null;
  referring_site: string | null;
  primary_discount_code: string | null;
}

interface ManualOrderRow {
  external_order_id: string;
  email: string | null;
  created_at: string;
  total_price: number | null;
  customer_id: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  landing_url: string | null;
  referrer: string | null;
  primary_discount_code: string | null;
}

// Source-agnostic: representa um order para efeitos de aggregation.
interface OrderEvent {
  external_id: string;       // string for both sources
  email: string;
  customer_id: string | null;
  created_at: string;
  total_price: number;
  // attribution
  first_touch_source: string | null;
  first_touch_medium: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  landing_site: string | null;
  referring_site: string | null;
  primary_discount_code: string | null;
}

interface CustomerRow {
  empresa_id: string;
  platform: string;
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
  api_orders: number;
  manual_orders: number;
  duplicates_skipped: number;
}

function hashEmail(email: string): string {
  return crypto
    .createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex');
}

function computeConfidence(
  hasUtm: boolean,
  hasReferrer: boolean,
  source: string | null,
): 'high' | 'medium' | 'low' {
  if (hasUtm) return 'high';
  if (hasReferrer && source && source !== 'direct') return 'medium';
  return 'low';
}

function apiOrderToEvent(
  o: ApiOrderRow,
  attr: AttributionRow | undefined,
): OrderEvent | null {
  if (!o.email) return null;
  return {
    external_id: String(o.shopify_order_id),
    email: o.email,
    customer_id: o.customer_id ? String(o.customer_id) : null,
    created_at: o.created_at,
    total_price: Number(o.total_price) || 0,
    first_touch_source: attr?.first_touch_source ?? null,
    first_touch_medium: attr?.first_touch_medium ?? null,
    utm_source: attr?.utm_source ?? null,
    utm_campaign: attr?.utm_campaign ?? null,
    landing_site: attr?.landing_site ?? null,
    referring_site: attr?.referring_site ?? null,
    primary_discount_code: attr?.primary_discount_code ?? null,
  };
}

function manualOrderToEvent(o: ManualOrderRow): OrderEvent | null {
  if (!o.email) return null;
  // Para manual orders, a attribution está inline no row.
  // first_touch_source não vem directamente — derivamos básico aqui.
  const ftSource = o.utm_source
    ? o.utm_source.toLowerCase()
    : null;
  return {
    external_id: o.external_order_id,
    email: o.email,
    customer_id: o.customer_id,
    created_at: o.created_at,
    total_price: Number(o.total_price) || 0,
    first_touch_source: ftSource,
    first_touch_medium: o.utm_medium,
    utm_source: o.utm_source,
    utm_campaign: o.utm_campaign,
    landing_site: o.landing_url,
    referring_site: o.referrer,
    primary_discount_code: o.primary_discount_code,
  };
}

// ---- Main entry: Shopify (API + backfill) -----------------------------------

export async function synthesizeCustomersShopify(
  empresa_id: string,
): Promise<SynthesizeCustomersResult> {
  // 1. Read all 3 sources in parallel
  const [ordersQ, attrQ, manualQ] = await Promise.all([
    supabase
      .from('shopify_orders_raw')
      .select('shopify_order_id, email, created_at, total_price, customer_id')
      .eq('empresa_id', empresa_id)
      .limit(50000),
    supabase
      .from('shopify_order_attribution')
      .select('shopify_order_id, first_touch_source, first_touch_medium, utm_source, utm_campaign, landing_site, referring_site, primary_discount_code')
      .eq('empresa_id', empresa_id)
      .limit(50000),
    supabase
      .from('manual_orders_raw')
      .select('external_order_id, email, created_at, total_price, customer_id, utm_source, utm_medium, utm_campaign, landing_url, referrer, primary_discount_code')
      .eq('empresa_id', empresa_id)
      .eq('source_platform', SHOPIFY_BACKFILL_SOURCE)
      .limit(100000),
  ]);

  if (ordersQ.error) throw new Error(`fetch api orders: ${ordersQ.error.message}`);
  if (attrQ.error) throw new Error(`fetch attribution: ${attrQ.error.message}`);
  if (manualQ.error) throw new Error(`fetch manual orders: ${manualQ.error.message}`);
  assertNoLimitHit(ordersQ.data, 50000, `customers synth api orders ${empresa_id}`);
  assertNoLimitHit(attrQ.data, 50000, `customers synth attribution ${empresa_id}`);
  assertNoLimitHit(manualQ.data, 100000, `customers synth manual orders ${empresa_id}`);

  const apiOrders = (ordersQ.data ?? []) as ApiOrderRow[];
  const attributions = (attrQ.data ?? []) as AttributionRow[];
  const manualOrders = (manualQ.data ?? []) as ManualOrderRow[];

  // 2. Build attribution map for API orders
  const attrByOrderId = new Map<number, AttributionRow>();
  for (const a of attributions) attrByOrderId.set(a.shopify_order_id, a);

  // 3. Build OrderEvents — API first, manual second (deduped)
  const events: OrderEvent[] = [];
  const apiOrderIds = new Set<string>();
  let skippedNoEmail = 0;

  for (const o of apiOrders) {
    const ev = apiOrderToEvent(o, attrByOrderId.get(o.shopify_order_id));
    if (!ev) {
      skippedNoEmail++;
      continue;
    }
    apiOrderIds.add(ev.external_id);
    events.push(ev);
  }

  let duplicatesSkipped = 0;
  let manualOrdersIncluded = 0;
  for (const o of manualOrders) {
    if (apiOrderIds.has(o.external_order_id)) {
      duplicatesSkipped++;
      continue; // API wins
    }
    const ev = manualOrderToEvent(o);
    if (!ev) {
      skippedNoEmail++;
      continue;
    }
    events.push(ev);
    manualOrdersIncluded++;
  }

  if (events.length === 0) {
    return {
      customers_synthesized: 0,
      orders_processed: 0,
      orders_skipped_no_email: skippedNoEmail,
      api_orders: apiOrders.length,
      manual_orders: manualOrders.length,
      duplicates_skipped: duplicatesSkipped,
    };
  }

  // 4. Group by email_hash
  interface CustomerGroup {
    email: string;
    customer_id: string | null;
    events: OrderEvent[];
  }
  const groups = new Map<string, CustomerGroup>();
  for (const ev of events) {
    const hash = hashEmail(ev.email);
    const existing = groups.get(hash);
    if (existing) {
      existing.events.push(ev);
      if (!existing.customer_id && ev.customer_id) {
        existing.customer_id = ev.customer_id;
      }
    } else {
      groups.set(hash, {
        email: ev.email,
        customer_id: ev.customer_id,
        events: [ev],
      });
    }
  }

  // 5. Build customer rows
  const now = new Date().toISOString();
  const customerRows: CustomerRow[] = [];
  for (const [emailHash, group] of groups) {
    const sorted = group.events.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const totalRevenue = sorted.reduce((sum, ev) => sum + ev.total_price, 0);

    const hasUtm = !!(first.utm_source || first.utm_campaign);
    const hasReferrer = !!first.referring_site;
    const acqSource = first.first_touch_source;

    customerRows.push({
      empresa_id,
      platform: SHOPIFY_PLATFORM,
      email_hash: emailHash,
      email: group.email,
      external_customer_id: group.customer_id,
      first_order_at: first.created_at,
      last_order_at: last.created_at,
      orders_count: sorted.length,
      total_revenue: totalRevenue,
      acquisition_source: acqSource,
      acquisition_medium: first.first_touch_medium,
      acquisition_campaign: first.utm_campaign,
      acquisition_landing_site: first.landing_site,
      acquisition_discount_code: first.primary_discount_code,
      acquisition_first_touch_confidence: computeConfidence(hasUtm, hasReferrer, acqSource),
      synced_at: now,
    });
  }

  // 6. Upsert
  for (let i = 0; i < customerRows.length; i += BATCH_SIZE) {
    const batch = customerRows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('customers')
      .upsert(batch, { onConflict: 'empresa_id,platform,email_hash' });
    if (error) throw new Error(`upsert customers: ${error.message}`);
  }

  return {
    customers_synthesized: customerRows.length,
    orders_processed: events.length,
    orders_skipped_no_email: skippedNoEmail,
    api_orders: apiOrders.length,
    manual_orders: manualOrdersIncluded,
    duplicates_skipped: duplicatesSkipped,
  };
}

// ---- Custom platforms (sites custom-made, sem API) --------------------------
//
// Para empresa com site custom: o Tiago importa CSV com source_platform
// definido (ex: 'aquinta_custom'). Esta função processa e popula
// `customers` com platform=<source_platform>.

export async function synthesizeCustomersFromManual(
  empresa_id: string,
  source_platform: string,
): Promise<SynthesizeCustomersResult> {
  if (source_platform === SHOPIFY_BACKFILL_SOURCE) {
    // Para backfill Shopify, usa a função principal que merge com API.
    return synthesizeCustomersShopify(empresa_id);
  }

  const { data, error } = await supabase
    .from('manual_orders_raw')
    .select('external_order_id, email, created_at, total_price, customer_id, utm_source, utm_medium, utm_campaign, landing_url, referrer, primary_discount_code')
    .eq('empresa_id', empresa_id)
    .eq('source_platform', source_platform)
    .limit(100000);

  if (error) throw new Error(`fetch manual orders (${source_platform}): ${error.message}`);
  assertNoLimitHit(data, 100000, `customers synth manual orders custom ${empresa_id} ${source_platform}`);

  const manualOrders = (data ?? []) as ManualOrderRow[];
  let skippedNoEmail = 0;
  const events: OrderEvent[] = [];
  for (const o of manualOrders) {
    const ev = manualOrderToEvent(o);
    if (!ev) {
      skippedNoEmail++;
      continue;
    }
    events.push(ev);
  }

  if (events.length === 0) {
    return {
      customers_synthesized: 0,
      orders_processed: 0,
      orders_skipped_no_email: skippedNoEmail,
      api_orders: 0,
      manual_orders: manualOrders.length,
      duplicates_skipped: 0,
    };
  }

  // Group + build (mesmo loop do shopify)
  interface CustomerGroup {
    email: string;
    customer_id: string | null;
    events: OrderEvent[];
  }
  const groups = new Map<string, CustomerGroup>();
  for (const ev of events) {
    const hash = hashEmail(ev.email);
    const existing = groups.get(hash);
    if (existing) {
      existing.events.push(ev);
      if (!existing.customer_id && ev.customer_id) {
        existing.customer_id = ev.customer_id;
      }
    } else {
      groups.set(hash, {
        email: ev.email,
        customer_id: ev.customer_id,
        events: [ev],
      });
    }
  }

  const now = new Date().toISOString();
  const customerRows: CustomerRow[] = [];
  for (const [emailHash, group] of groups) {
    const sorted = group.events.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const totalRevenue = sorted.reduce((sum, ev) => sum + ev.total_price, 0);
    const hasUtm = !!(first.utm_source || first.utm_campaign);
    const hasReferrer = !!first.referring_site;

    customerRows.push({
      empresa_id,
      platform: source_platform,
      email_hash: emailHash,
      email: group.email,
      external_customer_id: group.customer_id,
      first_order_at: first.created_at,
      last_order_at: last.created_at,
      orders_count: sorted.length,
      total_revenue: totalRevenue,
      acquisition_source: first.first_touch_source,
      acquisition_medium: first.first_touch_medium,
      acquisition_campaign: first.utm_campaign,
      acquisition_landing_site: first.landing_site,
      acquisition_discount_code: first.primary_discount_code,
      acquisition_first_touch_confidence: computeConfidence(hasUtm, hasReferrer, first.first_touch_source),
      synced_at: now,
    });
  }

  for (let i = 0; i < customerRows.length; i += BATCH_SIZE) {
    const batch = customerRows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('customers')
      .upsert(batch, { onConflict: 'empresa_id,platform,email_hash' });
    if (error) throw new Error(`upsert customers (${source_platform}): ${error.message}`);
  }

  return {
    customers_synthesized: customerRows.length,
    orders_processed: events.length,
    orders_skipped_no_email: skippedNoEmail,
    api_orders: 0,
    manual_orders: events.length,
    duplicates_skipped: 0,
  };
}
