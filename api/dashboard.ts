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

interface EmpresaRow {
  id: string;
  name: string;
}
interface KpiRow {
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'POST') {
    return handleTrigger(req, res);
  }

  // GET — render
  const selectedEmpresaId = (req.query.empresa as string | undefined)?.trim();
  const justTriggered = req.query.triggered === '1';

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
  let healthJson: unknown = null;

  if (empresa) {
    const periodEnd = new Date().toISOString();
    const periodStart = new Date(
      Date.now() - 30 * 24 * 3600 * 1000,
    ).toISOString();

    const [kpiQ, runsQ, ordersQ, customersQ] = await Promise.all([
      supabase
        .from('kpi_snapshots')
        .select('metric_key, period_start, value, meta')
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
    ]);

    kpis = (kpiQ.data ?? []) as KpiRow[];
    runs = (runsQ.data ?? []) as EtlRunRow[];
    ordersCount = ordersQ.count ?? 0;
    customersCount = customersQ.count ?? 0;

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
    healthJson,
    justTriggered,
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(html);
}

async function handleTrigger(req: VercelRequest, res: VercelResponse) {
  try {
    const empresas = await listEmpresasWithShopify();
    const results = [];
    for (const e of empresas) {
      results.push(await ingestShopifyEmpresa(e));
    }
    // Redirect back to GET para refrescar a UI
    const empresa = (req.query.empresa as string | undefined) ?? '';
    const back = empresa
      ? `/dashboard?empresa=${empresa}&triggered=1`
      : `/dashboard?triggered=1`;
    res.setHeader('Location', back);
    res.status(303).send(`Triggered ${results.length} empresas. Redirecting...`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erro desconhecido';
    res.status(500).send(`Trigger failed: ${msg}`);
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
  healthJson: unknown;
  justTriggered: boolean;
}

function renderDashboard(args: RenderArgs): string {
  const { empresas, selected, kpis, runs, ordersCount, customersCount, healthJson, justTriggered } = args;

  const dailyRevenue = kpis.filter((k) => k.metric_key === 'revenue_day');
  const currency =
    (kpis.find((k) => k.meta?.currency)?.meta?.currency as string | undefined) ?? '';

  const sumOf = (key: string): number | null => {
    const rows = kpis.filter((k) => k.metric_key === key);
    if (rows.length === 0) return null;
    return rows.reduce((s, r) => s + (Number(r.value) || 0), 0);
  };
  const avgOf = (key: string): number | null => {
    const rows = kpis.filter((k) => k.metric_key === key);
    if (rows.length === 0) return null;
    return rows.reduce((s, r) => s + (Number(r.value) || 0), 0) / rows.length;
  };

  const revenue30d = sumOf('revenue_day');
  const orders30d = sumOf('orders_count_day');
  const newCust30d = sumOf('new_customers_day');
  const repeat30d = avgOf('repeat_purchase_rate_day');
  const aov30d = revenue30d != null && orders30d ? revenue30d / orders30d : null;

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

  const sparkline = renderSparkline(
    dailyRevenue.map((k) => ({ x: new Date(k.period_start), y: Number(k.value) || 0 })),
  );

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
</style>
</head>
<body>
<h1>
  colab-intelligence
  <span class="meta">${new Date().toLocaleString('pt-PT')}</span>
</h1>

${justTriggered ? '<div class="toast">✓ Ingest disparado. Resultados refrescados em baixo.</div>' : ''}
${selected ? '' : '<p class="muted">Sem empresas ingeridas ainda. Carrega em "Trigger ingest" para correr o primeiro ETL.</p>'}

<form method="get" action="/dashboard" class="controls" style="margin-bottom: 24px;">
  <label>Empresa:</label>
  <select name="empresa" onchange="this.form.submit()">${empresaOpts || '<option>(nenhuma)</option>'}</select>
  <span style="flex: 1;"></span>
  <button class="primary" type="submit" formmethod="post" formaction="/dashboard${selected ? `?empresa=${selected.id}` : ''}">▶ Trigger ingest</button>
</form>

${selected ? `
<h2>KPIs últimos 30 dias</h2>
<div class="cards">
  <div class="card"><div class="label">Revenue</div><div class="value">${fmtMoney(revenue30d)}</div></div>
  <div class="card"><div class="label">Orders</div><div class="value">${fmtInt(orders30d)}</div></div>
  <div class="card"><div class="label">AOV</div><div class="value">${fmtMoney(aov30d)}</div></div>
  <div class="card"><div class="label">New customers</div><div class="value">${fmtInt(newCust30d)}</div></div>
  <div class="card"><div class="label">Repeat rate</div><div class="value">${fmtPct(repeat30d)}</div></div>
</div>

<div class="sparkline-wrap">
  <div class="label">Revenue diário (${dailyRevenue.length} dias)</div>
  ${sparkline}
</div>

<h2>Raw em DB</h2>
<div class="raw-counts">
  <div class="item"><div class="label">Orders ingeridos</div><div class="value">${fmtInt(ordersCount)}</div></div>
  <div class="item"><div class="label">Customers ingeridos</div><div class="value">${fmtInt(customersCount)}</div></div>
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

function renderSparkline(points: Array<{ x: Date; y: number }>): string {
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
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width: 100%; height: 80px; display: block;">
    <path d="${fillPath}" fill="#56d36422" stroke="none" />
    <path d="${path}" fill="none" stroke="#56d364" stroke-width="2" />
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
