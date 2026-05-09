// ETL diário de Shopify — camada Ingest.
//
// Para cada empresa com Shopify ligado em marketing_sources do work.colab:
//  1. Sync da empresa para a NOSSA tabela `empresas` (mirror do work.colab)
//  2. Determina range incremental:
//      - 1ª run: lookback 30 dias
//      - runs seguintes: desde `last_success.range_end - 7d` (re-fetch
//        dos últimos 7 dias para apanhar refunds, fulfillment changes,
//        edits — estes mudam updated_at sem o created_at mudar)
//  3. Abre etl_run (status=running)
//  4. Pull paginado de orders e customers via Admin API (updated_at_min)
//  5. Upsert em shopify_orders_raw / shopify_customers_raw
//     (idempotente via primary key composto)
//  6. Fecha etl_run (success ou failed + error_message)
//
// Synthesize (KPIs derivados → kpi_snapshots) é PR 3, ainda não corre aqui.
//
// Auth:
//   - Vercel cron passa Authorization: Bearer ${CRON_SECRET} automaticamente
//   - Manual trigger: mesmo header, mesmo valor

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  listEmpresasWithShopify,
  paginateShopify,
  type EmpresaWithShopify,
} from '../../lib/shopify.js';
import { supabase } from '../../lib/supabase.js';
import { synthesizeShopify } from '../../lib/synthesize/shopify.js';

const LOOKBACK_DAYS_FIRST_RUN = 30;
const REFETCH_RECENT_DAYS = 7;

interface ShopifyOrder {
  id: number;
  created_at: string;
  updated_at: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  total_price: string | null;
  subtotal_price: string | null;
  total_discounts: string | null;
  total_tax: string | null;
  currency: string | null;
  email: string | null;
  customer: { id: number } | null;
  [k: string]: unknown;
}

interface ShopifyCustomer {
  id: number;
  created_at: string;
  updated_at: string;
  email: string | null;
  orders_count: number | null;
  total_spent: string | null;
  state: string | null;
  [k: string]: unknown;
}

interface EmpresaResult {
  empresa_id: string;
  empresa_name: string;
  status: 'success' | 'failed' | 'failed_pre_run';
  orders?: number;
  customers?: number;
  kpis_upserted?: number;
  days_computed?: number;
  range?: { start: string; end: string };
  error?: string;
}

function toNumberOrNull(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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
    const result = await processEmpresa(e);
    results.push(result);
  }

  res.status(200).json({
    ok: true,
    empresas_processed: empresas.length,
    results,
  });
}

