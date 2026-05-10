// Registry central de todas as MCP tools.
//
// Adicionar nova tool:
//   1. Criar `lib/mcp/tools/<nome>.ts` com `inputSchema`, `description`, `handler`
//   2. Importar aqui e adicionar ao `tools` map abaixo
//
// O HTTP entrypoint (api/mcp.ts) consome este registry — não toca em tools
// individuais.

import { z } from 'zod';
import * as getBusinessHealth from './tools/get_business_health.js';

interface ToolDefinition<I extends z.ZodType, O> {
  description: string;
  inputSchema: I;
  handler: (input: z.infer<I>) => Promise<O>;
}

// Cada entrada deve ter `as ToolDefinition<...>` para preservar tipos —
// mas o `as const` no objecto ajuda o discriminated dispatch em api/mcp.ts.
export const tools = {
  get_business_health: {
    description: getBusinessHealth.description,
    inputSchema: getBusinessHealth.inputSchema,
    handler: getBusinessHealth.handler,
  },
} as const satisfies Record<string, ToolDefinition<z.ZodType, unknown>>;

export type ToolName = keyof typeof tools;
