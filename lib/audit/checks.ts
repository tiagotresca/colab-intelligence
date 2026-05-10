// Data Audit Layer — checks de integridade e consistência por empresa.
//
// Cada check é uma função pura que faz queries read-only e devolve um
// AuditCheck. Severities: 'ok' (verde, está bem), 'info' (azul, vale
// notar mas nada accionável), 'warning' (amarelo, deves olhar),
// 'critical' (vermelho, está errado).
//
// Adicionar check novo: nova função + adicionar ao runAuditForEmpresa.
// Cada check é independente — falha de um não para os outros (try/catch
// isolated por check).

import { supabase } from '../supabase.js';
import { assertNoLimitHit } from '../util/limits.js';

export type Severity = 'ok' | 'info' | 'warning' | 'critical';

export type AuditCategory =
  | 'data_integrity'
  | 'source_consistency'
  | 'kpi_sanity'
  | 'modules'
  | 'etl_status'
  | 'attribution';

export interface AuditCheck {
  id: string;
  category: AuditCategory;
  name: string;
  severity: Severity;
  message: string;
  count?: number;
  hint?: string;        // sugestão de fix se severity > ok
  examples?: unknown[]; // sample rows quando útil (limitado a ~5)
}

const STALE_HOURS_THRESHOLD = 30; // ETL deve ter corrido nas últimas 30h

// ---- Helpers ----------------------------------------------------------------

async function safeRunCheck(
  fn: () => Promise<AuditCheck>,
): Promise<AuditCheck> {
  try {
    return await fn();
  } catch (err) {
    return {
      id: 'check_error',
      category: 'data_integrity',
      name: 'Check execution error',
      severity: 'warning',
      message: err instanceof Error ? err.message : 'erro desconhecido',
    };
  }
}

// ---- Check: Customers consistency vs raw -----------------------------------

async function checkCustomersConsistency(empresa_id: string): Promise<AuditCheck> {
  // Para platform='shopify', conta customers canonical vs distinct emails
  // em ambas as fontes raw (API + manual).
  const [customersC, apiOrdersDistinct, manualOrdersDistinct] = await Promise.all([
    supabase
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('empresa_id', empresa_id)
      .eq('platform', 'shopify'),
    supabase
      .from('shopify_orders_raw')
      .select('email')
      .eq('empresa_id', empresa_id)
      .not('email', 'is', null)
      .limit(50000),
    supabase
      .from('manual_orders_raw')
      .select('email')
      .eq('empresa_id', empresa_id)
      .eq('source_platform', 'shopify_export')
      .not('email', 'is', null)
      .limit(100000),
  ]);

  assertNoLimitHit(apiOrdersDistinct.data, 50000, `audit checkCustomerCoverage api orders ${empresa_id}`);
  assertNoLimitHit(manualOrdersDistinct.data, 100000, `audit checkCustomerCoverage manual orders ${empresa_id}`);
  const customerCount = customersC.count ?? 0;
  const apiEmails = new Set(
    ((apiOrdersDistinct.data ?? []) as Array<{ email: string }>)
      .map((r) => r.email.trim().toLowerCase()),
  );
  const manualEmails = new Set(
    ((manualOrdersDistinct.data ?? []) as Array<{ email: string }>)
      .map((r) => r.email.trim().toLowerCase()),
  );
  const allEmails = new Set([...apiEmails, ...manualEmails]);
  const expectedCustomers = allEmails.size;

  if (expectedCustomers === 0) {
    return {
      id: 'customers_consistency',
      category: 'data_integrity',
      name: 'Customers vs raw orders',
      severity: 'info',
      message: 'Sem orders ingeridos com email, sem customers para verificar.',
    };
  }

  const diff = expectedCustomers - customerCount;
  if (diff === 0) {
    return {
      id: 'customers_consistency',
      category: 'data_integrity',
      name: 'Customers vs raw orders',
      severity: 'ok',
      message: `${customerCount} customers em customers table batem com ${expectedCustomers} emails únicos no raw.`,
      count: customerCount,
    };
  }

  if (diff > 0) {
    return {
      id: 'customers_consistency',
      category: 'data_integrity',
      name: 'Customers vs raw orders',
      severity: 'warning',
      message: `customers table tem ${customerCount} rows mas raw tem ${expectedCustomers} emails únicos. Diff: ${diff} (synthesize de customers pode estar stale).`,
      count: diff,
      hint: 'Re-correr synthesize de customers (botão "Re-synth customers" no topo).',
    };
  }

  return {
    id: 'customers_consistency',
    category: 'data_integrity',
    name: 'Customers vs raw orders',
    severity: 'warning',
    message: `customers table tem ${customerCount} rows mas raw só tem ${expectedCustomers} emails únicos. Excesso: ${-diff} (orders foram apagados ou customers órfãos).`,
    count: -diff,
    hint: 'Inspeccionar customers table com query directa para identificar órfãos.',
  };
}

