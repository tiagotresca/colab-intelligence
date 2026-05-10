// MCP server HTTP — endpoint único que expõe todas as tools da intelligence
// layer via MCP HTTP transport.
//
// Tool definitions vivem em `lib/mcp/tools/` (uma por ficheiro, ver
// CLAUDE.md). Este ficheiro é só HTTP shell + auth + dispatch.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { tools, type ToolName } from '../lib/mcp/registry.js';

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
      const name = params?.name as ToolName | undefined;
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
// as tools complicarem (input com objectos aninhados, unions, etc).
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
