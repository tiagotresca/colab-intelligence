// ETL diário de Shopify. Corrido pelo cron (vercel.json: 0 5 * * *).
// Lógica:
// 1. Para cada empresa com Shopify ligado, abre etl_run.
// 2. Puxa orders + customers desde o último run bem-sucedido.
// 3. Calcula KPIs derivados (revenue_day, new_customers_day, ltv_30d, etc.)
//    e faz upsert em kpi_snapshots.
// 4. Marca run como 'success' ou 'failed'.
//
// Idempotente: re-correr o cron para o mesmo dia faz upsert nos mesmos
// rows de kpi_snapshots (unique constraint).

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../../lib/supabase.js';

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  // TODO Fase 1: implementar
  // - listar empresas com shopify ligado (sync das credentials do work.colab)
  // - para cada uma, criar etl_run, fetch incremental, computar KPIs, upsert
  // - mark run success/failed

  const { data: empresas, error } = await supabase
    .from('empresas')
    .select('id,name');

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(200).json({
    ok: true,
    note: 'stub — implementar fetch Shopify + cálculo de KPIs',
    empresas_count: empresas?.length ?? 0,
  });
}
