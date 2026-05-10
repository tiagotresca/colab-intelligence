// Importer combinado de subscriptions + subjects.
//
// Aceita um único CSV onde cada row representa UMA subscription + os
// dados do subject (cão, criança, etc) que essa subscription serve.
// Justificação: dados típicos de subscription apps têm subject info
// embutida — pedir 2 CSVs separados é fricção desnecessária.
//
// Idempotente:
//   - subjects: unique (empresa_id, external_subject_id) → upsert
//   - subscriptions: unique (empresa_id, external_subscription_id) → upsert
// Re-importar mesmo CSV não duplica.
//
// Edge cases:
//   - Subject sem subscription_id → row criada só em subjects (raro)
//   - Subscription sem subject_id → row criada só em subscriptions
//   - Mesmo subject usado em N subscriptions (raro mas suportado): subject
//     row aparece N vezes no CSV mas upsert por external_subject_id → 1 row

import crypto from 'node:crypto';
import Papa from 'papaparse';
import { supabase } from '../supabase.js';

const BATCH_SIZE = 500;

interface SubjectRow {
  empresa_id: string;
  customer_email_hash: string;
  external_subject_id: string | null;
  subject_type: string;
  name: string | null;
  attributes: Record<string, unknown> | null;
  active: boolean;
  created_at: string | null;
}

interface SubscriptionRow {
  empresa_id: string;
  customer_email_hash: string;
  subject_id: string | null;
  external_subscription_id: string;
  status: string;
  product_sku: string | null;
  frequency_days: number | null;
  mrr: number | null;
  started_at: string;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ImportSubscriptionsResult {
  ok: boolean;
  import_id: string;
  rows_processed: number;
  subjects_imported: number;
  subscriptions_imported: number;
  rows_skipped: number;
  errors: Array<{ line: number; reason: string }>;
}

interface ImportInput {
  empresa_id: string;
  source_platform: string;     // ex: 'aquinta_custom', 'lukydog_custom'
  filename: string | null;
  csv_content: string;
}

function hashEmail(email: string): string {
  return crypto
    .createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex');
}

function trimOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v: unknown): number | null {
  const n = num(v);
  return n != null ? Math.round(n) : null;
}

function parseDate(s: unknown): string | null {
  if (!s) return null;
  const str = String(s).trim();
  if (!str) return null;
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseBool(v: unknown, defaultVal: boolean): boolean {
  if (v === null || v === undefined || v === '') return defaultVal;
  const s = String(v).trim().toLowerCase();
  if (['true', 't', '1', 'yes', 'y', 'active'].includes(s)) return true;
  if (['false', 'f', '0', 'no', 'n', 'inactive'].includes(s)) return false;
  return defaultVal;
}

// Parse atributos do subject. Suporta 2 formas no CSV:
//   1. Coluna `attributes_json` ou `subject_attributes_json` com JSON string
//   2. Colunas individuais com prefix `subject_` (subject_breed, subject_age_years, etc)
//      — extraídas para o jsonb com nome sem prefix.
const SUBJECT_META_COLS = new Set([
  'subject_id', 'subject_type', 'subject_name', 'external_subject_id',
  'subject_attributes_json', 'subject_active', 'subject_created_at',
]);

function buildSubjectAttributes(
  row: Record<string, string>,
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};

  // 1. attributes_json column
  const json = trimOrNull(row['attributes_json']) ?? trimOrNull(row['subject_attributes_json']);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === 'object') {
        Object.assign(result, parsed);
      }
    } catch {
      // ignore parse errors — attribute json malformed
    }
  }

  // 2. `subject_*` prefixed columns (excluding well-known meta cols)
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith('subject_')) continue;
    if (SUBJECT_META_COLS.has(k)) continue;
    const trimmed = trimOrNull(v);
    if (trimmed === null) continue;
    const cleanKey = k.replace(/^subject_/, '');
    // Numeric coercion if it looks like a number
    const asNum = Number(trimmed);
    result[cleanKey] = !Number.isNaN(asNum) && /^-?\d/.test(trimmed) && trimmed === String(asNum)
      ? asNum
      : trimmed;
  }

  return Object.keys(result).length > 0 ? result : null;
}

const KNOWN_SUBSCRIPTION_COLS = new Set([
  'external_subscription_id', 'customer_email', 'status', 'product_sku',
  'frequency_days', 'mrr', 'started_at', 'cancelled_at', 'cancelled_reason',
  'external_subject_id', 'subject_id', 'subject_type', 'subject_name',
  'subject_active', 'subject_created_at', 'attributes_json',
  'subject_attributes_json', 'subscription_metadata_json',
]);