// ---- Check: Orders without email -------------------------------------------

async function checkOrdersWithoutEmail(empresa_id: string): Promise<AuditCheck> {
  const [withEmailQ, totalQ, manualWithEmailQ, manualTotalQ] = await Promise.all([
    supabase
      .from('shopify_orders_raw')
      .select('shopify_order_id', { count: 'exact', head: true })
      .eq('empresa_id', empresa_id)
      .not('email', 'is', null),
    supabase
      .from('shopify_orders_raw')
      .select('shopify_order_id', { count: 'exact', head: true })
      .eq('empresa_id', empresa_id),
    supabase
      .from('manual_orders_raw')
      .select('external_order_id', { count: 'exact', head: true })
      .eq('empresa_id', empresa_id)
      .not('email', 'is', null),
    supabase
      .from('manual_orders_raw')
      .select('external_order_id', { count: 'exact', head: true })
      .eq('empresa_id', empresa_id),
  ]);

  const totalApi = totalQ.count ?? 0;
  const withEmailApi = withEmailQ.count ?? 0;
  const totalManual = manualTotalQ.count ?? 0;
  const withEmailManual = manualWithEmailQ.count ?? 0;
  const withoutEmailApi = totalApi - withEmailApi;
  const withoutEmailManual = totalManual - withEmailManual;
  const totalWithoutEmail = withoutEmailApi + withoutEmailManual;
  const total = totalApi + totalManual;

  if (total === 0) {
    return {
      id: 'orders_without_email',
      category: 'data_integrity',
      name: 'Orders sem email (guest checkouts)',
      severity: 'info',
      message: 'Sem orders ingeridos.',
    };
  }

  const pct = total > 0 ? (totalWithoutEmail / total) * 100 : 0;
  if (totalWithoutEmail === 0) {
    return {
      id: 'orders_without_email',
      category: 'data_integrity',
      name: 'Orders sem email',
      severity: 'ok',
      message: `Todos os ${total} orders têm email associado.`,
      count: 0,
    };
  }
  if (pct < 5) {
    return {
      id: 'orders_without_email',
      category: 'data_integrity',
      name: 'Orders sem email (guest checkouts)',
      severity: 'info',
      message: `${totalWithoutEmail}/${total} (${pct.toFixed(1)}%) orders sem email — não contribuem para customer aggregation.`,
      count: totalWithoutEmail,
    };
  }
  return {
    id: 'orders_without_email',
    category: 'data_integrity',
    name: 'Orders sem email',
    severity: 'warning',
    message: `${totalWithoutEmail}/${total} (${pct.toFixed(1)}%) orders sem email — % alta. Análises de LTV/repeat ficam impactadas.`,
    count: totalWithoutEmail,
    hint: 'Investigar fonte: pode ser guest checkouts no Shopify, exports CSV mal parseados, ou problema na captura de email.',
  };
}

// ---- Check: Source overlap (Shopify API vs manual import) -------------------

