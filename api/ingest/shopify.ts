// ETL diário de Shopify — handler do cron (e trigger manual via header).
// A lógica vive em lib/ingest/shopify.ts para ser reutilizada pelo
// dashboard sem duplicar código.
//
// Auth:
//   - Vercel cron passa Authorization: Bearer ${CRON_SECRET} automaticamente
//   - Manual trigger: mesmo header, mesmo valor

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  listEmpresasWithShopify,
  type EmpresaWithShopify,
} from '../../lib/shopify.js';
import {
  ingestShopifyEmpresa,
  type EmpresaResult,
} from '../../lib/ingest/shopify.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    res.status(500).json({ error: 'CRON_SECRET não configurado' });
    return;
  }
  if (req.headers.authorization !== `Bearer ${expected}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let empresas: EmpresaWithShopify[];
  try {
    empresas = await listEmpresasWithShopify();
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'erro desconhecido',
    });
    return;
  }

  const results: EmpresaResult[] = [];
  for (const e of empresas) {
    const result = await ingestShopifyEmpresa(e);
    results.push(result);
  }

  res.status(200).json({
    ok: true,
    empresas_processed: empresas.length,
    results,
  });
}
