// Synthesize layer — GA4.
//
// Lê ga4_metrics_raw + ga4_channel_breakdown_raw e produz KPIs base
// diários em kpi_snapshots. Mantemos só BASE METRICS (sums) — ratios
// como engagement_rate ficam computados on-the-fly em get_business_health
// como sum(numerator)/sum(denominator).
//
// 7 KPIs base por dia:
//   sessions_day, users_day, new_users_day, engaged_sessions_day,
//   page_views_day, conversions_day, revenue_day, transactions_day
//
// Channel breakdown (Direct, Organic Search, Paid Social, ...) fica
// como kpi separado: sessions_<channel>_day. Permite ao agente
// detectar gaps (e.g. Meta diz X clicks, GA4 mostra Y sessões Paid Social).

import { supabase } from '../supabase.js';
import type { Channel, PeriodGrain } from '../types.js';
import { assertNoLimitHit } from '../util/limits.js';

const CHANNEL: Channel = 'ga4';
const GRAIN: PeriodGrain = 'day';
const DEFAULT_LOOKBACK_DAYS = 30;

interface MetricsRow {
  date_start: string; // YYYY-MM-DD
  sessions: number | null;
  total_users: number | null;
  new_users: number | null;
  engaged_sessions: number | null;
  screen_page_views: number | null;
  conversions: number | null;
  purchase_revenue: number | null;
  transactions: number | null;
}

interface ChannelRow {
  date_start: string;
  channel_group: string;
  sessions: number | null;
  conversions: number | null;
  purchase_revenue: number | null;
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

// metric_key seguro para channel-breakdown: lower-case + spaces→underscore.
// "Organic Search" → "organic_search". Mantém estabilidade entre runs.
function channelKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

export async function synthesizeGA4(
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

  // 1. Daily totals
  const { data: metricsData, error: metricsErr } = await supabase
    .from('ga4_metrics_raw')
    .select(
      'date_start, sessions, total_users, new_users, engaged_sessions, screen_page_views, conversions, purchase_revenue, transactions',
    )
    .eq('empresa_id', empresa_id)
    .gte('date_start', sinceDate)
    .lte('date_start', untilDate)
    .limit(50000);

  if (metricsErr) {
    throw new Error(`synthesize GA4 fetch metrics: ${metricsErr.message}`);
  }
  assertNoLimitHit(metricsData, 50000, `ga4 synthesize metrics ${empresa_id} ${sinceDate}..${untilDate}`);
  const metrics = (metricsData ?? []) as MetricsRow[];

  // 2. Channel breakdown (último valor para cada (date, channel) — já é unique pk)
  const { data: channelData, error: channelErr } = await supabase
    .from('ga4_channel_breakdown_raw')
    .select('date_start, channel_group, sessions, conversions, purchase_revenue')
    .eq('empresa_id', empresa_id)
    .gte('date_start', sinceDate)
    .lte('date_start', untilDate)
    .limit(50000);

  if (channelErr) {
    throw new Error(`synthesize GA4 fetch channels: ${channelErr.message}`);
  }
  assertNoLimitHit(channelData, 50000, `ga4 synthesize channels ${empresa_id} ${sinceDate}..${untilDate}`);
  const channels = (channelData ?? []) as ChannelRow[];

  if (metrics.length === 0 && channels.length === 0) {
    return {
      days_computed: 0,
      kpis_upserted: 0,
      range: { start: rangeStart, end: rangeEnd },
    };
  }

  const kpiRows: KpiRow[] = [];
  const days = new Set<string>();

  for (const m of metrics) {
    const day = m.date_start;
    days.add(day);
    const periodStart = `${day}T00:00:00.000Z`;
    const baseFields = {
      empresa_id,
      channel: CHANNEL,
      period_grain: GRAIN,
      period_start: periodStart,
      meta: null as Record<string, unknown> | null,
    };
    kpiRows.push({ ...baseFields, metric_key: 'sessions_day', value: m.sessions });
    kpiRows.push({ ...baseFields, metric_key: 'users_day', value: m.total_users });
    kpiRows.push({ ...baseFields, metric_key: 'new_users_day', value: m.new_users });
    kpiRows.push({
      ...baseFields,
      metric_key: 'engaged_sessions_day',
      value: m.engaged_sessions,
      // Numerator/denominator para weighted ratio (engagement rate) em get_business_health.
      meta: m.sessions != null && m.engaged_sessions != null
        ? { numerator: m.engaged_sessions, denominator: m.sessions }
        : null,
    });
    kpiRows.push({ ...baseFields, metric_key: 'page_views_day', value: m.screen_page_views });
    kpiRows.push({ ...baseFields, metric_key: 'conversions_day', value: m.conversions });
    kpiRows.push({ ...baseFields, metric_key: 'revenue_day', value: m.purchase_revenue });
    kpiRows.push({ ...baseFields, metric_key: 'transactions_day', value: m.transactions });
  }

  // Channel breakdown — agrega por (day, channelKey). Em teoria a raw
  // table já é unique nessa chave, mas ficamos defensivos.
  const channelByDayKey = new Map<string, { sessions: number; conversions: number; revenue: number; original: string }>();
  for (const c of channels) {
    days.add(c.date_start);
    const key = channelKey(c.channel_group);
    const composite = `${c.date_start}|${key}`;
    const bucket = channelByDayKey.get(composite) ?? {
      sessions: 0,
      conversions: 0,
      revenue: 0,
      original: c.channel_group,
    };
    bucket.sessions += Number(c.sessions) || 0;
    bucket.conversions += Number(c.conversions) || 0;
    bucket.revenue += Number(c.purchase_revenue) || 0;
    channelByDayKey.set(composite, bucket);
  }
  for (const [composite, totals] of channelByDayKey) {
    const [day, key] = composite.split('|');
    if (!day || !key) continue;
    const periodStart = `${day}T00:00:00.000Z`;
    const baseFields = {
      empresa_id,
      channel: CHANNEL,
      period_grain: GRAIN,
      period_start: periodStart,
    };
    kpiRows.push({
      ...baseFields,
      metric_key: `sessions_${key}_day`,
      value: totals.sessions,
      meta: { channel_group: totals.original },
    });
    if (totals.conversions !== 0) {
      kpiRows.push({
        ...baseFields,
        metric_key: `conversions_${key}_day`,
        value: totals.conversions,
        meta: { channel_group: totals.original },
      });
    }
    if (totals.revenue !== 0) {
      kpiRows.push({
        ...baseFields,
        metric_key: `revenue_${key}_day`,
        value: totals.revenue,
        meta: { channel_group: totals.original },
      });
    }
  }

  if (kpiRows.length === 0) {
    return {
      days_computed: days.size,
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
    throw new Error(`upsert kpi_snapshots (ga4): ${upsertErr.message}`);
  }

  return {
    days_computed: days.size,
    kpis_upserted: kpiRows.length,
    range: { start: rangeStart, end: rangeEnd },
  };
}
