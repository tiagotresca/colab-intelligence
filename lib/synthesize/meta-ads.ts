// Synthesize layer — Meta Ads.
//
// Lê meta_ads_insights_raw e produz KPIs base diários em
// kpi_snapshots. Mantemos só BASE METRICS (sums) — ratios como CTR,
// CPC, ROAS são computados on-the-fly na agregação 30d para evitar
// o erro clássico de "média de daily ratios" (que não bate com
// sum(numerator)/sum(denominator)).
//
// 5 KPIs base por dia:
//   spend_day, impressions_day, clicks_day, purchases_day, purchases_value_day
//
// Cross-channel KPIs (CAC, ROAS verdadeiro) ficam em get_business_health
// (api/mcp.ts) onde temos acesso simultâneo a Shopify e Meta.

import { supabase } from '../supabase.js';
import type { Channel, PeriodGrain } from '../types.js';

const CHANNEL: Channel = 'meta_ads';
const GRAIN: PeriodGrain = 'day';
const DEFAULT_LOOKBACK_DAYS = 30;

interface InsightRow {
  campaign_id: string;
  date_start: string; // YYYY-MM-DD
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  purchases: number | null;
  purchases_value: number | null;
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

export async function synthesizeMetaAds(
  empresa_id: string,
  options: SynthesizeOptions = {},
): Promise<SynthesizeResult> {
  const lookback = options.lookback_days ?? DEFAULT_LOOKBACK_DAYS;
  const now = new Date();
  const rangeEnd = now.toISOString();
  const rangeStart = new Date(
    now.getTime() - lookback * 24 * 3600 * 1000,
  ).toISOString();

  const sinceDate = rangeStart.slice(0, 10);
  const untilDate = rangeEnd.slice(0, 10);

  const { data: insightsData, error: insightsErr } = await supabase
    .from('meta_ads_insights_raw')
    .select('campaign_id, date_start, spend, impressions, clicks, purchases, purchases_value')
    .eq('empresa_id', empresa_id)
    .gte('date_start', sinceDate)
    .lte('date_start', untilDate)
    .limit(50000);

  if (insightsErr) {
    throw new Error(`synthesize Meta fetch insights: ${insightsErr.message}`);
  }
  const insights = (insightsData ?? []) as InsightRow[];

  if (insights.length === 0) {
    return {
      days_computed: 0,
      kpis_upserted: 0,
      range: { start: rangeStart, end: rangeEnd },
    };
  }

  // Agrupar por dia e somar across campanhas.
  const byDay = new Map<string, {
    spend: number; impressions: number; clicks: number;
    purchases: number; purchases_value: number;
  }>();
  for (const i of insights) {
    const day = i.date_start;
    const bucket = byDay.get(day) ?? {
      spend: 0, impressions: 0, clicks: 0, purchases: 0, purchases_value: 0,
    };
    bucket.spend += Number(i.spend) || 0;
    bucket.impressions += Number(i.impressions) || 0;
    bucket.clicks += Number(i.clicks) || 0;
    bucket.purchases += Number(i.purchases) || 0;
    bucket.purchases_value += Number(i.purchases_value) || 0;
    byDay.set(day, bucket);
  }

  const kpiRows: KpiRow[] = [];
  for (const [day, totals] of byDay) {
    const periodStart = `${day}T00:00:00.000Z`;
    const baseFields = {
      empresa_id,
      channel: CHANNEL,
      period_grain: GRAIN,
      period_start: periodStart,
      meta: null as Record<string, unknown> | null,
    };
    kpiRows.push({ ...baseFields, metric_key: 'spend_day', value: totals.spend });
    kpiRows.push({ ...baseFields, metric_key: 'impressions_day', value: totals.impressions });
    kpiRows.push({ ...baseFields, metric_key: 'clicks_day', value: totals.clicks });
    kpiRows.push({ ...baseFields, metric_key: 'purchases_day', value: totals.purchases });
    kpiRows.push({ ...baseFields, metric_key: 'purchases_value_day', value: totals.purchases_value });
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
    throw new Error(`upsert kpi_snapshots (meta): ${upsertErr.message}`);
  }

  return {
    days_computed: byDay.size,
    kpis_upserted: kpiRows.length,
    range: { start: rangeStart, end: rangeEnd },
  };
}
