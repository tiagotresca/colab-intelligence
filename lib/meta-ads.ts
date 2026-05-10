// Helpers para Meta Ads (Facebook Graph API).
//
// Padrão idêntico a lib/shopify.ts: credenciais por empresa lidas
// READ-ONLY de marketing_sources do work.colab. Token never touches
// the browser — é usado server-side aqui.
//
// Gotcha conhecido: tokens user-level expiram aos 60d, system_user
// tokens são permanentes. Tratamos 401/403 com mensagem clara para o
// user saber que precisa renovar manualmente.

import { workcolabSupabase } from './workcolab-supabase.js';

export const META_API_VERSION = 'v21.0';

export interface MetaAdsCredentials {
  adAccountId: string;       // 'act_<id>' (com prefix)
  accessToken: string;
}

export interface EmpresaWithMetaAds {
  empresa_id: string;
  empresa_name: string;
  adAccountId: string;
  accessToken: string;
}

// ---- Credentials lookup -----------------------------------------------------

function normalizeAccountId(raw: string): string {
  return raw.startsWith('act_') ? raw : `act_${raw}`;
}

export async function getMetaAdsCredentials(
  empresa_id: string,
): Promise<MetaAdsCredentials> {
  const { data, error } = await workcolabSupabase
    .from('marketing_sources')
    .select('meta_ad_account_id, meta_ads_access_token')
    .eq('project_id', empresa_id)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Lookup de marketing_sources falhou para empresa ${empresa_id}: ${error.message}`,
    );
  }
  if (!data || !data.meta_ad_account_id || !data.meta_ads_access_token) {
    throw new Error(`Meta Ads não configurado para empresa ${empresa_id}`);
  }
  return {
    adAccountId: normalizeAccountId(data.meta_ad_account_id),
    accessToken: data.meta_ads_access_token,
  };
}

export async function listEmpresasWithMetaAds(): Promise<EmpresaWithMetaAds[]> {
  const { data, error } = await workcolabSupabase
    .from('marketing_sources')
    .select('project_id, meta_ad_account_id, meta_ads_access_token, projects(name)')
    .not('meta_ads_access_token', 'is', null)
    .not('meta_ad_account_id', 'is', null);

  if (error) {
    throw new Error(`Listagem de empresas com Meta Ads falhou: ${error.message}`);
  }

  type Row = {
    project_id: string;
    meta_ad_account_id: string | null;
    meta_ads_access_token: string | null;
    projects: { name: string } | { name: string }[] | null;
  };

  return (data as Row[] | null ?? [])
    .filter((r): r is Row & { meta_ad_account_id: string; meta_ads_access_token: string } =>
      Boolean(r.meta_ad_account_id && r.meta_ads_access_token),
    )
    .map((r) => {
      const proj = Array.isArray(r.projects) ? r.projects[0] : r.projects;
      return {
        empresa_id: r.project_id,
        empresa_name: proj?.name ?? '(sem nome)',
        adAccountId: normalizeAccountId(r.meta_ad_account_id),
        accessToken: r.meta_ads_access_token,
      };
    });
}

// ---- Fetch ------------------------------------------------------------------

// Throttle conservador: Meta tem BUC limit de ~200 calls/h por app
// por ad_account. Para o ETL diário fazemos ~5-20 calls por empresa,
// portanto 200ms entre calls é folgado.
let lastCallAt = 0;
const MIN_INTERVAL_MS = 200;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

interface MetaFetchOptions {
  maxRetries?: number;
}

export async function metaFetch<T>(
  creds: MetaAdsCredentials,
  path: string,
  params: Record<string, string | number | undefined> = {},
  options: MetaFetchOptions = {},
): Promise<T> {
  const { maxRetries = 3 } = options;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`https://graph.facebook.com/${META_API_VERSION}${cleanPath}`);
  url.searchParams.set('access_token', creds.accessToken);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  let attempt = 0;
  while (true) {
    await throttle();
    const resp = await fetch(url.toString());

    if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
      attempt++;
      if (attempt > maxRetries) {
        throw new Error(`Meta ${resp.status} após ${maxRetries} retries em ${cleanPath}`);
      }
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      continue;
    }

    if (!resp.ok) {
      const errBody = await resp.text();
      // Token issues: dar mensagem accionável em vez de só "401"
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(
          `Meta token inválido/expirado (HTTP ${resp.status}). Renovar em work.colab → Definições → Integrações.`,
        );
      }
      throw new Error(`Meta ${resp.status} em ${cleanPath}: ${errBody.slice(0, 500)}`);
    }

    return (await resp.json()) as T;
  }
}

// Pagination: Meta usa cursor via `paging.next` (URL completo na resposta).
// Yields cada page de `data`.
export async function* paginateMeta<T>(
  creds: MetaAdsCredentials,
  path: string,
  params: Record<string, string | number | undefined> = {},
): AsyncGenerator<T[]> {
  let nextUrl: string | null = null;
  while (true) {
    let body: { data?: T[]; paging?: { next?: string } };
    if (nextUrl) {
      await throttle();
      const resp = await fetch(nextUrl);
      if (!resp.ok) {
        throw new Error(`Meta paginate ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      }
      body = (await resp.json()) as { data?: T[]; paging?: { next?: string } };
    } else {
      body = await metaFetch<{ data?: T[]; paging?: { next?: string } }>(creds, path, params);
    }
    yield body.data ?? [];
    if (!body.paging?.next) return;
    nextUrl = body.paging.next;
  }
}
