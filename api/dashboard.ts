// Dashboard interno (Phase 1 — debug/iteration UI).
//
// Renderiza HTML server-side com:
//  - Cards de KPIs (revenue/orders/AOV/new customers/repeat rate)
//  - Sparkline SVG de revenue diário (30d)
//  - Últimas etl_runs (status, duração, rows, errors)
//  - Raw counts (orders, customers)
//  - JSON pretty do get_business_health
//  - Botão "Trigger ingest" → POST recorre o pipeline
//
// Auth: Vercel deployment protection (SSO) wrappa a página.
// Não há check próprio — qualquer um que chegue aqui já passou Vercel SSO.
//
// Fica em colab-intelligence até a integração no work.colab estar
// madura. Não exposto via MCP — UI humano, não consumível por agentes.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../lib/supabase.js';
import { listEmpresasWithShopify } from '../lib/shopify.js';
import { ingestShopifyEmpresa } from '../lib/ingest/shopify.js';
import { listEmpresasWithMetaAds } from '../lib/meta-ads.js';
import { ingestMetaAdsEmpresa } from '../lib/ingest/meta-ads.js';
import { importOrders } from '../lib/import/orders-importer.js';
import {
  synthesizeCustomersShopify,
  synthesizeCustomersFromManual,
} from '../lib/synthesize/customers.js';

interface EmpresaRow {
  id: string;
  name: string;
}
interface KpiRow {
  channel: string;
  metric_key: string;
  period_start: string;
  value: number | null;
  meta: Record<string, unknown> | null;
}
interface EtlRunRow {
  id: string;
  channel: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  rows_ingested: number | null;
  range_start: string | null;
  range_end: string | null;
  error_message: string | null;
}

interface CustomersByPlatform {
  platform: string;
  count: number;
  total_revenue: number;
}

interface CustomersByConfidence {
  confidence: string | null;
  count: number;
}

interface CustomersBySource {
  source: string | null;
  count: number;
  total_revenue: number;
}

