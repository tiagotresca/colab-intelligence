// Helpers para GA4 (Google Analytics 4 Data API).
//
// Padrão idêntico a lib/meta-ads.ts: credenciais por empresa lidas
// READ-ONLY de marketing_sources do work.colab.
//
// Auth: GA4 usa Service Account com JWT signing (RS256) → exchange por
// access_token OAuth (TTL 1h). Espelha exactamente o que /api/ga4-test.js
// faz no work.colab.
//
// Gotcha: o campo `ga4_property_id` em marketing_sources foi adicionado
// ad-hoc no Supabase Dashboard (não está em sql/2026-05-05-ads-and-ga4.sql
// do work.colab — só lá ficaram measurement_id + service_account_json).
// Por isso lemos os 3 campos com tolerância — se property_id faltar, skip.

import crypto from 'node:crypto';
import { workcolabSupabase } from './workcolab-supabase.js';

const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';

export interface GA4Credentials {
  propertyId: string;       // só dígitos, sem prefix 'properties/'
  clientEmail: string;
  privateKey: string;
}

export interface EmpresaWithGA4 {
  empresa_id: string;
  empresa_name: string;
  propertyId: string;
  clientEmail: string;
  privateKey: string;
}

// ---- JWT signing -----------------------------------------------------------

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signJwt(payload: Record<string, unknown>, privateKey: string): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(data), privateKey);
  return `${data}.${base64url(sig)}`;
}

// Token cache: SAs partilham TTL ~1h. Cache por client_email para evitar
// re-troca em cada query (uma sessão de ETL faz 2-3 reports por empresa).
const tokenCache = new Map<string, { token: string; expires_at: number }>();

async function getAccessToken(creds: GA4Credentials): Promise<string> {
  const cached = tokenCache.get(creds.clientEmail);
  if (cached && cached.expires_at > Date.now() + 60_000) {
    return cached.token;
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt(
    {
      iss: creds.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    },
    creds.privateKey,
  );
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const body = (await resp.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!resp.ok || !body.access_token) {
    throw new Error(
      `GA4 OAuth JWT exchange falhou: ${body.error_description ?? body.error ?? `HTTP ${resp.status}`}`,
    );
  }
  const token = body.access_token;
  const ttlSec = body.expires_in ?? 3600;
  tokenCache.set(creds.clientEmail, {
    token,
    expires_at: Date.now() + ttlSec * 1000,
  });
  return token;
}

// ---- Credentials lookup ----------------------------------------------------

function normalizePropertyId(raw: string): string {
  // Aceita "properties/123456789" ou "123456789" — devolve só dígitos.
  return String(raw).replace(/\D/g, '');
}

function parseSA(raw: string): { client_email: string; private_key: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Service Account JSON inválido');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).client_email !== 'string' ||
    typeof (parsed as Record<string, unknown>).private_key !== 'string'
  ) {
    throw new Error('Service Account JSON sem client_email ou private_key');
  }
  return parsed as { client_email: string; private_key: string };
}

export async function getGA4Credentials(
  empresa_id: string,
): Promise<GA4Credentials> {
  const { data, error } = await workcolabSupabase
    .from('marketing_sources')
    .select('ga4_property_id, ga4_service_account_json')
    .eq('project_id', empresa_id)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Lookup de marketing_sources falhou para empresa ${empresa_id}: ${error.message}`,
    );
  }
  if (!data || !data.ga4_property_id || !data.ga4_service_account_json) {
    throw new Error(`GA4 não configurado para empresa ${empresa_id}`);
  }
  const sa = parseSA(data.ga4_service_account_json);
  return {
    propertyId: normalizePropertyId(data.ga4_property_id),
    clientEmail: sa.client_email,
    privateKey: sa.private_key,
  };
}

export async function listEmpresasWithGA4(): Promise<EmpresaWithGA4[]> {
  const { data, error } = await workcolabSupabase
    .from('marketing_sources')
    .select('project_id, ga4_property_id, ga4_service_account_json, projects(name)')
    .not('ga4_property_id', 'is', null)
    .not('ga4_service_account_json', 'is', null);

  if (error) {
    throw new Error(`Listagem de empresas com GA4 falhou: ${error.message}`);
  }

  type Row = {
    project_id: string;
    ga4_property_id: string | null;
    ga4_service_account_json: string | null;
    projects: { name: string } | { name: string }[] | null;
  };

  const out: EmpresaWithGA4[] = [];
  for (const r of (data as Row[] | null) ?? []) {
    if (!r.ga4_property_id || !r.ga4_service_account_json) continue;
    try {
      const sa = parseSA(r.ga4_service_account_json);
      const proj = Array.isArray(r.projects) ? r.projects[0] : r.projects;
      out.push({
        empresa_id: r.project_id,
        empresa_name: proj?.name ?? '(sem nome)',
        propertyId: normalizePropertyId(r.ga4_property_id),
        clientEmail: sa.client_email,
        privateKey: sa.private_key,
      });
    } catch {
      // SA JSON inválido — saltar empresa, vai aparecer como skipped no result.
    }
  }
  return out;
}

// ---- Data API queries ------------------------------------------------------

interface DateRange {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
}

interface ReportRequest {
  dateRanges: DateRange[];
  dimensions?: { name: string }[];
  metrics: { name: string }[];
  limit?: number;
  offset?: number;
}

interface ReportResponseRow {
  dimensionValues?: Array<{ value?: string }>;
  metricValues?: Array<{ value?: string }>;
}

interface ReportResponse {
  rows?: ReportResponseRow[];
  rowCount?: number;
  metadata?: { currencyCode?: string; timeZone?: string };
}

// Throttle conservador: GA4 Data API tem quotas generosas para Standard
// (200k token requests/dia/property). Para ETL diário fazemos 2-3 reports
// por empresa = trivial. 200ms entre calls evita bursts.
let lastCallAt = 0;
const MIN_INTERVAL_MS = 200;
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

export async function runReport(
  creds: GA4Credentials,
  request: ReportRequest,
  options: { maxRetries?: number } = {},
): Promise<ReportResponse> {
  const { maxRetries = 3 } = options;
  const url = `${DATA_API_BASE}/properties/${creds.propertyId}:runReport`;

  let attempt = 0;
  while (true) {
    await throttle();
    const token = await getAccessToken(creds);
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
      attempt++;
      if (attempt > maxRetries) {
        throw new Error(
          `GA4 ${resp.status} após ${maxRetries} retries em property ${creds.propertyId}`,
        );
      }
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      continue;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(
          `GA4 acesso negado (HTTP ${resp.status}) à property ${creds.propertyId}. Verificar partilha com ${creds.clientEmail} (role Viewer).`,
        );
      }
      throw new Error(
        `GA4 ${resp.status} em property ${creds.propertyId}: ${errText.slice(0, 500)}`,
      );
    }

    return (await resp.json()) as ReportResponse;
  }
}

// ---- Helpers para parsing dos rows -----------------------------------------

// GA4 devolve dates no formato 'YYYYMMDD'. Converte para ISO 'YYYY-MM-DD'.
export function parseGA4Date(raw: string | undefined): string | null {
  if (!raw || raw.length !== 8) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

// Métricas GA4 vêm sempre como string. Helpers para coerção segura.
export function num(v: string | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function bigInt(v: string | undefined): number | null {
  const n = num(v);
  return n != null && Number.isInteger(n) ? n : n != null ? Math.round(n) : null;
}