async function checkSourceOverlap(empresa_id: string): Promise<AuditCheck> {
  const [apiQ, manualQ] = await Promise.all([
    supabase
      .from('shopify_orders_raw')
      .select('shopify_order_id')
      .eq('empresa_id', empresa_id)
      .limit(100000),
    supabase
      .from('manual_orders_raw')
      .select('external_order_id')
      .eq('empresa_id', empresa_id)
      .eq('source_platform', 'shopify_export')
      .limit(100000),
  ]);

  assertNoLimitHit(apiQ.data, 100000, `audit checkSourceOverlap api orders ${empresa_id}`);
  assertNoLimitHit(manualQ.data, 100000, `audit checkSourceOverlap manual orders ${empresa_id}`);
  const apiIds = new Set(
    ((apiQ.data ?? []) as Array<{ shopify_order_id: number }>)
      .map((r) => String(r.shopify_order_id)),
  );
  const manualIds = new Set(
    ((manualQ.data ?? []) as Array<{ external_order_id: string }>)
      .map((r) => r.external_order_id),
  );
  const overlap = [...apiIds].filter((id) => manualIds.has(id)).length;
  const apiOnly = apiIds.size - overlap;
  const manualOnly = manualIds.size - overlap;

  if (apiIds.size === 0 && manualIds.size === 0) {
    return {
      id: 'source_overlap',
      category: 'source_consistency',
      name: 'Overlap API vs Manual import',
      severity: 'info',
      message: 'Sem orders Shopify ingeridos.',
    };
  }
  if (manualIds.size === 0) {
    return {
      id: 'source_overlap',
      category: 'source_consistency',
      name: 'Overlap API vs Manual import',
      severity: 'info',
      message: `Só fonte API ingerida (${apiIds.size} orders). Sem manual import yet.`,
      count: apiIds.size,
    };
  }
  if (apiIds.size === 0) {
    return {
      id: 'source_overlap',
      category: 'source_consistency',
      name: 'Overlap API vs Manual import',
      severity: 'info',
      message: `Só manual import (${manualIds.size} orders). Cron API não corre ainda?`,
      count: manualIds.size,
    };
  }

  // Both sources have data
  return {
    id: 'source_overlap',
    category: 'source_consistency',
    name: 'Overlap API vs Manual import',
    severity: overlap > 0 ? 'ok' : 'info',
    message: `API: ${apiIds.size} | Manual: ${manualIds.size} | Overlap: ${overlap} (API ganha) | API-only: ${apiOnly} | Manual-only: ${manualOnly} (histórico fora da janela API).`,
    count: overlap,
  };
}

// ---- Check: KPI sanity (revenue raw vs kpi_snapshots) -----------------------

async function checkKpiRevenueSanity(empresa_id: string): Promise<AuditCheck> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  // Sum revenue last 30d from kpi_snapshots
  const { data: kpis } = await supabase
    .from('kpi_snapshots')
    .select('value')
    .eq('empresa_id', empresa_id)
    .eq('channel', 'shopify')
    .eq('metric_key', 'revenue_day')
    .eq('period_grain', 'day')
    .gte('period_start', since);

  const kpiRevenue = (kpis ?? []).reduce(
    (s, r) => s + (Number((r as { value: number | null }).value) || 0),
    0,
  );

  // Sum revenue last 30d directly from raw (API + manual, deduped)
  const [apiQ, manualQ] = await Promise.all([
    supabase
      .from('shopify_orders_raw')
      .select('shopify_order_id, total_price, financial_status')
      .eq('empresa_id', empresa_id)
      .gte('created_at', since)
      .limit(50000),
    supabase
      .from('manual_orders_raw')
      .select('external_order_id, total_price, financial_status')
      .eq('empresa_id', empresa_id)
      .eq('source_platform', 'shopify_export')
      .gte('created_at', since)
      .limit(50000),
  ]);

  assertNoLimitHit(apiQ.data, 50000, `audit revenue api orders ${empresa_id} since ${since}`);
  assertNoLimitHit(manualQ.data, 50000, `audit revenue manual orders ${empresa_id} since ${since}`);
  const REVENUE_STATUSES = new Set(['paid', 'partially_refunded']);
  const apiOrders = (apiQ.data ?? []) as Array<{
    shopify_order_id: number;
    total_price: number | null;
    financial_status: string | null;
  }>;
  const manualOrders = (manualQ.data ?? []) as Array<{
    external_order_id: string;
    total_price: number | null;
    financial_status: string | null;
  }>;
  const apiIds = new Set(apiOrders.map((o) => String(o.shopify_order_id)));

  let rawRevenue = 0;
  for (const o of apiOrders) {
    if (REVENUE_STATUSES.has(o.financial_status ?? '')) {
      rawRevenue += Number(o.total_price) || 0;
    }
  }
  for (const o of manualOrders) {
    if (apiIds.has(o.external_order_id)) continue;
    if (REVENUE_STATUSES.has(o.financial_status ?? '')) {
      rawRevenue += Number(o.total_price) || 0;
    }
  }

  if (rawRevenue === 0 && kpiRevenue === 0) {
    return {
      id: 'kpi_revenue_sanity',
      category: 'kpi_sanity',
      name: 'Revenue raw vs kpi_snapshots (30d)',
      severity: 'info',
      message: 'Sem revenue nos últimos 30 dias.',
    };
  }

  const diff = Math.abs(kpiRevenue - rawRevenue);
  const pctDiff = rawRevenue > 0 ? (diff / rawRevenue) * 100 : 0;

  if (pctDiff < 0.1) {
    return {
      id: 'kpi_revenue_sanity',
      category: 'kpi_sanity',
      name: 'Revenue raw vs kpi_snapshots (30d)',
      severity: 'ok',
      message: `kpi_snapshots €${kpiRevenue.toFixed(2)} ≈ raw €${rawRevenue.toFixed(2)} (diff < 0.1%).`,
    };
  }
  if (pctDiff < 2) {
    return {
      id: 'kpi_revenue_sanity',
      category: 'kpi_sanity',
      name: 'Revenue raw vs kpi_snapshots (30d)',
      severity: 'info',
      message: `kpi_snapshots €${kpiRevenue.toFixed(2)} vs raw €${rawRevenue.toFixed(2)} (diff ${pctDiff.toFixed(2)}% — aceitável, edge cases de timezone).`,
    };
  }
  return {
    id: 'kpi_revenue_sanity',
    category: 'kpi_sanity',
    name: 'Revenue raw vs kpi_snapshots (30d)',
    severity: 'warning',
    message: `Discrepância material: kpi_snapshots €${kpiRevenue.toFixed(2)} vs raw €${rawRevenue.toFixed(2)} (diff ${pctDiff.toFixed(1)}%).`,
    hint: 'Re-correr synthesize de KPIs (botão "Re-synth KPIs" no topo).',
  };
}

