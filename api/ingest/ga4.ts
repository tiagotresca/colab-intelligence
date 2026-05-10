// ETL diário de GA4 — handler do cron (e trigger manual via header).
// Lógica em lib/ingest/ga4.ts. Auth via Authorization: Bearer ${CRON_SECRET}.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { listEmpresasWithGA4, type EmpresaWithGA4 } from '../../lib/ga4.js';
import { ingestGA4Empresa, type EmpresaResult } from '../../lib/ingest/ga4.js';

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

  let empresas: EmpresaWithGA4[];
  try {
    empresas = await listEmpresasWithGA4();
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'erro desconhecido',
    });
    return;
  }

  const results: EmpresaResult[] = [];
  for (const e of empresas) {
    const result = await ingestGA4Empresa(e);
    results.push(result);
  }

  res.status(200).json({
    ok: true,
    empresas_processed: empresas.length,
    results,
  });
}
