// ETL diário de Meta Ads — handler do cron (e trigger manual via header).
// Lógica em lib/ingest/meta-ads.ts. Auth via Authorization: Bearer ${CRON_SECRET}.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  listEmpresasWithMetaAds,
  type EmpresaWithMetaAds,
} from '../../lib/meta-ads.js';
import {
  ingestMetaAdsEmpresa,
  type EmpresaResult,
} from '../../lib/ingest/meta-ads.js';

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

  let empresas: EmpresaWithMetaAds[];
  try {
    empresas = await listEmpresasWithMetaAds();
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'erro desconhecido',
    });
    return;
  }

  const results: EmpresaResult[] = [];
  for (const e of empresas) {
    const result = await ingestMetaAdsEmpresa(e);
    results.push(result);
  }

  res.status(200).json({
    ok: true,
    empresas_processed: empresas.length,
    results,
  });
}