interface ImportRunRow {
  source_platform: string;
  format: string;
  filename: string | null;
  rows_processed: number | null;
  rows_imported: number | null;
  rows_skipped: number | null;
  status: string;
  started_at: string;
  completed_at: string | null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'POST') {
    const action = (req.query.action as string | undefined) ?? 'trigger-ingest';
    if (action === 'import-orders') return handleImport(req, res);
    return handleTrigger(req, res);
  }

  // GET — render
  const selectedEmpresaId = (req.query.empresa as string | undefined)?.trim();
  const justTriggered = req.query.triggered === '1';
  const justImported = req.query.imported === '1';

  const { data: empresasData, error: empresasErr } = await supabase
    .from('empresas')
    .select('id, name')
    .order('name');
  if (empresasErr) {
    res.status(500).send(`Erro: ${empresasErr.message}`);
    return;
  }
  const empresas = (empresasData ?? []) as EmpresaRow[];

  const empresa =
    empresas.find((e) => e.id === selectedEmpresaId) ?? empresas[0];

  let kpis: KpiRow[] = [];
  let runs: EtlRunRow[] = [];
  let ordersCount = 0;
  let customersCount = 0;
  let metaCampaignsCount = 0;
  let metaInsightsCount = 0;
  let manualOrdersCount = 0;
  let customersByPlatform: CustomersByPlatform[] = [];
  let customersByConfidence: CustomersByConfidence[] = [];
  let topSources: CustomersBySource[] = [];
  let recentImports: ImportRunRow[] = [];
  let healthJson: unknown = null;

  if (empresa) {
    const periodEnd = new Date().toISOString();
    const periodStart = new Date(
      Date.now() - 30 * 24 * 3600 * 1000,
    ).toISOString();

    const [
      kpiQ, runsQ, ordersQ, customersQ, metaCampQ, metaInsightsQ,
      manualOrdersQ, customersAllQ, importRunsQ,
    ] = await Promise.all([
      supabase
        .from('kpi_snapshots')
        .select('channel, metric_key, period_start, value, meta')
        .eq('empresa_id', empresa.id)
        .eq('period_grain', 'day')
        .gte('period_start', periodStart)
        .lte('period_start', periodEnd)
        .order('period_start', { ascending: true }),
      supabase
        .from('etl_runs')
        .select('id, channel, status, started_at, completed_at, rows_ingested, range_start, range_end, error_message')
        .eq('empresa_id', empresa.id)
        .order('started_at', { ascending: false })
        .limit(10),
      supabase
        .from('shopify_orders_raw')
        .select('shopify_order_id', { count: 'exact', head: true })
        .eq('empresa_id', empresa.id),
      supabase
        .from('shopify_customers_raw')
        .select('shopify_customer_id', { count: 'exact', head: true })
        .eq('empresa_id', empresa.id),
      supabase
        .from('meta_ads_campaigns_raw')
        .select('campaign_id', { count: 'exact', head: true })
        .eq('empresa_id', empresa.id),
      supabase
        .from('meta_ads_insights_raw')
        .select('campaign_id', { count: 'exact', head: true })
        .eq('empresa_id', empresa.id),
      supabase
        .from('manual_orders_raw')
        .select('external_order_id', { count: 'exact', head: true })
        .eq('empresa_id', empresa.id),
      supabase
        .from('customers')
        .select('platform, total_revenue, acquisition_source, acquisition_first_touch_confidence')
        .eq('empresa_id', empresa.id)
        .limit(50000),
      supabase
        .from('import_runs')
        .select('source_platform, format, filename, rows_processed, rows_imported, rows_skipped, status, started_at, completed_at')
        .eq('empresa_id', empresa.id)
        .order('started_at', { ascending: false })
        .limit(5),
    ]);

    kpis = (kpiQ.data ?? []) as KpiRow[];
    runs = (runsQ.data ?? []) as EtlRunRow[];
    ordersCount = ordersQ.count ?? 0;
    customersCount = customersQ.count ?? 0;
    metaCampaignsCount = metaCampQ.count ?? 0;
    metaInsightsCount = metaInsightsQ.count ?? 0;
    manualOrdersCount = manualOrdersQ.count ?? 0;
    recentImports = (importRunsQ.data ?? []) as ImportRunRow[];

    // Aggregate customers data in JS (small N)
    interface CustomerRowLite {
      platform: string;
      total_revenue: number | null;
      acquisition_source: string | null;
      acquisition_first_touch_confidence: string | null;
    }
    const allCustomers = (customersAllQ.data ?? []) as CustomerRowLite[];

    const byPlatform = new Map<string, { count: number; total_revenue: number }>();
    const byConfidence = new Map<string | null, number>();
    const bySource = new Map<string | null, { count: number; total_revenue: number }>();

    for (const c of allCustomers) {
      const rev = Number(c.total_revenue) || 0;

      const p = byPlatform.get(c.platform) ?? { count: 0, total_revenue: 0 };
      p.count++;
      p.total_revenue += rev;
      byPlatform.set(c.platform, p);

      byConfidence.set(
        c.acquisition_first_touch_confidence,
        (byConfidence.get(c.acquisition_first_touch_confidence) ?? 0) + 1,
      );

      const s = bySource.get(c.acquisition_source) ?? { count: 0, total_revenue: 0 };
      s.count++;
      s.total_revenue += rev;
      bySource.set(c.acquisition_source, s);
    }

    customersByPlatform = Array.from(byPlatform.entries())
      .map(([platform, v]) => ({ platform, count: v.count, total_revenue: v.total_revenue }))
      .sort((a, b) => b.count - a.count);

    customersByConfidence = Array.from(byConfidence.entries())
      .map(([confidence, count]) => ({ confidence, count }))
      .sort((a, b) => b.count - a.count);

    topSources = Array.from(bySource.entries())
      .map(([source, v]) => ({ source, count: v.count, total_revenue: v.total_revenue }))
      .sort((a, b) => b.total_revenue - a.total_revenue)
      .slice(0, 10);

    // Inline call ao MCP get_business_health (mesmo lookup que faz por
    // dentro). Mais simples re-chamar via fetch interno do que duplicar
    // lógica — mas para evitar HTTP overhead, replicamos a query aqui.
    healthJson = await computeBusinessHealth(empresa);
  }

  const html = renderDashboard({
    empresas,
    selected: empresa,
    kpis,
    runs,
    ordersCount,
    customersCount,
    metaCampaignsCount,
    metaInsightsCount,
    manualOrdersCount,
    customersByPlatform,
    customersByConfidence,
    topSources,
    recentImports,
    healthJson,
    justTriggered,
    justImported,
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(html);
}

async function handleTrigger(req: VercelRequest, res: VercelResponse) {
  try {
    let totalResults = 0;

    // Shopify
    const shopifyEmpresas = await listEmpresasWithShopify();
    for (const e of shopifyEmpresas) {
      await ingestShopifyEmpresa(e);
      totalResults++;
    }

    // Meta Ads
    const metaEmpresas = await listEmpresasWithMetaAds();
    for (const e of metaEmpresas) {
      await ingestMetaAdsEmpresa(e);
      totalResults++;
    }

    // Redirect back to GET para refrescar a UI
    const empresa = (req.query.empresa as string | undefined) ?? '';
    const back = empresa
      ? `/dashboard?empresa=${empresa}&triggered=1`
      : `/dashboard?triggered=1`;
    res.setHeader('Location', back);
    res.status(303).send(`Triggered ${totalResults} ingests. Redirecting...`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erro desconhecido';
    res.status(500).send(`Trigger failed: ${msg}`);
  }
}

// ---- Manual import handler -------------------------------------------------

interface ImportRequestBody {
  empresa_id?: string;
  source_platform?: string;
  format?: 'shopify_csv' | 'standard_v1';
  filename?: string;
  csv_content?: string;
}

async function handleImport(req: VercelRequest, res: VercelResponse) {
  const body = (req.body ?? {}) as ImportRequestBody;
  const empresa_id = body.empresa_id?.trim();
  const source_platform = body.source_platform?.trim();
  const format = body.format;
  const csv_content = body.csv_content;

  if (!empresa_id || !source_platform || !format || !csv_content) {
    res.status(400).json({
      ok: false,
      error: 'missing fields: empresa_id, source_platform, format, csv_content',
    });
    return;
  }
  if (format !== 'shopify_csv' && format !== 'standard_v1') {
    res.status(400).json({ ok: false, error: 'invalid format' });
    return;
  }

  try {
    const result = await importOrders({
      empresa_id,
      source_platform,
      format,
      filename: body.filename ?? null,
      csv_content,
    });

    // Trigger customers re-synth for the affected platform
    let synthResult;
    try {
      if (source_platform === 'shopify_export') {
        synthResult = await synthesizeCustomersShopify(empresa_id);
      } else {
        synthResult = await synthesizeCustomersFromManual(empresa_id, source_platform);
      }
    } catch (err) {
      // Import succeeded; flag synth failure separately
      synthResult = {
        error: err instanceof Error ? err.message : 'synth failed',
      };
    }

    res.status(200).json({
      ok: true,
      import: result,
      customers_synth: synthResult,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erro desconhecido';
    res.status(500).json({ ok: false, error: msg });
  }
}

// ---- Business health (replica simplificada do MCP tool) ---------------------

async function computeBusinessHealth(empresa: EmpresaRow) {
  const periodEnd = new Date().toISOString();
  const periodStart = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const { data } = await supabase
    .from('kpi_snapshots')
    .select('metric_key, value, meta')
    .eq('empresa_id', empresa.id)
    .eq('period_grain', 'day')
    .gte('period_start', periodStart)
    .lte('period_start', periodEnd);

  const byMetric = new Map<string, Array<{ value: number; meta: Record<string, unknown> | null }>>();
  for (const r of (data ?? []) as Array<{ metric_key: string; value: number | null; meta: Record<string, unknown> | null }>) {
    const arr = byMetric.get(r.metric_key) ?? [];
    arr.push({ value: Number(r.value) || 0, meta: r.meta });
    byMetric.set(r.metric_key, arr);
  }
  const sumOf = (k: string) => {
    const a = byMetric.get(k);
    return a && a.length ? a.reduce((s, r) => s + r.value, 0) : null;
  };
  const avgOf = (k: string) => {
    const a = byMetric.get(k);
    return a && a.length ? a.reduce((s, r) => s + r.value, 0) / a.length : null;
  };
  const revenue = sumOf('revenue_day');
  const orders = sumOf('orders_count_day');
  return {
    empresa: { id: empresa.id, name: empresa.name },
    period: { start: periodStart, end: periodEnd },
    revenue_30d: revenue,
    orders_30d: orders,
    aov_30d: revenue != null && orders ? revenue / orders : null,
    new_customers_30d: sumOf('new_customers_day'),
    repeat_purchase_rate_30d: avgOf('repeat_purchase_rate_day'),
    currency: byMetric.get('revenue_day')?.[0]?.meta?.currency ?? null,
  };
}

// ---- Render helpers ---------------------------------------------------------

interface RenderArgs {
  empresas: EmpresaRow[];
  selected: EmpresaRow | undefined;
  kpis: KpiRow[];
  runs: EtlRunRow[];
  ordersCount: number;
  customersCount: number;
  metaCampaignsCount: number;
  metaInsightsCount: number;
  manualOrdersCount: number;
  customersByPlatform: CustomersByPlatform[];
  customersByConfidence: CustomersByConfidence[];
  topSources: CustomersBySource[];
  recentImports: ImportRunRow[];
  healthJson: unknown;
  justTriggered: boolean;
  justImported: boolean;
}

function renderDashboard(args: RenderArgs): string {
  const {
    empresas, selected, kpis, runs,
    ordersCount, customersCount, metaCampaignsCount, metaInsightsCount, manualOrdersCount,
    customersByPlatform, customersByConfidence, topSources, recentImports,
    healthJson, justTriggered, justImported,
  } = args;

  const dailyRevenue = kpis.filter((k) => k.channel === 'shopify' && k.metric_key === 'revenue_day');
  const dailyMetaSpend = kpis.filter((k) => k.channel === 'meta_ads' && k.metric_key === 'spend_day');
  const currency =
    (kpis.find((k) => k.channel === 'shopify' && k.meta?.currency)?.meta?.currency as string | undefined) ?? '';

  const sumOf = (channel: string, key: string): number | null => {
    const rows = kpis.filter((k) => k.channel === channel && k.metric_key === key);
    if (rows.length === 0) return null;
    return rows.reduce((s, r) => s + (Number(r.value) || 0), 0);
  };
  const avgOf = (channel: string, key: string): number | null => {
    const rows = kpis.filter((k) => k.channel === channel && k.metric_key === key);
    if (rows.length === 0) return null;
    return rows.reduce((s, r) => s + (Number(r.value) || 0), 0) / rows.length;
  };

  // Shopify
  const revenue30d = sumOf('shopify', 'revenue_day');
  const orders30d = sumOf('shopify', 'orders_count_day');
  const newCust30d = sumOf('shopify', 'new_customers_day');
  const repeat30d = avgOf('shopify', 'repeat_purchase_rate_day');
  const aov30d = revenue30d != null && orders30d ? revenue30d / orders30d : null;

  // Meta Ads
  const metaSpend30d = sumOf('meta_ads', 'spend_day');
  const metaImpressions30d = sumOf('meta_ads', 'impressions_day');
  const metaClicks30d = sumOf('meta_ads', 'clicks_day');
  const metaPurchases30d = sumOf('meta_ads', 'purchases_day');
  const metaCtr30d = metaClicks30d != null && metaImpressions30d && metaImpressions30d > 0
    ? metaClicks30d / metaImpressions30d : null;
  const metaCpc30d = metaSpend30d != null && metaClicks30d && metaClicks30d > 0
    ? metaSpend30d / metaClicks30d : null;

  // Cross-channel (só preenche quando ambos estão presentes)
  const cac30d = metaSpend30d != null && newCust30d && newCust30d > 0 ? metaSpend30d / newCust30d : null;
  const roas30d = revenue30d != null && metaSpend30d && metaSpend30d > 0 ? revenue30d / metaSpend30d : null;

  const hasShopify = revenue30d != null || orders30d != null;
  const hasMeta = metaSpend30d != null;

  const sym = currency === 'EUR' ? '€' : currency === 'USD' ? '$' : currency ? `${currency} ` : '';
  const fmtMoney = (v: number | null) =>
    v == null ? '—' : `${sym}${Math.round(v).toLocaleString('pt-PT')}`;
  const fmtPct = (v: number | null) =>
    v == null ? '—' : `${(v * 100).toFixed(0)}%`;
  const fmtInt = (v: number | null) => (v == null ? '—' : v.toLocaleString('pt-PT'));

  const empresaOpts = empresas
    .map(
      (e) =>
        `<option value="${e.id}" ${selected && e.id === selected.id ? 'selected' : ''}>${escapeHtml(e.name)}</option>`,
    )
    .join('');

  const runsRows = runs.length === 0
    ? `<tr><td colspan="6" class="muted">Sem etl_runs ainda.</td></tr>`
    : runs
        .map((r) => {
          const dur =
            r.completed_at && r.started_at
              ? `${Math.round((new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 1000)}s`
              : '—';
          const ago = timeAgo(new Date(r.started_at));
          const statusClass = r.status === 'success' ? 'ok' : r.status === 'failed' ? 'err' : 'warn';
          return `<tr>
            <td title="${r.started_at}">${ago}</td>
            <td>${escapeHtml(r.channel)}</td>
            <td><span class="status ${statusClass}">${r.status}</span></td>
            <td>${dur}</td>
            <td>${fmtInt(r.rows_ingested)}</td>
            <td class="err-msg">${r.error_message ? escapeHtml(r.error_message.slice(0, 120)) : '—'}</td>
          </tr>`;
        })
        .join('');

  const healthPretty = JSON.stringify(healthJson, null, 2);

  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="utf-8">
<title>colab-intelligence — dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; }
  body {
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0d1117; color: #e6edf3;
    margin: 0; padding: 24px;
  }
  h1, h2 { font-weight: 600; margin: 0 0 16px; }
  h1 { font-size: 18px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  h1 .meta { color: #7d8590; font-size: 12px; font-weight: 400; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: #7d8590; margin-top: 32px; }
  select, button, input {
    background: #21262d; color: #e6edf3; border: 1px solid #30363d;
    padding: 6px 12px; font: inherit; border-radius: 6px;
  }
  button { cursor: pointer; }
  button.primary { background: #238636; border-color: #2ea043; color: white; }
  button.primary:hover { background: #2ea043; }
  .controls { display: flex; gap: 12px; align-items: center; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #30363d; padding: 16px; border-radius: 8px; }
  .card .label { color: #7d8590; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
  .card .value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .sparkline-wrap { background: #161b22; border: 1px solid #30363d; padding: 16px; border-radius: 8px; margin-bottom: 24px; }
  .sparkline-wrap .label { color: #7d8590; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #21262d; font-variant-numeric: tabular-nums; }
  th { color: #7d8590; font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
  td.err-msg { color: #f85149; font-size: 12px; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; text-transform: uppercase; font-weight: 600; }
  .status.ok { background: #033a16; color: #56d364; }
  .status.warn { background: #4d2d00; color: #e3b341; }
  .status.err { background: #4c1014; color: #f85149; }
  .muted { color: #7d8590; }
  .raw-counts { display: flex; gap: 24px; padding: 16px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; }
  .raw-counts .item { display: flex; flex-direction: column; gap: 4px; }
  .raw-counts .label { color: #7d8590; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .raw-counts .value { font-size: 18px; font-variant-numeric: tabular-nums; font-weight: 600; }
  details { background: #161b22; border: 1px solid #30363d; padding: 16px; border-radius: 8px; }
  summary { cursor: pointer; color: #7d8590; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  pre { background: #0d1117; padding: 16px; border-radius: 6px; overflow: auto; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; margin: 12px 0 0; }
  .toast { background: #033a16; border: 1px solid #2ea043; color: #56d364; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; }
  .import-wrap { background: #161b22; border: 1px solid #30363d; padding: 12px 16px; border-radius: 8px; margin-bottom: 24px; }
  .import-controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .import-label { color: #7d8590; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  .btn-secondary { background: #21262d; color: #e6edf3; border: 1px solid #30363d; padding: 6px 12px; font: inherit; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .btn-secondary:hover { background: #30363d; }
  .import-status { font-size: 12px; color: #7d8590; margin-left: auto; }
  .import-status.pending { color: #e3b341; }
  .import-status.success { color: #56d364; }
  .import-status.error { color: #f85149; }
  .card-sub { color: #7d8590; font-size: 11px; margin-top: 4px; }
  .sub-h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #7d8590; margin: 16px 0 8px; font-weight: 600; }
</style>
</head>
<body>
<h1>
  colab-intelligence
  <span class="meta">${new Date().toLocaleString('pt-PT')}</span>
</h1>

${justTriggered ? '<div class="toast">✓ Ingest disparado. Resultados refrescados em baixo.</div>' : ''}
${justImported ? '<div class="toast">✓ Import concluído. Customers re-sintetizados.</div>' : ''}
${selected ? '' : '<p class="muted">Sem empresas ingeridas ainda. Carrega em "Trigger ingest" para correr o primeiro ETL.</p>'}

<form method="get" action="/dashboard" class="controls" style="margin-bottom: 12px;">
  <label>Empresa:</label>
  <select name="empresa" onchange="this.form.submit()">${empresaOpts || '<option>(nenhuma)</option>'}</select>
  <span style="flex: 1;"></span>
  <button class="primary" type="submit" formmethod="post" formaction="/dashboard${selected ? `?action=trigger-ingest&empresa=${selected.id}` : '?action=trigger-ingest'}">▶ Trigger ingest</button>
</form>

${selected ? `
<div class="import-wrap" id="import-wrap">
  <div class="import-controls">
    <label class="import-label">Manual import:</label>
    <button class="btn-secondary" type="button" onclick="document.getElementById('csv-input-shopify').click()">⬆ Shopify export (CSV)</button>
    <button class="btn-secondary" type="button" onclick="promptCustomImport()">⬆ Custom site CSV</button>
    <input type="file" id="csv-input-shopify" accept=".csv,text/csv" hidden>
    <input type="file" id="csv-input-custom" accept=".csv,text/csv" hidden>
    <span id="import-status" class="import-status"></span>
  </div>
</div>
<script>
(function() {
  const empresaId = ${JSON.stringify(selected.id)};
  const status = document.getElementById('import-status');

  function setStatus(msg, kind) {
    status.textContent = msg;
    status.className = 'import-status' + (kind ? ' ' + kind : '');
  }

  async function uploadCsv(file, sourcePlatform, format) {
    if (!file) return;
    setStatus('A ler ' + file.name + ' (' + (file.size / 1024).toFixed(0) + ' KB)…', 'pending');
    try {
      const csv = await file.text();
      setStatus('A enviar e processar… (pode demorar para CSVs grandes)', 'pending');
      const r = await fetch('/api/dashboard?action=import-orders&empresa=' + encodeURIComponent(empresaId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          empresa_id: empresaId,
          source_platform: sourcePlatform,
          format: format,
          filename: file.name,
          csv_content: csv,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        const err = (j && j.error) || ('HTTP ' + r.status);
        setStatus('✗ Falhou: ' + err, 'error');
        return;
      }
      const imp = j.import;
      const synth = j.customers_synth;
      const synthMsg = synth && synth.customers_synthesized != null
        ? (synth.customers_synthesized + ' customers')
        : 'sem synth';
      setStatus('✓ ' + imp.rows_imported + '/' + imp.rows_processed + ' orders importados (' + imp.rows_skipped + ' skipped). ' + synthMsg + '. A refrescar…', 'success');
      setTimeout(function() {
        location.href = '/dashboard?empresa=' + encodeURIComponent(empresaId) + '&imported=1';
      }, 1500);
    } catch (err) {
      setStatus('✗ Falhou: ' + (err.message || err), 'error');
    }
  }

  document.getElementById('csv-input-shopify').addEventListener('change', function(e) {
    if (!e.target.files[0]) return;
    uploadCsv(e.target.files[0], 'shopify_export', 'shopify_csv');
    e.target.value = '';
  });

  document.getElementById('csv-input-custom').addEventListener('change', function(e) {
    if (!e.target.files[0]) return;
    const sp = window._customSourcePlatform;
    if (!sp) return;
    uploadCsv(e.target.files[0], sp, 'standard_v1');
    e.target.value = '';
  });

  window.promptCustomImport = function() {
    const sp = prompt('Source platform (ex: aquinta_custom, lukydog_custom):', 'aquinta_custom');
    if (!sp) return;
    window._customSourcePlatform = sp.trim();
    document.getElementById('csv-input-custom').click();
  };
})();
</script>
` : ''}

${selected ? `
${hasShopify ? `
<h2>Shopify — últimos 30 dias</h2>
<div class="cards">
  <div class="card"><div class="label">Revenue</div><div class="value">${fmtMoney(revenue30d)}</div></div>
  <div class="card"><div class="label">Orders</div><div class="value">${fmtInt(orders30d)}</div></div>
  <div class="card"><div class="label">AOV</div><div class="value">${fmtMoney(aov30d)}</div></div>
  <div class="card"><div class="label">New customers</div><div class="value">${fmtInt(newCust30d)}</div></div>
  <div class="card"><div class="label">Repeat rate</div><div class="value">${fmtPct(repeat30d)}</div></div>
</div>

<div class="sparkline-wrap">
  <div class="label">Revenue diário (${dailyRevenue.length} dias)</div>
  ${renderSparkline(dailyRevenue.map((k) => ({ x: new Date(k.period_start), y: Number(k.value) || 0 })), '#56d364')}
</div>
` : '<p class="muted">Shopify não ligado para esta empresa.</p>'}

${hasMeta ? `
<h2>Meta Ads — últimos 30 dias</h2>
<div class="cards">
  <div class="card"><div class="label">Spend</div><div class="value">${fmtMoney(metaSpend30d)}</div></div>
  <div class="card"><div class="label">Impressions</div><div class="value">${fmtInt(metaImpressions30d)}</div></div>
  <div class="card"><div class="label">Clicks</div><div class="value">${fmtInt(metaClicks30d)}</div></div>
  <div class="card"><div class="label">CTR</div><div class="value">${fmtPct(metaCtr30d)}</div></div>
  <div class="card"><div class="label">CPC</div><div class="value">${fmtMoney(metaCpc30d)}</div></div>
  <div class="card"><div class="label">Purchases (Meta-attrib)</div><div class="value">${fmtInt(metaPurchases30d)}</div></div>
</div>

<div class="sparkline-wrap">
  <div class="label">Spend diário Meta (${dailyMetaSpend.length} dias)</div>
  ${renderSparkline(dailyMetaSpend.map((k) => ({ x: new Date(k.period_start), y: Number(k.value) || 0 })), '#1f6feb')}
</div>
` : '<p class="muted">Meta Ads não ligado para esta empresa.</p>'}

${hasShopify && hasMeta ? `
<h2>Cross-channel</h2>
<div class="cards">
  <div class="card"><div class="label">CAC (cost per new customer)</div><div class="value">${fmtMoney(cac30d)}</div></div>
  <div class="card"><div class="label">ROAS (revenue ÷ Meta spend)</div><div class="value">${roas30d != null ? roas30d.toFixed(2) + 'x' : '—'}</div></div>
</div>
` : ''}

${customersByPlatform.length > 0 ? `
<h2>Customers (canonical)</h2>
<div class="cards">
${customersByPlatform.map((p) => `
  <div class="card">
    <div class="label">${escapeHtml(p.platform)}</div>
    <div class="value">${fmtInt(p.count)}</div>
    <div class="card-sub">${fmtMoney(p.total_revenue)} lifetime</div>
  </div>
`).join('')}
</div>

<h3 class="sub-h3">Confidence da attribution</h3>
<div class="raw-counts">
${customersByConfidence.map((c) => `
  <div class="item">
    <div class="label">${escapeHtml(c.confidence ?? 'unknown')}</div>
    <div class="value">${fmtInt(c.count)}</div>
  </div>
`).join('')}
</div>

<h3 class="sub-h3">Top 10 sources por revenue</h3>
<table>
  <thead>
    <tr><th>source</th><th>customers</th><th>total revenue</th><th>avg revenue</th></tr>
  </thead>
  <tbody>
${topSources.map((s) => `
    <tr>
      <td>${escapeHtml(s.source ?? '(null)')}</td>
      <td>${fmtInt(s.count)}</td>
      <td>${fmtMoney(s.total_revenue)}</td>
      <td>${fmtMoney(s.count > 0 ? s.total_revenue / s.count : 0)}</td>
    </tr>
`).join('')}
  </tbody>
</table>
` : ''}

${recentImports.length > 0 ? `
<h2>Últimos imports manuais</h2>
<table>
  <thead>
    <tr><th>quando</th><th>platform</th><th>format</th><th>filename</th><th>status</th><th>imported</th><th>skipped</th></tr>
  </thead>
  <tbody>
${recentImports.map((r) => {
  const ago = timeAgo(new Date(r.started_at));
  const statusClass = r.status === 'success' ? 'ok' : r.status === 'failed' ? 'err' : 'warn';
  return `
    <tr>
      <td title="${r.started_at}">${ago}</td>
      <td>${escapeHtml(r.source_platform)}</td>
      <td>${escapeHtml(r.format)}</td>
      <td>${escapeHtml(r.filename ?? '—')}</td>
      <td><span class="status ${statusClass}">${r.status}</span></td>
      <td>${fmtInt(r.rows_imported)}</td>
      <td>${fmtInt(r.rows_skipped)}</td>
    </tr>
  `;
}).join('')}
  </tbody>
</table>
` : ''}

<h2>Raw em DB</h2>
<div class="raw-counts">
  <div class="item"><div class="label">Shopify orders (API)</div><div class="value">${fmtInt(ordersCount)}</div></div>
  <div class="item"><div class="label">Shopify customers (API)</div><div class="value">${fmtInt(customersCount)}</div></div>
  <div class="item"><div class="label">Manual orders (CSV)</div><div class="value">${fmtInt(manualOrdersCount)}</div></div>
  <div class="item"><div class="label">Meta campaigns</div><div class="value">${fmtInt(metaCampaignsCount)}</div></div>
  <div class="item"><div class="label">Meta insights (rows)</div><div class="value">${fmtInt(metaInsightsCount)}</div></div>
</div>

<h2>Últimos ETL runs</h2>
<table>
  <thead>
    <tr><th>quando</th><th>canal</th><th>status</th><th>duração</th><th>rows</th><th>erro</th></tr>
  </thead>
  <tbody>${runsRows}</tbody>
</table>

<h2>get_business_health output</h2>
<details>
  <summary>JSON expandido</summary>
  <pre>${escapeHtml(healthPretty)}</pre>
</details>
` : ''}

</body></html>`;
}

function renderSparkline(
  points: Array<{ x: Date; y: number }>,
  color: string = '#56d364',
): string {
  if (points.length === 0) {
    return '<div class="muted" style="padding: 24px; text-align: center;">Sem dados</div>';
  }
  const w = 800, h = 80, pad = 4;
  const ys = points.map((p) => p.y);
  const maxY = Math.max(...ys, 1);
  const minY = 0;
  const xStep = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  const yScale = (y: number) =>
    h - pad - ((y - minY) / (maxY - minY || 1)) * (h - pad * 2);
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${pad + i * xStep} ${yScale(p.y)}`)
    .join(' ');
  const fillPath = `${path} L ${pad + (points.length - 1) * xStep} ${h - pad} L ${pad} ${h - pad} Z`;
  // Hex color → low-alpha fill version (append "22")
  const fillColor = `${color}22`;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width: 100%; height: 80px; display: block;">
    <path d="${fillPath}" fill="${fillColor}" stroke="none" />
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2" />
  </svg>`;
}

function timeAgo(d: Date): string {
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}min`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
