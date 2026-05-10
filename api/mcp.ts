// MCP server HTTP — endpoint único que expõe todas as tools da
// intelligence layer. O agente do work.colab consome este endpoint via
// MCP HTTP transport. Cada tool tem schema Zod e devolve JSON
// decision-ready (< 2k tokens em casos reais).

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import type { BusinessHealthOutput, Channel } from '../lib/types.js';

// ===== TOOL: get_business_health ============================================
// Estado consolidado de uma empresa nos últimos 30 dias. Headline + KPIs
// chave + sinais detectados (anomalias, oportunidades). Pensado para
// ser a primeira coisa que o agente chama quando vai propor tarefas.

const getBusinessHealthInput = z.object({
  empresa_id: z.string().uuid(),
});

interface SnapshotRow {
  channel: Channel;
  metric_key: string;
  period_start: string;
  value: number | null;
  meta: Record<string, unknown> | null;
}

async function getBusinessHealth(
  input: z.infer<typeof getBusinessHealthInput>,
): Promise<BusinessHealthOutput> {
  const { empresa_id } = input;

  const { data: empresa, error: empErr } = await supabase
    .from('empresas')
    .select('id,name')
    .eq('id', empresa_id)
    .single();

  if (empErr || !empresa) {
    throw new Error(`Empresa não encontrada: ${empresa_id}`);
  }

  const now = new Date();
  const periodEnd = now.toISOString();
  const periodStart = new Date(
    now.getTime() - 30 * 24 * 3600 * 1000,
  ).toISOString();

  // 1. Read pre-computed KPIs from kpi_snapshots (Synthesize layer
  // já fez o trabalho — aqui só agregamos os daily snapshots em
  // janela 30d, com chave composta (channel, metric_key) porque
  // Shopify e Meta Ads partilham metric_keys curtos.
  const { data: snapData, error: snapErr } = await supabase
    .from('kpi_snapshots')
    .select('channel, metric_key, period_start, value, meta')
    .eq('empresa_id', empresa_id)
    .eq('period_grain', 'day')
    .gte('period_start', periodStart)
    .lte('period_start', periodEnd);

  if (snapErr) {
    throw new Error(`fetch kpi_snapshots falhou: ${snapErr.message}`);
  }
  const snapshots = (snapData ?? []) as SnapshotRow[];

  const byKey = new Map<string, SnapshotRow[]>();
  for (const s of snapshots) {
    const k = `${s.channel}:${s.metric_key}`;
    const bucket = byKey.get(k);
    if (bucket) bucket.push(s);
    else byKey.set(k, [s]);
  }

  const sumOf = (channel: string, key: string): number | null => {
    const rows = byKey.get(`${channel}:${key}`);
    if (!rows || rows.length === 0) return null;
    return rows.reduce((s, r) => s + (Number(r.value) || 0), 0);
  };
  // weightedRatioOf: para KPIs de rácio diário, agrega correctamente como
  // sum(numerator) ÷ sum(denominator) em vez de média de rácios.
  // O daily synth guarda numerator e denominator no meta.
  const weightedRatioOf = (channel: string, key: string): number | null => {
    const rows = byKey.get(`${channel}:${key}`);
    if (!rows || rows.length === 0) return null;
    let num = 0;
    let den = 0;
    for (const r of rows) {
      const meta = r.meta as { numerator?: number; denominator?: number } | null;
      if (meta && typeof meta.numerator === 'number' && typeof meta.denominator === 'number') {
        num += meta.numerator;
        den += meta.denominator;
      }
    }
    return den > 0 ? num / den : null;
  };

  // ---- Shopify aggregations
  const revenue_30d = sumOf('shopify', 'revenue_day');
  const orders_30d = sumOf('shopify', 'orders_count_day');
  const aov_30d =
    revenue_30d != null && orders_30d && orders_30d > 0
      ? revenue_30d / orders_30d
      : null;
  const new_customers_30d = sumOf('shopify', 'new_customers_day');
  // Weighted ratio: sum(repeat orders) ÷ sum(orders with email) across 30d.
  // Mathematically distinto de avg de daily rates — bate com a definição
  // de "returning customer rate" da Shopify.
  const repeat_purchase_rate_30d = weightedRatioOf('shopify', 'repeat_purchase_rate_day');

  // ---- Meta Ads aggregations
  const meta_spend_30d = sumOf('meta_ads', 'spend_day');
  const meta_impressions_30d = sumOf('meta_ads', 'impressions_day');
  const meta_clicks_30d = sumOf('meta_ads', 'clicks_day');
  const meta_purchases_30d = sumOf('meta_ads', 'purchases_day');
  // Ratios computados aqui (evita média-de-rácios). Sum-based weighted.
  const meta_ctr_30d =
    meta_clicks_30d != null && meta_impressions_30d && meta_impressions_30d > 0
      ? meta_clicks_30d / meta_impressions_30d
      : null;
  const meta_cpc_30d =
    meta_spend_30d != null && meta_clicks_30d && meta_clicks_30d > 0
      ? meta_spend_30d / meta_clicks_30d
      : null;

  // ---- Cross-channel (só preenche quando ambos os canais têm dados)
  const cac_30d =
    meta_spend_30d != null && new_customers_30d && new_customers_30d > 0
      ? meta_spend_30d / new_customers_30d
      : null;
  const roas_30d =
    revenue_30d != null && meta_spend_30d && meta_spend_30d > 0
      ? revenue_30d / meta_spend_30d
      : null;

  // Currency vem do meta de qualquer revenue_day
  const revenueRows = byKey.get('shopify:revenue_day') ?? [];
  const currency =
    (revenueRows.find((r) => r.meta?.currency)?.meta?.currency as string | undefined) ??
    null;

  // 2. Headline — síntese 1 frase
  const headline = buildHeadline({
    revenue_30d,
    orders_30d,
    aov_30d,
    repeat_purchase_rate_30d,
    meta_spend_30d,
    roas_30d,
    currency,
  });

  // 3. Signals — heurísticas Phase 1 (umbrais simples, evoluem com eval loop)
  const signals: BusinessHealthOutput['signals'] = [];
  if (revenue_30d == null) {
    signals.push({
      severity: 'critical',
      message: 'Sem KPIs de Shopify nos últimos 30 dias — ETL pode estar parado ou empresa sem ligação.',
      suggested_action: 'Verificar etl_runs e correr /api/ingest/shopify manualmente.',
    });
  }
  if (
    repeat_purchase_rate_30d != null &&
    repeat_purchase_rate_30d < 0.2 &&
    orders_30d != null &&
    orders_30d >= 10
  ) {
    signals.push({
      severity: 'warning',
      message: `Repeat purchase rate baixo (${(repeat_purchase_rate_30d * 100).toFixed(0)}%) — só ${Math.round(repeat_purchase_rate_30d * 100)}% das encomendas vêm de clientes existentes.`,
      suggested_action: 'Considerar email/WhatsApp flow de retenção pós-compra ou win-back para inativos.',
    });
  }
  if (new_customers_30d != null && orders_30d != null && orders_30d >= 10) {
    const newRate = new_customers_30d / orders_30d;
    if (newRate > 0.7) {
      signals.push({
        severity: 'info',
        message: `Forte aquisição: ${Math.round(newRate * 100)}% das orders são de novos clientes.`,
        suggested_action: 'Garantir onboarding email + WhatsApp activos para converter em recorrência.',
      });
    }
  }
  // ROAS heurísticas (cross-channel — só dispara quando temos ambos os canais)
  if (roas_30d != null && meta_spend_30d != null && meta_spend_30d >= 100) {
    if (roas_30d < 1.5) {
      signals.push({
        severity: 'critical',
        message: `ROAS abaixo de break-even (${roas_30d.toFixed(1)}x): Shopify gera ${roas_30d.toFixed(1)}€ por cada €1 em Meta Ads.`,
        suggested_action: 'Pausar campanhas em loss, rever criativos ou audiences. Investigar attribution gaps com GA4.',
      });
    } else if (roas_30d < 2.5) {
      signals.push({
        severity: 'warning',
        message: `ROAS marginal (${roas_30d.toFixed(1)}x): margem fina depois de COGS + fees.`,
        suggested_action: 'Identificar campanhas com ROAS > média e realocar spend.',
      });
    } else if (roas_30d > 4) {
      signals.push({
        severity: 'info',
        message: `ROAS forte (${roas_30d.toFixed(1)}x) — possível headroom para escalar spend.`,
        suggested_action: 'Aumentar daily budgets das top campaigns gradualmente (10-20% por semana).',
      });
    }
  }
  if (cac_30d != null && aov_30d != null && cac_30d > aov_30d * 1.5) {
    signals.push({
      severity: 'warning',
      message: `CAC (${Math.round(cac_30d)}€) muito acima de AOV (${Math.round(aov_30d)}€) — payback depende fortemente de retenção.`,
      suggested_action: 'Foco em LTV: email/WhatsApp flows pós-compra, programa fidelidade.',
    });
  }

  // 4. Staleness — último etl_run com sucesso por canal
  const { data: lastRuns } = await supabase
    .from('etl_runs')
    .select('channel, completed_at')
    .eq('empresa_id', empresa_id)
    .eq('status', 'success')
    .order('completed_at', { ascending: false });

  const staleness: BusinessHealthOutput['staleness'] = {};
  for (const r of (lastRuns ?? []) as Array<{ channel: Channel; completed_at: string }>) {
    if (!staleness[r.channel] && r.completed_at) {
      staleness[r.channel] = r.completed_at;
    }
  }

  return {
    empresa_id: empresa.id,
    empresa_name: empresa.name,
    generated_at: now.toISOString(),
    period: { start: periodStart, end: periodEnd },
    currency,
    headline,
    kpis: {
      revenue_30d,
      revenue_change_pct: null,        // ainda null — precisa 60d
      orders_30d,
      aov_30d,
      new_customers_30d,
      repeat_purchase_rate_30d,
      meta_spend_30d,
      meta_impressions_30d,
      meta_clicks_30d,
      meta_ctr_30d,
      meta_cpc_30d,
      meta_purchases_30d,
      cac_30d,
      roas_30d,
      ltv_30d: null,                   // ainda null — cohort separado
    },
    signals,
    staleness,
  };
}

