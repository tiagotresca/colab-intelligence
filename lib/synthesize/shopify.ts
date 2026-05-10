// Synthesize layer — Shopify KPIs.
//
// Lê orders de DUAS fontes (API + manual import), dedupe por order_id
// (API ganha), e produz KPIs diários em kpi_snapshots.
//
// Para classificação new-vs-returning a nível de order, lê
// first_order_at da tabela canonical `customers` (que já está
// sintetizada antes desta função correr — ver lib/ingest/shopify.ts
// step 5b → 5c).
//
// Janela 30d (default), recomputa todo o histórico relevante em cada
// run. Idempotente.

import crypto from 'node:crypto';
import { supabase } from '../supabase.js';
import type { Channel, PeriodGrain } from '../types.js';

const CHANNEL: Channel = 'shopify';
const GRAIN: PeriodGrain = 'day';
const DEFAULT_LOOKBACK_DAYS = 30;
const SHOPIFY_BACKFILL_SOURCE = 'shopify_export';

const REVENUE_STATUSES = new Set(['paid', 'partially_refunded']);

// Order shape unificado (ambas as fontes mapeadas para isto)
interface OrderRow {
  external_id: string;       // shopify_order_id (string) ou external_order_id
  email: string | null;
  created_at: string;
  total_price: number | null;
  financial_status: string | null;
  currency: string | null;
}

interface KpiRow {
  empresa_id: string;
  channel: Channel;
  metric_key: string;
  period_grain: PeriodGrain;
  period_start: string;
  value: number | null;
  meta: Record<string, unknown> | null;
}

export interface SynthesizeResult {
  days_computed: number;
  kpis_upserted: number;
  range: { start: string; end: string };
}

export interface SynthesizeOptions {
  lookback_days?: number;
}

function hashEmail(email: string): string {
  return crypto
    .createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex');
}

