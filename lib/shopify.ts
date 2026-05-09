// Helpers para a Shopify Admin API.
//
// Padrão: credenciais por empresa vivem em `marketing_sources` no
// work.colab (fonte de verdade). Aqui fazemos lookup read-only e
// usamos as credenciais para chamar a Shopify directamente.
//
// Mirror de api/shopify-proxy.js no work.colab — sem o auth check,
// porque corremos server-side com service-role.

import { workcolabSupabase } from './workcolab-supabase.js';

export const SHOPIFY_API_VERSION = '2025-04';

export interface ShopifyCredentials {
  domain: string;       // ex: 'opasse.myshopify.com'
  accessToken: string;  // shpat_...
}

export interface EmpresaWithShopify {
  empresa_id: string;
  empresa_name: string;
  domain: string;
  accessToken: string;
}

// ---- Credentials lookup -----------------------------------------------------

export async function getShopifyCredentials(
  empresa_id: string,
): Promise<ShopifyCredentials> {
  const { data, error } = await workcolabSupabase
    .from('marketing_sources')
    .select('shopify_domain, shopify_access_token')
    .eq('project_id', empresa_id)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Lookup de marketing_sources falhou para empresa ${empresa_id}: ${error.message}`,
    );
  }
  if (!data || !data.shopify_domain || !data.shopify_access_token) {
    throw new Error(`Shopify não configurado para empresa ${empresa_id}`);
  }
  return {
    domain: data.shopify_domain,
    accessToken: data.shopify_access_token,
  };
}

// Lista todas as empresas que têm Shopify configurado (token presente).
// Usado pelo cron de ingest para iterar — uma row por empresa.
export async function listEmpresasWithShopify(): Promise<EmpresaWithShopify[]> {
  const { data, error } = await workcolabSupabase
    .from('marketing_sources')
    .select('project_id, shopify_domain, shopify_access_token, projects(name)')
    .not('shopify_access_token', 'is', null)
    .not('shopify_domain', 'is', null);

  if (error) {
    throw new Error(`Listagem de empresas com Shopify falhou: ${error.message}`);
  }

  type Row = {
    project_id: string;
    shopify_domain: string | null;
    shopify_access_token: string | null;
    projects: { name: string } | { name: string }[] | null;
  };

  return (data as Row[] | null ?? [])
    .filter((r): r is Row & { shopify_domain: string; shopify_access_token: string } =>
      Boolean(r.shopify_domain && r.shopify_access_token),
    )
    .map((r) => {
      const proj = Array.isArray(r.projects) ? r.projects[0] : r.projects;
      return {
        empresa_id: r.project_id,
        empresa_name: proj?.name ?? '(sem nome)',
        domain: r.shopify_domain,
        accessToken: r.shopify_access_token,
      };
    });
}

// ---- Fetch -----------------------------------------------------------------

interface ShopifyFetchOptions {
  // Quando true, ignora throttle proactivo e respeita só 429+Retry-After.
  // Padrão: false (proactivo, mais conservador).
  noThrottle?: boolean;
  // Override de tentativas em caso de 429 / 5xx. Padrão: 5.
  maxRetries?: number;
}

interface ShopifyResponse<T> {
  body: T;
  headers: Headers;
  nextPageInfo: string | null;
}

// Throttle simples: atrasa cada chamada para nunca passar 2 req/s.
// Funciona para Plus (4 req/s permitido) e Regular (2 req/s permitido).
// Phase 2 podemos ler `X-Shopify-Shop-Api-Call-Limit` para throttle adaptativo.
let lastCallAt = 0;
const MIN_INTERVAL_MS = 500;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

// Fetch a um path da Admin API. Devolve body parseado, headers e
// `nextPageInfo` (cursor para a página seguinte, ou null se não há mais).
export async function shopifyFetch<T = unknown>(
  creds: ShopifyCredentials,
  path: string,
  params?: Record<string, string | number | undefined>,
  options: ShopifyFetchOptions = {},
): Promise<ShopifyResponse<T>> {
  const { noThrottle = false, maxRetries = 5 } = options;

  // Path normalization: aceitamos 'orders.json' ou '/orders.json'
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  const url = new URL(
    `https://${creds.domain}/admin/api/${SHOPIFY_API_VERSION}/${cleanPath}`,
  );
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  let attempt = 0;
  while (true) {
    if (!noThrottle) await throttle();
    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': creds.accessToken,
        'Accept': 'application/json',
      },
    });

    if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
      attempt++;
      if (attempt > maxRetries) {
        throw new Error(
          `Shopify ${resp.status} após ${maxRetries} retries — ${url.toString()}`,
        );
      }
      const retryAfter = Number(resp.headers.get('Retry-After')) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(
        `Shopify ${resp.status} em ${cleanPath}: ${errBody.slice(0, 500)}`,
      );
    }

    const body = (await resp.json()) as T;
    return {
      body,
      headers: resp.headers,
      nextPageInfo: parseNextPageInfo(resp.headers.get('Link')),
    };
  }
}

// Shopify REST devolve cursors via Link header:
//   Link: <https://shop/admin/api/.../orders.json?page_info=XXX>; rel="next"
// Extraímos só o `page_info` da próxima página.
function parseNextPageInfo(link: string | null): string | null {
  if (!link) return null;
  const parts = link.split(',');
  for (const part of parts) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match && match[1]) {
      try {
        const u = new URL(match[1]);
        return u.searchParams.get('page_info');
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Paginação: itera todas as páginas de um endpoint coleção (`orders.json`,
// `customers.json`, etc). Yields cada page do array `key` (ex: 'orders').
//
// Importante: na primeira chamada passamos os filtros todos (updated_at_min,
// status=any, limit=250). A partir da 2ª, Shopify só aceita `page_info` +
// `limit` — o resto dos filtros está embutido no cursor.
export async function* paginateShopify<T>(
  creds: ShopifyCredentials,
  path: string,
  collectionKey: string,
  initialParams: Record<string, string | number | undefined> = {},
): AsyncGenerator<T[]> {
  let pageInfo: string | null = null;
  const limit = initialParams.limit ?? 250;

  while (true) {
    const params: Record<string, string | number | undefined> = pageInfo
      ? { limit, page_info: pageInfo }
      : { ...initialParams, limit };

    const { body, nextPageInfo } = await shopifyFetch<Record<string, T[]>>(
      creds,
      path,
      params,
    );
    const items = body[collectionKey] ?? [];
    yield items;

    if (!nextPageInfo) return;
    pageInfo = nextPageInfo;
  }
}