// ---- Check: Subscriptions/Subjects health (only when modules used) ---------

async function checkModulesHealth(empresa_id: string): Promise<AuditCheck | null> {
  const [subsQ, subjQ, orphanQ] = await Promise.all([
    supabase
      .from('subscriptions')
      .select('id, subject_id', { count: 'exact' })
      .eq('empresa_id', empresa_id)
      .limit(50000),
    supabase
      .from('subjects')
      .select('id', { count: 'exact', head: true })
      .eq('empresa_id', empresa_id),
    // Subscriptions com subject_id que não existe na subjects table
    supabase
      .from('subscriptions')
      .select('id, subject_id, external_subscription_id')
      .eq('empresa_id', empresa_id)
      .not('subject_id', 'is', null)
      .limit(5000),
  ]);

  assertNoLimitHit(subsQ.data, 50000, `audit modules subscriptions ${empresa_id}`);
  // orphanQ tem .limit(5000) mas é intencionalmente baixo (top-N orphans
  // para mostrar exemplos no audit, não para análise). Não alarmar.
  const subsCount = subsQ.count ?? 0;
  const subjsCount = subjQ.count ?? 0;

  if (subsCount === 0 && subjsCount === 0) {
    return null; // Empresa não usa módulo, skip silencioso
  }

  // Verifica orphans: subscription tem subject_id mas subject não existe
  const subsWithSubjectId = (orphanQ.data ?? []) as Array<{
    id: string;
    subject_id: string;
    external_subscription_id: string;
  }>;
  if (subsWithSubjectId.length === 0) {
    return {
      id: 'modules_health',
      category: 'modules',
      name: 'Subscriptions + Subjects',
      severity: subsCount > 0 ? 'ok' : 'info',
      message: `${subsCount} subscriptions, ${subjsCount} subjects. Sem subscriptions com subject_id (todas standalone ou empresa não usa subjects).`,
    };
  }

  const subjectIds = subsWithSubjectId.map((s) => s.subject_id);
  const { data: existingSubjects } = await supabase
    .from('subjects')
    .select('id')
    .eq('empresa_id', empresa_id)
    .in('id', subjectIds.slice(0, 1000)); // limit safe IN clause
  const existingSet = new Set(((existingSubjects ?? []) as Array<{ id: string }>).map((s) => s.id));
  const orphans = subsWithSubjectId.filter((s) => !existingSet.has(s.subject_id));

  if (orphans.length === 0) {
    return {
      id: 'modules_health',
      category: 'modules',
      name: 'Subscriptions + Subjects',
      severity: 'ok',
      message: `${subsCount} subscriptions, ${subjsCount} subjects. Todos os subject_ids existem.`,
    };
  }

  return {
    id: 'modules_health',
    category: 'modules',
    name: 'Subscriptions + Subjects',
    severity: 'critical',
    message: `${orphans.length} subscriptions referenciam subject_id que não existe na subjects table.`,
    count: orphans.length,
    hint: 'Re-importar subscriptions+subjects CSV. Importer dedupe e resolve FKs correctamente.',
    examples: orphans.slice(0, 5).map((o) => o.external_subscription_id),
  };
}

