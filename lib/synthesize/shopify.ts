// Synthesize layer — Shopify.
//
// Lê das tabelas raw (shopify_orders_raw, shopify_customers_raw) e
// produz KPIs derivados em kpi_snapshots. Função pura — não chama a
// Shopify API, só faz queries à nossa DB.
//
// Phase 1: 5 KPIs base, granularidade diária. Adicionar KPI = adicionar
// entrada no KPI_REGISTRY abaixo + função compute. Não toca no
// orquestrador.
//
// Idempotente: kpi_snapshots tem unique constraint
// (empresa_id, channel, metric_key, period_grain, period_start) →
// upsert sobre re-run só actualiza valores.

import { supabase } from '../supabase.js';
import type { Channel, PeriodGrain } from '../types.js';

const CHANNEL: Channel = 'shopify';
const GRAIN: PeriodGrain = 'day';

// Status que contam para revenue. Refunded = 0, paid e
// partially_refunded contam (com total_price líquido reportado).
const REVENUE_STATUSES = new Set(['paid', 'partially_refunded']);

interface OrderRow {
  shopify_order_id: number;
  created_at: string;
  total_price: number | null;
  financial_status: string | null;
  customer_id: number | null;
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
}

export async function synthesizeShopify(
  empresa_id: string,
  range: { start: string; end: string },
): Promise<SynthesizeResult> {
  // 1. Fetch orders dentro do range. Limit alto — para >50k orders
  // numa empresa grande, paginar (TODO Phase 1.5).
  const { data: ordersData, error: ordersErr } = await supabase
    .from('shopify_orders_raw')
    .select(
      'shopify_order_id, created_at, total_price, financial_status, customer_id, currency',
    )
    .eq('empresa_id', empresa_id)
    .gte('created_at', range.start)
    .lt('created_at', range.end)
    .limit(50000);

  if (ordersErr) {
    throw new Error(`synthesize fetch orders falhou: ${ordersErr.message}`);
  }
  const orders = (ordersData ?? []) as OrderRow[];

  if (orders.length === 0) {
    return { days_computed: 0, kpis_upserted: 0 };
  }

  // 2. Para cada customer, descobrir a data do PRIMEIRO order alguma
  // vez (across full raw da empresa, não só do range). Usado para
  // classificar new vs returning. Limite alto idem.
  const { data: histData, error: histErr } = await supabase
    .from('shopify_orders_raw')
    .select('customer_id, created_at')
    .eq('empresa_id', empresa_id)
    .not('customer_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(50000);

  if (histErr) {
    throw new Error(`synthesize fetch first orders falhou: ${histErr.message}`);
  }

  const firstOrderByCustomer = new Map<number, string>();
  for (const row of (histData ?? []) as Array<{
    customer_id: number;
    created_at: string;
  }>) {
    if (!firstOrderByCustomer.has(row.customer_id)) {
      firstOrderByCustomer.set(row.customer_id, row.created_at);
    }
  }

  // 3. Agrupar orders por dia UTC (YYYY-MM-DD)
  const byDay = new Map<string, OrderRow[]>();
  for (const o of orders) {
    const day = o.created_at.slice(0, 10);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(o);
    else byDay.set(day, [o]);
  }

  // 4. Computar KPIs por dia
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

    const distinctCustomers = new Set<number>();
    for (const o of dayOrders) {
      if (o.customer_id != null) distinctCustomers.add(o.customer_id);
    }

    let new_customers = 0;
    for (const cid of distinctCustomers) {
      const first = firstOrderByCustomer.get(cid);
      if (first && first.slice(0, 10) === day) new_customers++;
    }

    const ordersWithCustomer = dayOrders.filter((o) => o.customer_id != null);
    let repeatOrdersCount = 0;
    for (const o of ordersWithCustomer) {
      const first = firstOrderByCustomer.get(o.customer_id as number);
      // "repeat" = este order não é o primeiro ever do customer
      if (first && first < o.created_at) repeatOrdersCount++;
    }
    const repeat_purchase_rate =
      ordersWithCustomer.length > 0
        ? repeatOrdersCount / ordersWithCustomer.length
        : 0;

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
      meta: { numerator: repeatOrdersCount, denominator: ordersWithCustomer.length },
    });
  }

  if (kpiRows.length === 0) {
    return { days_computed: byDay.size, kpis_upserted: 0 };
  }

  // 5. Upsert. Unique constraint trata da idempotência.
  const { error: upsertErr } = await supabase
    .from('kpi_snapshots')
    .upsert(kpiRows, {
      onConflict: 'empresa_id,channel,metric_key,period_grain,period_start',
    });
  if (upsertErr) {
    throw new Error(`upsert kpi_snapshots falhou: ${upsertErr.message}`);
  }

  return {
    days_computed: byDay.size,
    kpis_upserted: kpiRows.length,
  };
}