async function processEmpresa(e: EmpresaWithShopify): Promise<EmpresaResult> {
  // 1. Sync empresa (mirror)
  try {
    const { error } = await supabase.from('empresas').upsert({
      id: e.empresa_id,
      name: e.empresa_name,
      synced_at: new Date().toISOString(),
    });
    if (error) throw new Error(`sync empresa falhou: ${error.message}`);
  } catch (err) {
    return {
      empresa_id: e.empresa_id,
      empresa_name: e.empresa_name,
      status: 'failed_pre_run',
      error: err instanceof Error ? err.message : 'erro desconhecido',
    };
  }

  // 2. Determine incremental range
  const now = new Date();
  const rangeEnd = now.toISOString();

  const { data: lastRun, error: lastErr } = await supabase
    .from('etl_runs')
    .select('range_end')
    .eq('empresa_id', e.empresa_id)
    .eq('channel', 'shopify')
    .eq('status', 'success')
    .order('completed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastErr) {
    return {
      empresa_id: e.empresa_id,
      empresa_name: e.empresa_name,
      status: 'failed_pre_run',
      error: `lookup last etl_run falhou: ${lastErr.message}`,
    };
  }

  let rangeStart: string;
  if (lastRun?.range_end) {
    const lastEndMs = new Date(lastRun.range_end).getTime();
    const refetchFrom = new Date(lastEndMs - REFETCH_RECENT_DAYS * 24 * 3600 * 1000);
    rangeStart = refetchFrom.toISOString();
  } else {
    rangeStart = new Date(
      now.getTime() - LOOKBACK_DAYS_FIRST_RUN * 24 * 3600 * 1000,
    ).toISOString();
  }

  // 3. Open etl_run
  const { data: run, error: runErr } = await supabase
    .from('etl_runs')
    .insert({
      empresa_id: e.empresa_id,
      channel: 'shopify',
      status: 'running',
      range_start: rangeStart,
      range_end: rangeEnd,
    })
    .select('id')
    .single();

  if (runErr || !run) {
    return {
      empresa_id: e.empresa_id,
      empresa_name: e.empresa_name,
      status: 'failed_pre_run',
      error: `etl_run insert falhou: ${runErr?.message ?? 'sem id'}`,
    };
  }

  let ordersIngested = 0;
  let customersIngested = 0;
  const creds = { domain: e.domain, accessToken: e.accessToken };

  try {
    // 4a. Orders
    for await (const page of paginateShopify<ShopifyOrder>(
      creds,
      'orders.json',
      'orders',
      {
        updated_at_min: rangeStart,
        status: 'any',
        limit: 250,
      },
    )) {
      if (page.length === 0) continue;
      const rows = page.map((o) => ({
        empresa_id: e.empresa_id,
        shopify_order_id: o.id,
        created_at: o.created_at,
        updated_at: o.updated_at,
        financial_status: o.financial_status,
        fulfillment_status: o.fulfillment_status,
        total_price: toNumberOrNull(o.total_price),
        subtotal_price: toNumberOrNull(o.subtotal_price),
        total_discounts: toNumberOrNull(o.total_discounts),
        total_tax: toNumberOrNull(o.total_tax),
        currency: o.currency,
        customer_id: o.customer?.id ?? null,
        email: o.email,
        payload: o,
      }));
      const { error } = await supabase
        .from('shopify_orders_raw')
        .upsert(rows, { onConflict: 'empresa_id,shopify_order_id' });
      if (error) throw new Error(`upsert orders falhou: ${error.message}`);
      ordersIngested += rows.length;
    }

    // 4b. Customers
    for await (const page of paginateShopify<ShopifyCustomer>(
      creds,
      'customers.json',
      'customers',
      {
        updated_at_min: rangeStart,
        limit: 250,
      },
    )) {
      if (page.length === 0) continue;
      const rows = page.map((c) => ({
        empresa_id: e.empresa_id,
        shopify_customer_id: c.id,
        created_at: c.created_at,
        updated_at: c.updated_at,
        email: c.email,
        orders_count: c.orders_count,
        total_spent: toNumberOrNull(c.total_spent),
        state: c.state,
        payload: c,
      }));
      const { error } = await supabase
        .from('shopify_customers_raw')
        .upsert(rows, { onConflict: 'empresa_id,shopify_customer_id' });
      if (error) throw new Error(`upsert customers falhou: ${error.message}`);
      customersIngested += rows.length;
    }

    // 5. Synthesize — lê raw, computa KPIs, upsert kpi_snapshots
    const synth = await synthesizeShopify(e.empresa_id, {
      start: rangeStart,
      end: rangeEnd,
    });

    // 6. Close run success
    await supabase
      .from('etl_runs')
      .update({
        status: 'success',
        completed_at: new Date().toISOString(),
        rows_ingested: ordersIngested + customersIngested,
      })
      .eq('id', run.id);

    return {
      empresa_id: e.empresa_id,
      empresa_name: e.empresa_name,
      status: 'success',
      orders: ordersIngested,
      customers: customersIngested,
      kpis_upserted: synth.kpis_upserted,
      days_computed: synth.days_computed,
      range: { start: rangeStart, end: rangeEnd },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erro desconhecido';
    await supabase
      .from('etl_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: msg,
        rows_ingested: ordersIngested + customersIngested,
      })
      .eq('id', run.id);
    return {
      empresa_id: e.empresa_id,
      empresa_name: e.empresa_name,
      status: 'failed',
      orders: ordersIngested,
      customers: customersIngested,
      range: { start: rangeStart, end: rangeEnd },
      error: msg,
    };
  }
}