function buildHeadline(args: {
  revenue_30d: number | null;
  orders_30d: number | null;
  aov_30d: number | null;
  repeat_purchase_rate_30d: number | null;
  meta_spend_30d: number | null;
  roas_30d: number | null;
  currency: string | null;
}): string {
  const { revenue_30d, orders_30d, aov_30d, repeat_purchase_rate_30d, meta_spend_30d, roas_30d, currency } = args;
  const sym = currency === 'EUR' ? '€' : currency === 'USD' ? '$' : currency ? `${currency} ` : '';
  const fmtMoney = (v: number | null) =>
    v == null ? '?' : `${sym}${Math.round(v).toLocaleString('pt-PT')}`;

  if (revenue_30d == null && meta_spend_30d == null) {
    return 'Sem dados ingeridos nos últimos 30 dias.';
  }

  // Caso 1: só Meta Ads (sem Shopify)
  if (revenue_30d == null && meta_spend_30d != null) {
    return `Últimos 30d: spend Meta ${fmtMoney(meta_spend_30d)} (sem Shopify ligado).`;
  }

  // Caso 2: só Shopify (sem Meta) ou ambos
  const shopifyPart = revenue_30d != null && orders_30d != null
    ? `${fmtMoney(revenue_30d)} em ${orders_30d} orders (AOV ${fmtMoney(aov_30d)}${repeat_purchase_rate_30d != null ? `, repeat ${Math.round(repeat_purchase_rate_30d * 100)}%` : ''})`
    : '';

  const metaPart = meta_spend_30d != null
    ? `, spend Meta ${fmtMoney(meta_spend_30d)}${roas_30d != null ? ` (ROAS ${roas_30d.toFixed(1)}x)` : ''}`
    : '';

  return `Últimos 30d: ${shopifyPart}${metaPart}.`;
}

