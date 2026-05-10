// Lógica reutilizável de ingest de Meta Ads (campaigns + insights diários).
// Mirror de lib/ingest/shopify.ts. Synthesize fica em PR seguinte.

import { paginateMeta, type EmpresaWithMetaAds } from '../meta-ads.js';
import { supabase } from '../supabase.js';
import { synthesizeMetaAds } from '../synthesize/meta-ads.js';

const LOOKBACK_DAYS_FIRST_RUN = 30;
const REFETCH_RECENT_DAYS = 7;

interface MetaCampaign {
  id: string;
  name?: string;
  objective?: string;
  status?: string;
  effective_status?: string;
  created_time?: string;
  updated_time?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  [k: string]: unknown;
}

interface MetaAction {
  action_type: string;
  value: string;
}

interface MetaInsight {
  campaign_id: string;
  date_start: string;
  date_stop?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  unique_clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  frequency?: string;
  actions?: MetaAction[];
  action_values?: MetaAction[];
  [k: string]: unknown;
}

export interface EmpresaResult {
  empresa_id: string;
  empresa_name: string;
  status: 'success' | 'failed' | 'failed_pre_run';
  campaigns?: number;
  insights?: number;
  kpis_upserted?: number;
  days_computed?: number;
  range?: { start: string; end: string };
  error?: string;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bigInt(v: unknown): number | null {
  const n = num(v);
  return n != null && Number.isInteger(n) ? n : n != null ? Math.round(n) : null;
}
function extractAction(actions: MetaAction[] | undefined, type: string): number | null {
  if (!actions) return null;
  const a = actions.find((x) => x.action_type === type);
  return a ? num(a.value) : null;
}

export async function ingestMetaAdsEmpresa(e: EmpresaWithMetaAds): Promise<EmpresaResult> {
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
    .eq('channel', 'meta_ads')
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
      channel: 'meta_ads',
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

  let campaignsIngested = 0;
  let insightsIngested = 0;
  const creds = { adAccountId: e.adAccountId, accessToken: e.accessToken };

  try {
    // 4a. Campaigns (todas, incluindo paused/archived — útil para análise histórica)
    const campaignFields = [
      'id', 'name', 'objective', 'status', 'effective_status',
      'created_time', 'updated_time', 'daily_budget', 'lifetime_budget',
    ].join(',');

    for await (const page of paginateMeta<MetaCampaign>(
      creds,
      `/${creds.adAccountId}/campaigns`,
      { fields: campaignFields, limit: 100 },
    )) {
      if (page.length === 0) continue;
      const rows = page.map((c) => ({
        empresa_id: e.empresa_id,
        campaign_id: c.id,
        ad_account_id: creds.adAccountId,
        name: c.name ?? null,
        objective: c.objective ?? null,
        status: c.status ?? null,
        effective_status: c.effective_status ?? null,
        created_time: c.created_time ?? null,
        updated_time: c.updated_time ?? null,
        daily_budget: num(c.daily_budget),
        lifetime_budget: num(c.lifetime_budget),
        payload: c,
      }));
      const { error } = await supabase
        .from('meta_ads_campaigns_raw')
        .upsert(rows, { onConflict: 'empresa_id,campaign_id' });
      if (error) throw new Error(`upsert campaigns: ${error.message}`);
      campaignsIngested += rows.length;
    }

    // 4b. Insights diários ao nível de campaign para o range.
    // Single endpoint call com time_increment=1 + level=campaign devolve
    // 1 row por campanha por dia. Mais eficiente do que iterar campanhas.
    const insightFields = [
      'campaign_id', 'date_start', 'date_stop',
      'spend', 'impressions', 'reach', 'clicks', 'unique_clicks',
      'ctr', 'cpc', 'cpm', 'frequency',
      'actions', 'action_values',
    ].join(',');

    const since = rangeStart.slice(0, 10);
    const until = rangeEnd.slice(0, 10);

    for await (const page of paginateMeta<MetaInsight>(
      creds,
      `/${creds.adAccountId}/insights`,
      {
        fields: insightFields,
        time_increment: 1,
        time_range: JSON.stringify({ since, until }),
        level: 'campaign',
        limit: 1000,
      },
    )) {
      if (page.length === 0) continue;
      const rows = page.map((i) => ({
        empresa_id: e.empresa_id,
        campaign_id: i.campaign_id,
        ad_account_id: creds.adAccountId,
        date_start: i.date_start,
        spend: num(i.spend),
        impressions: bigInt(i.impressions),
        reach: bigInt(i.reach),
        clicks: bigInt(i.clicks),
        unique_clicks: bigInt(i.unique_clicks),
        ctr: num(i.ctr),
        cpc: num(i.cpc),
        cpm: num(i.cpm),
        frequency: num(i.frequency),
        purchases: bigInt(extractAction(i.actions, 'purchase')),
        purchases_value: extractAction(i.action_values, 'purchase'),
        add_to_carts: bigInt(extractAction(i.actions, 'add_to_cart')),
        initiated_checkouts: bigInt(extractAction(i.actions, 'initiate_checkout')),
        payload: i,
      }));
      const { error } = await supabase
        .from('meta_ads_insights_raw')
        .upsert(rows, { onConflict: 'empresa_id,campaign_id,date_start' });
      if (error) throw new Error(`upsert insights: ${error.message}`);
      insightsIngested += rows.length;
    }

    // 5. Synthesize — lê meta_ads_insights_raw, computa KPIs, upsert kpi_snapshots.
    // Janela própria 30d, recomputa todo o histórico relevante (idempotente).
    const synth = await synthesizeMetaAds(e.empresa_id);

    // 6. Close etl_run
    await supabase
      .from('etl_runs')
      .update({
        status: 'success',
        completed_at: new Date().toISOString(),
        rows_ingested: campaignsIngested + insightsIngested,
      })
      .eq('id', run.id);

    return {
      empresa_id: e.empresa_id,
      empresa_name: e.empresa_name,
      status: 'success',
      campaigns: campaignsIngested,
      insights: insightsIngested,
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
        rows_ingested: campaignsIngested + insightsIngested,
      })
      .eq('id', run.id);
    return {
      empresa_id: e.empresa_id,
      empresa_name: e.empresa_name,
      status: 'failed',
      campaigns: campaignsIngested,
      insights: insightsIngested,
      range: { start: rangeStart, end: rangeEnd },
      error: msg,
    };
  }
}