// ---- Check: ETL staleness ---------------------------------------------------

async function checkEtlStale(empresa_id: string): Promise<AuditCheck> {
  const { data: lastRuns } = await supabase
    .from('etl_runs')
    .select('channel, status, started_at, completed_at, error_message')
    .eq('empresa_id', empresa_id)
    .order('started_at', { ascending: false })
    .limit(50);

  const runs = (lastRuns ?? []) as Array<{
    channel: string;
    status: string;
    started_at: string;
    completed_at: string | null;
    error_message: string | null;
  }>;

  if (runs.length === 0) {
    return {
      id: 'etl_stale',
      category: 'etl_status',
      name: 'ETL freshness',
      severity: 'info',
      message: 'Sem etl_runs registadas. Cron ainda não correu para esta empresa.',
    };
  }

  // Most recent run state per channel. Se a mais recente é success,
  // falhas antigas são irrelevantes — o canal recuperou.
  interface ChannelState {
    status: string;
    at: Date;
    error: string | null;
  }
  const latestRunByChannel = new Map<string, ChannelState>();
  for (const r of runs) {
    if (!latestRunByChannel.has(r.channel)) {
      latestRunByChannel.set(r.channel, {
        status: r.status,
        at: new Date(r.completed_at ?? r.started_at),
        error: r.error_message,
      });
    }
  }

  const now = Date.now();
  const stale: string[] = [];
  const failed: string[] = [];

  for (const [channel, state] of latestRunByChannel) {
    if (state.status === 'failed') {
      failed.push(`${channel}: ${(state.error ?? 'sem detalhe').slice(0, 80)}`);
      continue;
    }
    if (state.status !== 'success') continue;
    const hoursAgo = (now - state.at.getTime()) / (1000 * 3600);
    if (hoursAgo > STALE_HOURS_THRESHOLD) {
      stale.push(`${channel}: último success há ${Math.round(hoursAgo)}h`);
    }
  }

  if (stale.length === 0 && failed.length === 0) {
    return {
      id: 'etl_stale',
      category: 'etl_status',
      name: 'ETL freshness',
      severity: 'ok',
      message: `${latestRunByChannel.size} canais com mais recente run = success, dentro de ${STALE_HOURS_THRESHOLD}h.`,
    };
  }
  if (failed.length > 0) {
    return {
      id: 'etl_stale',
      category: 'etl_status',
      name: 'ETL freshness',
      severity: 'warning',
      message: `Última run de ${failed.length} canal(is) ainda em failed: ${failed.join('; ')}`,
      count: failed.length,
      hint: 'Re-disparar manualmente "Trigger ingest" para forçar nova run. Se persistir, verificar token / scope / schema.',
    };
  }
  return {
    id: 'etl_stale',
    category: 'etl_status',
    name: 'ETL freshness',
    severity: 'warning',
    message: `${stale.length} canais com últimas runs > ${STALE_HOURS_THRESHOLD}h: ${stale.join(', ')}`,
    count: stale.length,
    hint: 'Cron pode estar parado, ou disparar manualmente "Trigger ingest" no topo do dashboard.',
  };
}

// ---- Check: Attribution coverage --------------------------------------------

