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
  // janela 30d).
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

  const byMetric = new Map<string, SnapshotRow[]>();
  for (const s of snapshots) {
    const bucket = byMetric.get(s.metric_key);
    if (bucket) bucket.push(s);
    else byMetric.set(s.metric_key, [s]);
  }

  const sumOf = (key: string): number | null => {
    const rows = byMetric.get(key);
    if (!rows || rows.length === 0) return null;
    return rows.reduce((s, r) => s + (Number(r.value) || 0), 0);
  };
  const avgOf = (key: string): number | null => {
    const rows = byMetric.get(key);
    if (!rows || rows.length === 0) return null;
    const sum = rows.reduce((s, r) => s + (Number(r.value) || 0), 0);
    return sum / rows.length;
  };

  const revenue_30d = sumOf('revenue_day');
  const orders_30d = sumOf('orders_count_day');
  const aov_30d =
    revenue_30d != null && orders_30d && orders_30d > 0
      ? revenue_30d / orders_30d
      : null;
  const new_customers_30d = sumOf('new_customers_day');
  const repeat_purchase_rate_30d = avgOf('repeat_purchase_rate_day');

  // Currency vem do meta de qualquer revenue_day
  const revenueRows = byMetric.get('revenue_day') ?? [];
  const currency =
    (revenueRows.find((r) => r.meta?.currency)?.meta?.currency as string | undefined) ??
    null;

  // 2. Headline — síntese 1 frase
  const headline = buildHeadline({
    revenue_30d,
    orders_30d,
    aov_30d,
    repeat_purchase_rate_30d,
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
      revenue_change_pct: null,        // Phase 2 — precisa 60d para comparar
      orders_30d,
      aov_30d,
      new_customers_30d,
      repeat_purchase_rate_30d,
      cac_30d: null,                   // Phase 2 — precisa Meta Ads
      ltv_30d: null,                   // Phase 2 — cohort separado
      roas_30d: null,                  // Phase 2 — precisa Meta Ads
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
  currency: string | null;
}): string {
  const { revenue_30d, orders_30d, aov_30d, repeat_purchase_rate_30d, currency } = args;
  if (revenue_30d == null || orders_30d == null) {
    return 'Sem dados de Shopify nos últimos 30 dias.';
  }
  const sym = currency === 'EUR' ? '€' : currency === 'USD' ? '$' : `${currency ?? ''} `;
  const fmtMoney = (v: number | null) =>
    v == null ? '?' : `${sym}${Math.round(v).toLocaleString('pt-PT')}`;
  const repeat =
    repeat_purchase_rate_30d != null
      ? `, repeat ${Math.round(repeat_purchase_rate_30d * 100)}%`
      : '';
  return `Últimos 30d: ${fmtMoney(revenue_30d)} em ${orders_30d} orders (AOV ${fmtMoney(aov_30d)}${repeat}).`;
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