export async function synthesizeShopify(
  empresa_id: string,
  options: SynthesizeOptions = {},
): Promise<SynthesizeResult> {
  const lookback = options.lookback_days ?? DEFAULT_LOOKBACK_DAYS;
  const now = new Date();
  const rangeEnd = now.toISOString();
  const rangeStart = new Date(
    now.getTime() - lookback * 24 * 3600 * 1000,
  ).toISOString();

  // 1. Fetch orders no range de ambas as fontes em paralelo.
  // 2. Fetch first_order_at por email_hash da customers table
  //    (canonical, lifetime, já fundida pelo synth de customers).
  const [apiOrdersQ, manualOrdersQ, customersQ] = await Promise.all([
    supabase
      .from('shopify_orders_raw')
      .select('shopify_order_id, email, created_at, total_price, financial_status, currency')
      .eq('empresa_id', empresa_id)
      .gte('created_at', rangeStart)
      .lt('created_at', rangeEnd)
      .limit(50000),
    supabase
      .from('manual_orders_raw')
      .select('external_order_id, email, created_at, total_price, financial_status, currency')
      .eq('empresa_id', empresa_id)
      .eq('source_platform', SHOPIFY_BACKFILL_SOURCE)
      .gte('created_at', rangeStart)
      .lt('created_at', rangeEnd)
      .limit(50000),
    supabase
      .from('customers')
      .select('email_hash, first_order_at')
      .eq('empresa_id', empresa_id)
      .eq('platform', 'shopify')
      .limit(100000),
  ]);

  if (apiOrdersQ.error) throw new Error(`synth fetch api orders: ${apiOrdersQ.error.message}`);
  if (manualOrdersQ.error) throw new Error(`synth fetch manual orders: ${manualOrdersQ.error.message}`);
  if (customersQ.error) throw new Error(`synth fetch customers: ${customersQ.error.message}`);

  // 3. Build first_order_at lookup
  const firstOrderByEmailHash = new Map<string, string>();
  for (const c of (customersQ.data ?? []) as Array<{
    email_hash: string;
    first_order_at: string | null;
  }>) {
    if (c.first_order_at) firstOrderByEmailHash.set(c.email_hash, c.first_order_at);
  }

  // 4. Combine orders, dedup by order id (API wins)
  type ApiOrder = {
    shopify_order_id: number;
    email: string | null;
    created_at: string;
    total_price: number | null;
    financial_status: string | null;
    currency: string | null;
  };
  type ManualOrder = {
    external_order_id: string;
    email: string | null;
    created_at: string;
    total_price: number | null;
    financial_status: string | null;
    currency: string | null;
  };
  const apiOrders = (apiOrdersQ.data ?? []) as ApiOrder[];
  const manualOrders = (manualOrdersQ.data ?? []) as ManualOrder[];

  const combined: OrderRow[] = [];
  const seenIds = new Set<string>();

  for (const o of apiOrders) {
    const id = String(o.shopify_order_id);
    seenIds.add(id);
    combined.push({
      external_id: id,
      email: o.email,
      created_at: o.created_at,
      total_price: o.total_price,
      financial_status: o.financial_status,
      currency: o.currency,
    });
  }
  for (const o of manualOrders) {
    if (seenIds.has(o.external_order_id)) continue;
    combined.push({
      external_id: o.external_order_id,
      email: o.email,
      created_at: o.created_at,
      total_price: o.total_price,
      financial_status: o.financial_status,
      currency: o.currency,
    });
  }

  if (combined.length === 0) {
    return {
      days_computed: 0,
      kpis_upserted: 0,
      range: { start: rangeStart, end: rangeEnd },
    };
  }

  // 5. Group by day
  const byDay = new Map<string, OrderRow[]>();
  for (const o of combined) {
    const day = o.created_at.slice(0, 10);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(o);
    else byDay.set(day, [o]);
  }

  // 6. Compute daily KPIs
  const kpiRows: KpiRow[] = [];
  for (const [day, dayOrders] of byDay) {
    const periodStart = `${day}T00:00:00.000Z`;

    const revenueOrders = dayOrders.filter((o) =>
      REVENUE_STATUSES.has(o.financial_status ?? ''),
    );
    const revenue = revenueOrders.reduce(
      (s, o) => s + (Number(o.total_price) || 0),
      0,
    );
    const orders_count = dayOrders.length;
    const aov = orders_count > 0 ? revenue / orders_count : 0;

    // Customer-level e order-level classification usando email_hash
    // como chave (uniforme entre API e manual).
    const distinctEmails = new Set<string>();
    let ordersWithEmail = 0;
    let repeatOrdersCount = 0;
    for (const o of dayOrders) {
      if (!o.email) continue;
      ordersWithEmail++;
      const hash = hashEmail(o.email);
      distinctEmails.add(hash);
      const firstAt = firstOrderByEmailHash.get(hash);
      // "Repeat" = este order não é o primeiro ever do customer.
      // Comparação de timestamps strict — se o primeiro EVER é este,
      // first === created_at (e este conta como new).
      if (firstAt && firstAt < o.created_at) repeatOrdersCount++;
    }

    let new_customers = 0;
    for (const hash of distinctEmails) {
      const firstAt = firstOrderByEmailHash.get(hash);
      if (firstAt && firstAt.slice(0, 10) === day) new_customers++;
    }

    const repeat_purchase_rate =
      ordersWithEmail > 0 ? repeatOrdersCount / ordersWithEmail : 0;

    const currency = dayOrders.find((o) => o.currency)?.currency ?? null;
    const baseFields = {
      empresa_id,
      channel: CHANNEL,
      period_grain: GRAIN,
      period_start: periodStart,
    } as const;

    kpiRows.push({
      ...baseFields,
      metric_key: 'revenue_day',
      value: revenue,
      meta: currency ? { currency } : null,
    });
    kpiRows.push({
      ...baseFields,
      metric_key: 'orders_count_day',
      value: orders_count,
      meta: null,
    });
    kpiRows.push({
      ...baseFields,
      metric_key: 'aov_day',
      value: aov,
      meta: currency ? { currency } : null,
    });
    kpiRows.push({
      ...baseFields,
      metric_key: 'new_customers_day',
      value: new_customers,
      meta: null,
    });
    kpiRows.push({
      ...baseFields,
      metric_key: 'repeat_purchase_rate_day',
      value: repeat_purchase_rate,
      meta: { numerator: repeatOrdersCount, denominator: ordersWithEmail },
    });
  }

  if (kpiRows.length === 0) {
    return {
      days_computed: byDay.size,
      kpis_upserted: 0,
      range: { start: rangeStart, end: rangeEnd },
    };
  }

  const { error: upsertErr } = await supabase
    .from('kpi_snapshots')
    .upsert(kpiRows, {
      onConflict: 'empresa_id,channel,metric_key,period_grain,period_start',
    });
  if (upsertErr) {
    throw new Error(`upsert kpi_snapshots: ${upsertErr.message}`);
  }

  return {
    days_computed: byDay.size,
    kpis_upserted: kpiRows.length,
    range: { start: rangeStart, end: rangeEnd },
  };
}