function buildSubscriptionMetadata(
  row: Record<string, string>,
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};

  const json = trimOrNull(row['subscription_metadata_json']);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === 'object') Object.assign(result, parsed);
    } catch {}
  }

  for (const [k, v] of Object.entries(row)) {
    if (KNOWN_SUBSCRIPTION_COLS.has(k)) continue;
    if (k.startsWith('subject_')) continue;
    const trimmed = trimOrNull(v);
    if (trimmed === null) continue;
    result[k] = trimmed;
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ---- Main entry -------------------------------------------------------------

export async function importSubscriptions(
  input: ImportInput,
): Promise<ImportSubscriptionsResult> {
  // 1. Open import_run row
  const { data: run, error: runErr } = await supabase
    .from('import_runs')
    .insert({
      empresa_id: input.empresa_id,
      source_platform: input.source_platform,
      format: 'subscriptions_v1',
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
    const result = Papa.parse<Record<string, string>>(input.csv_content, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
    });

    const rows = result.data ?? [];
    const errors: Array<{ line: number; reason: string }> = [];
    if (result.errors && result.errors.length > 0) {
      for (const e of result.errors) {
        errors.push({ line: (e.row ?? 0) + 2, reason: e.message });
      }
    }

    // 3. Build subjects + subscriptions arrays (dedup subjects por external_subject_id)
    const subjectsByExternalId = new Map<string, SubjectRow>();
    const subscriptionsTemp: Array<SubscriptionRow & { _externalSubjectId: string | null }> = [];
    let i = 0;
    let skipped = 0;

    for (const row of rows) {
      i++;
      const customerEmail = trimOrNull(row['customer_email']);
      if (!customerEmail) {
        skipped++;
        errors.push({ line: i + 1, reason: 'missing customer_email' });
        continue;
      }
      const emailHash = hashEmail(customerEmail);

      // Subject (opcional)
      const externalSubjectId = trimOrNull(row['external_subject_id'])
        ?? trimOrNull(row['subject_id']);
      const subjectType = trimOrNull(row['subject_type']);
      const subjectName = trimOrNull(row['subject_name']);
      const subjectAttributes = buildSubjectAttributes(row);

      if (externalSubjectId && subjectType) {
        if (!subjectsByExternalId.has(externalSubjectId)) {
          subjectsByExternalId.set(externalSubjectId, {
            empresa_id: input.empresa_id,
            customer_email_hash: emailHash,
            external_subject_id: externalSubjectId,
            subject_type: subjectType.toLowerCase(),
            name: subjectName,
            attributes: subjectAttributes,
            active: parseBool(row['subject_active'], true),
            created_at: parseDate(row['subject_created_at']),
          });
        }
      }

      // Subscription (opcional — a row pode ser só de subject)
      const externalSubId = trimOrNull(row['external_subscription_id']);
      if (!externalSubId) {
        if (!externalSubjectId) {
          skipped++;
          errors.push({
            line: i + 1,
            reason: 'row sem external_subscription_id nem external_subject_id',
          });
        }
        continue;
      }

      const startedAt = parseDate(row['started_at']);
      if (!startedAt) {
        skipped++;
        errors.push({
          line: i + 1,
          reason: `subscription ${externalSubId} sem started_at válido`,
        });
        continue;
      }

      const status = (trimOrNull(row['status']) ?? 'active').toLowerCase();

      subscriptionsTemp.push({
        empresa_id: input.empresa_id,
        customer_email_hash: emailHash,
        subject_id: null,                    // resolved depois do upsert de subjects
        external_subscription_id: externalSubId,
        status,
        product_sku: trimOrNull(row['product_sku']),
        frequency_days: intOrNull(row['frequency_days']),
        mrr: num(row['mrr']),
        started_at: startedAt,
        cancelled_at: parseDate(row['cancelled_at']),
        cancelled_reason: trimOrNull(row['cancelled_reason']),
        metadata: buildSubscriptionMetadata(row),
        _externalSubjectId: externalSubjectId,
      });
    }

    // 4. Upsert subjects primeiro
    const subjectsArray = Array.from(subjectsByExternalId.values());
    let subjectsImported = 0;
    const subjectIdByExternalId = new Map<string, string>();

    for (let j = 0; j < subjectsArray.length; j += BATCH_SIZE) {
      const batch = subjectsArray.slice(j, j + BATCH_SIZE);
      const { data, error } = await supabase
        .from('subjects')
        .upsert(batch, { onConflict: 'empresa_id,external_subject_id' })
        .select('id, external_subject_id');
      if (error) throw new Error(`upsert subjects: ${error.message}`);
      subjectsImported += batch.length;
      for (const r of (data ?? []) as Array<{ id: string; external_subject_id: string | null }>) {
        if (r.external_subject_id) subjectIdByExternalId.set(r.external_subject_id, r.id);
      }
    }

    // 5. Resolve subject_id em subscriptions e upsert
    const subscriptionsArray: SubscriptionRow[] = subscriptionsTemp.map((s) => ({
      empresa_id: s.empresa_id,
      customer_email_hash: s.customer_email_hash,
      subject_id: s._externalSubjectId
        ? subjectIdByExternalId.get(s._externalSubjectId) ?? null
        : null,
      external_subscription_id: s.external_subscription_id,
      status: s.status,
      product_sku: s.product_sku,
      frequency_days: s.frequency_days,
      mrr: s.mrr,
      started_at: s.started_at,
      cancelled_at: s.cancelled_at,
      cancelled_reason: s.cancelled_reason,
      metadata: s.metadata,
    }));

    let subsImported = 0;
    for (let j = 0; j < subscriptionsArray.length; j += BATCH_SIZE) {
      const batch = subscriptionsArray.slice(j, j + BATCH_SIZE);
      const { error } = await supabase
        .from('subscriptions')
        .upsert(batch, { onConflict: 'empresa_id,external_subscription_id' });
      if (error) throw new Error(`upsert subscriptions: ${error.message}`);
      subsImported += batch.length;
    }

    const finalResult: ImportSubscriptionsResult = {
      ok: true,
      import_id: run.id,
      rows_processed: rows.length,
      subjects_imported: subjectsImported,
      subscriptions_imported: subsImported,
      rows_skipped: skipped,
      errors,
    };

    // 6. Close import_run
    await supabase
      .from('import_runs')
      .update({
        status: 'success',
        completed_at: new Date().toISOString(),
        rows_processed: rows.length,
        rows_imported: subjectsImported + subsImported,
        rows_skipped: skipped,
        errors: errors.length > 0 ? errors.slice(0, 50) : null,
      })
      .eq('id', run.id);

    return finalResult;
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