// ===== Tool registry =========================================================
// Adicionar novas tools aqui. Cada tool tem nome, schema, descrição (lida
// pelo agente) e handler.

const tools = {
  get_business_health: {
    description:
      'Estado consolidado de uma empresa: headline, KPIs chave (CAC, LTV, ROAS, receita), e signals detectados. Chamar primeiro quando vais propor tarefas — dá contexto base.',
    inputSchema: getBusinessHealthInput,
    handler: getBusinessHealth,
  },
} as const;

// ===== HTTP handler ==========================================================
// MCP HTTP transport: POST /api/mcp com { method, params }
// Suporta `tools/list` e `tools/call`. Não é uma implementação completa
// do protocolo MCP — adicionar capabilities/initialize quando integrarmos
// com o cliente MCP do work.colab.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Auth — token simples por header. Substituir por OAuth/scoped tokens
  // quando o consumer crescer (Fase 2+).
  const authToken = req.headers['x-mcp-token'];
  const expected = process.env.MCP_SHARED_TOKEN;
  if (!expected || authToken !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const body = req.body as { method?: string; params?: unknown };
  const method = body?.method;

  try {
    if (method === 'tools/list') {
      res.status(200).json({
        tools: Object.entries(tools).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: zodToJsonSchema(t.inputSchema),
        })),
      });
      return;
    }

    if (method === 'tools/call') {
      const params = body.params as { name?: string; arguments?: unknown };
      const name = params?.name as keyof typeof tools | undefined;
      if (!name || !(name in tools)) {
        res.status(400).json({ error: `Tool desconhecida: ${name}` });
        return;
      }
      const tool = tools[name];
      const parsed = tool.inputSchema.parse(params.arguments);
      const result = await tool.handler(parsed as never);
      res.status(200).json({ content: [{ type: 'json', json: result }] });
      return;
    }

    res.status(400).json({ error: `Método desconhecido: ${method}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro desconhecido';
    res.status(500).json({ error: message });
  }
}

// Zod → JSON Schema bare-bones. Substituir por `zod-to-json-schema` quando
// as tools complicarem.
function zodToJsonSchema(schema: z.ZodType): unknown {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, field] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(field);
      if (!field.isOptional()) required.push(key);
    }
    return { type: 'object', properties, required };
  }
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  return { type: 'unknown' };
}
