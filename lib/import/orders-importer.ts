// Importer principal — recebe CSV string + metadata e popula
// manual_orders_raw + import_runs.
//
// Idempotente via primary key (empresa_id, source_platform,
// external_order_id) — re-importar o mesmo CSV faz upsert,
// sem duplicar.

import { supabase } from '../supabase.js';
import { parseOrdersCsv, type SupportedFormat, type ParsedOrder } from './csv-parser.js';

const BATCH_SIZE = 500;

export interface ImportResult {
  ok: boolean;
  import_id: string;
  rows_processed: number;
  rows_imported: number;
  rows_skipped: number;
  errors: Array<{ line: number; reason: string }>;
}

interface ImportInput {
  empresa_id: string;
  source_platform: string;
  format: SupportedFormat;
  filename: string | null;
  csv_content: string;
}

export async function importOrders(input: ImportInput): Promise<ImportResult> {
  // 1. Open import_run row
  const { data: run, error: runErr } = await supabase
    .from('import_runs')
    .insert({
      empresa_id: input.empresa_id,
      source_platform: input.source_platform,
      format: input.format,
      filename: input.filename,
      status: 'running',
    })
    .select('id')
    .single();

  if (runErr || !run) {
    throw new Error(`failed to open import_run: ${runErr?.message ?? 'no id'}`);
  }

  try {
    // 2. Parse CSV
    const parsed = parseOrdersCsv(input.csv_content, input.format);

    // 3. Upsert in batches
    let imported = 0;
    const orders = parsed.orders;
    for (let i = 0; i < orders.length; i += BATCH_SIZE) {
      const batch = orders.slice(i, i + BATCH_SIZE).map((o) => toRawRow(input, o));
      if (batch.length === 0) continue;
      const { error } = await supabase
        .from('manual_orders_raw')
        .upsert(batch, {
          onConflict: 'empresa_id,source_platform,external_order_id',
        });
      if (error) {
        throw new Error(`upsert manual_orders_raw: ${error.message}`);
      }
      imported += batch.length;
    }

    const skipped = parsed.rows_processed - orders.length;
    const result: ImportResult = {
      ok: true,
      import_id: run.id,
      rows_processed: parsed.rows_processed,
      rows_imported: imported,
      rows_skipped: skipped,
      errors: parsed.errors,
    };

    // 4. Close import_run
    await supabase
      .from('import_runs')
      .update({
        status: 'success',
        completed_at: new Date().toISOString(),
        rows_processed: result.rows_processed,
        rows_imported: result.rows_imported,
        rows_skipped: result.rows_skipped,
        errors: result.errors.length > 0 ? result.errors.slice(0, 50) : null,
      })
      .eq('id', run.id);

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erro desconhecido';
    await supabase
      .from('import_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        errors: [{ line: 0, reason: msg }],
      })
      .eq('id', run.id);
    throw err;
  }
}

function toRawRow(input: ImportInput, o: ParsedOrder) {
  return {
    empresa_id: input.empresa_id,
    source_platform: input.source_platform,
    external_order_id: o.external_order_id,
    created_at: o.created_at,
    email: o.email,
    total_price: o.total_price,
    subtotal_price: o.subtotal_price,
    total_discounts: o.total_discounts,
    total_tax: o.total_tax,
    total_shipping: o.total_shipping,
    currency: o.currency,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status,
    customer_id: o.customer_id,
    discount_codes: o.discount_codes,
    primary_discount_code: o.primary_discount_code,
    has_discount: o.has_discount,
    utm_source: o.utm_source,
    utm_medium: o.utm_medium,
    utm_campaign: o.utm_campaign,
    utm_content: o.utm_content,
    utm_term: o.utm_term,
    landing_url: o.landing_url,
    referrer: o.referrer,
    device: o.device,
    extra: o.extra,
  };
}