async function checkAttributionCoverage(empresa_id: string): Promise<AuditCheck> {
  const [ordersTotalQ, attributionTotalQ, customersHighQ, customersAllQ] = await Promise.all([
    supabase
      .from('shopify_orders_raw')
      .select('shopify_order_id', { count: 'exact', head: true })
      .eq('empresa_id', empresa_id),
    supabase
      .from('shopify_order_attribution')
      .select('shopify_order_id', { count: 'exact', head: true })
      .eq('empresa_id', empresa_id),
    supabase
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('empresa_id', empresa_id)
      .eq('platform', 'shopify')
      .eq('acquisition_first_touch_confidence', 'high'),
    supabase
      .from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('empresa_id', empresa_id)
      .eq('platform', 'shopify'),
  ]);

  const orders = ordersTotalQ.count ?? 0;
  const attributions = attributionTotalQ.count ?? 0;
  const customersHigh = customersHighQ.count ?? 0;
  const customersAll = customersAllQ.count ?? 0;

  if (orders === 0) {
    return {
      id: 'attribution_coverage',
      category: 'attribution',
      name: 'Attribution coverage',
      severity: 'info',
      message: 'Sem orders Shopify ingeridos via API.',
    };
  }

  const attrPct = orders > 0 ? (attributions / orders) * 100 : 0;
  const highPct = customersAll > 0 ? (customersHigh / customersAll) * 100 : 0;

  let severity: Severity;
  let message: string;
  if (attrPct < 95) {
    severity = 'warning';
    message = `Só ${attributions}/${orders} orders (${attrPct.toFixed(1)}%) têm attribution row. Re-correr synthesize de attribution.`;
  } else if (highPct < 20) {
    severity = 'info';
    message = `${customersHigh}/${customersAll} (${highPct.toFixed(0)}%) customers têm attribution 'high' (UTMs reais). ${customersAll - customersHigh} ficam em 'medium'/'low' por falta de tagging consistente nas campanhas.`;
  } else {
    severity = 'ok';
    message = `Attribution: ${attributions}/${orders} orders (${attrPct.toFixed(1)}%) com row em attribution table. ${highPct.toFixed(0)}% dos customers em 'high' confidence.`;
  }

  return {
    id: 'attribution_coverage',
    category: 'attribution',
    name: 'Attribution coverage',
    severity,
    message,
    hint: severity === 'info' ? 'Para subir % de "high", garantir UTMs em todas as URLs de campanhas (Meta, Google, email, etc).' : undefined,
  };
}

// ---- Check: Recent imports --------------------------------------------------

async function checkRecentImports(empresa_id: string): Promise<AuditCheck> {
  const { data } = await supabase
    .from('import_runs')
    .select('source_platform, format, status, started_at, completed_at, rows_imported, rows_skipped, errors')
    .eq('empresa_id', empresa_id)
    .order('started_at', { ascending: false })
    .limit(5);

  const runs = (data ?? []) as Array<{
    source_platform: string;
    format: string;
    status: string;
    started_at: string;
    completed_at: string | null;
    rows_imported: number | null;
    rows_skipped: number | null;
    errors: unknown;
  }>;

  if (runs.length === 0) {
    return {
      id: 'recent_imports',
      category: 'data_integrity',
      name: 'Imports recentes',
      severity: 'info',
      message: 'Sem manual imports para esta empresa.',
    };
  }

  const failed = runs.filter((r) => r.status === 'failed');
  const totalImported = runs.reduce((s, r) => s + (r.rows_imported ?? 0), 0);
  const totalSkipped = runs.reduce((s, r) => s + (r.rows_skipped ?? 0), 0);

  if (failed.length > 0) {
    return {
      id: 'recent_imports',
      category: 'data_integrity',
      name: 'Imports recentes',
      severity: 'warning',
      message: `${failed.length}/${runs.length} imports recentes falharam. Total: ${totalImported} rows imported, ${totalSkipped} skipped.`,
      count: failed.length,
      hint: 'Ver detalhes dos errors no import_runs.errors.',
    };
  }

  return {
    id: 'recent_imports',
    category: 'data_integrity',
    name: 'Imports recentes',
    severity: 'ok',
    message: `${runs.length} imports recentes, todos success. ${totalImported} rows imported, ${totalSkipped} skipped.`,
    count: totalImported,
  };
}

// ---- Main entry -------------------------------------------------------------

export async function runAuditForEmpresa(empresa_id: string): Promise<AuditCheck[]> {
  const results = await Promise.all([
    safeRunCheck(() => checkCustomersConsistency(empresa_id)),
    safeRunCheck(() => checkOrdersWithoutEmail(empresa_id)),
    safeRunCheck(() => checkSourceOverlap(empresa_id)),
    safeRunCheck(() => checkKpiRevenueSanity(empresa_id)),
    safeRunCheck(async () => {
      const c = await checkModulesHealth(empresa_id);
      return c ?? {
        id: 'modules_health',
        category: 'modules',
        name: 'Modules (subscriptions/subjects)',
        severity: 'info',
        message: 'Empresa não usa módulo subscriptions/subjects.',
      };
    }),
    safeRunCheck(() => checkEtlStale(empresa_id)),
    safeRunCheck(() => checkAttributionCoverage(empresa_id)),
    safeRunCheck(() => checkRecentImports(empresa_id)),
  ]);

  return results;
}
