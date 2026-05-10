// Lógica reutilizável de ingest de GA4 (daily metrics + channel breakdown).
// Mirror de lib/ingest/meta-ads.ts.

import {
  runReport,
  parseGA4Date,
  num,
  bigInt,
  type EmpresaWithGA4,
} from '../ga4.js';
import { supabase } from '../supabase.js';
import { synthesizeGA4 } from '../synthesize/ga4.js';

const LOOKBACK_DAYS_FIRST_RUN = 30;
const REFETCH_RECENT_DAYS = 7;

export interface EmpresaResult {
  empresa_id: string;
  empresa_name: string;
  status: 'success' | 'failed' | 'failed_pre_run';
  metric_days?: number;
  channel_rows?: number;
  kpis_upserted?: number;
  days_computed?: number;
  range?: { start: string; end: string };
  error?: string;
}

// GA4 dates: API quer 'YYYY-MM-DD' como input, devolve 'YYYYMMDD' nos rows.
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function ingestGA4Empresa(e: EmpresaWithGA4): Promise<EmpresaResult> {
  // 1. Sync empresa
  try {
    const { error } = await supabase.from('empresas').upsert({
      id: e.empresa_id,
      name: e.empresa_name,
      synced_at: new Date().toISOString(),
    });
    if (error) throw new Error(`sync empresa falhou: ${error.message}`);
  } catch (err) {
    return {
      empresa_id: e.empresa_id,
      empresa_name: e.empresa_name,
      status: 'failed_pre_run',
      error: err instanceof Error ? err.message : 'erro desconhecido',
    };
  }

  // 2. Determine incremental range
  const now = new Date();
  const rangeEnd = now.toISOString();

  const { data: lastRun, error: lastErr } = await supabase
    .from('etl_runs')
    .select('range_end')
    .eq('empresa_id', e.empresa_id)
    .eq('channel', 'ga4')
    .eq('status', 'success')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastErr) {
    return {
      empresa_id: e.empresa_id,
      empresa_name: e.empresa_name,
      status: 'failed_pre_run',
      error: `lookup last etl_run: ${lastErr.message}`,
    };
  }

  let rangeStart: string;
  if (lastRun?.range_end) {
    rangeStart = new Date(
      new Date(lastRun.range_end).getTime() - REFETCH_RECENT_DAYS * 24 * 3600 * 1000,
    ).toISOString();
  } else {
    rangeStart = new Date(
      now.getTime() - LOOKBACK_DAYS_FIRST_RUN * 24 * 3600 * 1000,
    ).toISOString();
  }

  // 3. Open etl_run
  const { data: run, error: runErr } = await supabase
    .from('etl_runs')
    .insert({
      empresa_id: e.empresa_id,
      channel: 'ga4',
      status: 'running',
      range_start: rangeStart,
      range_end: rangeEnd,
    })
    .select('id')
    .single();

  if (runErr || !run) {
    return {
      empresa_id: e.empresa_id,
      empresa_name: e.empresa_name,
      status: 'failed_pre_run',
      error: `etl_run insert: ${runErr?.message ?? 'sem id'}`,
    };
  }

  let metricDays = 0;
  let channelRows = 0;
  const creds = {
    propertyId: e.propertyId,
    clientEmail: e.clientEmail,
    privateKey: e.privateKey,
  };

  const since = isoDay(new Date(rangeStart));
  const until = isoDay(new Date(rangeEnd));

  try {
    // 4a. Daily totals — 1 row por dia
    const totalsResp = await runReport(creds, {
      dateRanges: [{ startDate: since, endDate: until }],
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'newUsers' },
        { name: 'engagedSessions' },
        { name: 'screenPageViews' },
        { name: 'conversions' },
        { name: 'purchaseRevenue' },
        { name: 'transactions' },
      ],
      limit: 10000,
    });

    if (totalsResp.rows && totalsResp.rows.length > 0) {
      const rows = [];
      for (const r of totalsResp.rows) {
        const dateStart = parseGA4Date(r.dimensionValues?.[0]?.value);
        if (!dateStart) continue;
        const m = r.metricValues ?? [];
        rows.push({
          empresa_id: e.empresa_id,
          date_start: dateStart,
          property_id: creds.propertyId,
          sessions: bigInt(m[0]?.value),
          total_users: bigInt(m[1]?.value),
          new_users: bigInt(m[2]?.value),
          engaged_sessions: bigInt(m[3]?.value),
          screen_page_views: bigInt(m[4]?.value),
          conversions: num(m[5]?.value),
          purchase_revenue: num(m[6]?.value),
          transactions: bigInt(m[7]?.value),
          payload: r,
        });
      }
      if (rows.length > 0) {
        const { error } = await supabase
          .from('ga4_metrics_raw')
          .upsert(rows, { onConflict: 'empresa_id,date_start' });
        if (error) throw new Error(`upsert ga4_metrics_raw: ${error.message}`);
        metricDays = rows.length;
      }
    }

    // 4b. Channel breakdown — 1 row por (dia, canal default GA4)
    const channelResp = await runReport(creds, {
      dateRanges: [{ startDate: since, endDate: until }],
      dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
      metrics: [
        { name: 'sessions' },
        { name: 'conversions' },
        { name: 'purchaseRevenue' },
      ],
      limit: 100000,
    });

    if (channelResp.rows && channelResp.rows.length > 0) {
      const rows = [];
      for (const r of channelResp.rows) {
        const dateStart = parseGA4Date(r.dimensionValues?.[0]?.value);
        const channelGroup = r.dimensionValues?.[1]?.value;
        if (!dateStart || !channelGroup) continue;
        const m = r.metricValues ?? [];
        rows.push({
          empresa_id: e.empresa_id,
          date_start: dateStart,
          property_id: creds.propertyId,
          channel_group: channelGroup,
          sessions: bigInt(m[0]?.value),
          conversions: num(m[1]?.value),
          purchase_revenue: num(m[2]?.value),
          payload: r,
        });
      }
      if (rows.length > 0) {
        const { error } = await supabase
          .from('ga4_channel_breakdown_raw')
          .upsert(rows, { onConflict: 'empresa_id,date_start,channel_group' });
        if (error) throw new Error(`upsert ga4_channel_breakdown_raw: ${error.message}`);
        channelRows = rows.length;
      }
    }

    // 5. Synthesize → kpi_snapshots (idempotente, janela 30d)
    const synth = await synthesizeGA4(e.empresa_id);

    // 6. Close etl_run
    await supabase
      .from('etl_runs')
      .update({
        status: 'success',
        completed_at: new Date().toISOString(),
        rows_ingested: metricDays + channelRows,
      })
      .eq('id', run.id);

    return {
      empresa_id: e.empresa_id,
      empresa_name: e.empresa_name,
      status: 'success',
      metric_days: metricDays,
      channel_rows: channelRows,
      kpis_upserted: synth.kpis_upserted,
      days_computed: synth.days_computed,
      range: { start: rangeStart, end: rangeEnd },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erro desconhecido';
    await supabase
      .from('etl_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: msg,
        rows_ingested: metricDays + channelRows,
      })
      .eq('id', run.id);
    return {
      empresa_id: e.empresa_id,
      empresa_name: e.empresa_name,
      status: 'failed',
      metric_days: metricDays,
      channel_rows: channelRows,
      range: { start: rangeStart, end: rangeEnd },
      error: msg,
    };
  }
}
