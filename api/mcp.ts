// MCP server HTTP — endpoint único que expõe todas as tools da
// intelligence layer. O agente do work.colab consome este endpoint via
// MCP HTTP transport. Cada tool tem schema Zod e devolve JSON
// decision-ready (< 2k tokens em casos reais).

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import type { BusinessHealthOutput } from '../lib/types.js';

// ===== TOOL: get_business_health ============================================
// Estado consolidado de uma empresa nos últimos 30 dias. Headline + KPIs
// chave + sinais detectados (anomalias, oportunidades). Pensado para
// ser a primeira coisa que o agente chama quando vai propor tarefas.

const getBusinessHealthInput = z.object({
  empresa_id: z.string().uuid(),
});

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

  // TODO Fase 1: ler kpi_snapshots reais. Por agora devolve mock para
  // permitir wiring end-to-end com o agente do work.colab.
  const now = new Date();
  const periodEnd = now.toISOString();
  const periodStart = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();

  return {
    empresa_id: empresa.id,
    empresa_name: empresa.name,
    generated_at: now.toISOString(),
    period: { start: periodStart, end: periodEnd },
    headline: '[mock] Receita estável, CAC a subir 12% — oportunidade em retenção.',
    kpis: {
      revenue_30d: null,
      revenue_change_pct: null,
      new_customers_30d: null,
      cac_30d: null,
      ltv_30d: null,
      roas_30d: null,
    },
    signals: [
      {
        severity: 'info',
        message: 'Dados ainda não ingeridos — implementar ETL Shopify para activar.',
        suggested_action: 'Ver api/ingest/shopify.ts',
      },
    ],
    staleness: {},
  };
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
