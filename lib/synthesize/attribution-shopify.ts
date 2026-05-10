// Attribution layer — Shopify.
//
// Lê shopify_orders_raw.payload (jsonb) e extrai/normaliza campos de
// atribuição para shopify_order_attribution. Mapeamento 1:1 (não
// agrega), mas conta como camada Synthesize porque deriva conhecimento
// novo a partir do raw — permite re-derivar mudando regras sem voltar
// ao Shopify.
//
// Idempotente via primary key (empresa_id, shopify_order_id).
// Re-correr é seguro e barato.

import { supabase } from '../supabase.js';
import { assertNoLimitHit } from '../util/limits.js';

interface NoteAttribute {
  name: string;
  value: string;
}

interface DiscountCode {
  code: string;
  amount?: string;
  type?: string;
}

interface OrderRaw {
  shopify_order_id: number;
  payload: Record<string, unknown>;
}

interface ShopifyPayload {
  landing_site?: string | null;
  referring_site?: string | null;
  source_name?: string | null;
  source_identifier?: string | null;
  discount_codes?: DiscountCode[] | null;
  note_attributes?: NoteAttribute[] | null;
  client_details?: {
    user_agent?: string | null;
    browser_ip?: string | null;
  } | null;
}

interface AttributionRow {
  empresa_id: string;
  shopify_order_id: number;
  landing_site: string | null;
  referring_site: string | null;
  source_name: string | null;
  source_identifier: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  first_touch_source: string;
  first_touch_medium: string | null;
  discount_codes: DiscountCode[] | null;
  has_discount: boolean;
  primary_discount_code: string | null;
  device: string | null;
  note_attributes: NoteAttribute[] | null;
}

export interface DeriveAttributionResult {
  rows_derived: number;
  rows_skipped: number;
}

// ---- Parse helpers ----------------------------------------------------------

function parseUtmsFromUrl(landing_site: string | null | undefined): {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
} {
  const empty = {
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
  };
  if (!landing_site) return empty;
  try {
    // landing_site pode ser absoluta ou relativa. URL constructor
    // aceita base para relativas. Usamos uma base placeholder.
    const url = new URL(landing_site, 'https://placeholder.invalid');
    return {
      utm_source: url.searchParams.get('utm_source') || null,
      utm_medium: url.searchParams.get('utm_medium') || null,
      utm_campaign: url.searchParams.get('utm_campaign') || null,
      utm_content: url.searchParams.get('utm_content') || null,
      utm_term: url.searchParams.get('utm_term') || null,
    };
  } catch {
    return empty;
  }
}

function normalizeReferringDomain(referring_site: string | null | undefined): string | null {
  if (!referring_site) return null;
  try {
    const url = new URL(referring_site);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    // Mapeamento conservador para domínios comuns
    if (host.includes('google.')) return 'google';
    if (host.includes('facebook.com') || host.includes('fb.com')) return 'facebook';
    if (host.includes('instagram.com')) return 'instagram';
    if (host.includes('tiktok.com')) return 'tiktok';
    if (host.includes('youtube.com') || host === 'youtu.be') return 'youtube';
    if (host.includes('whatsapp.com') || host === 'wa.me') return 'whatsapp';
    if (host.includes('linkedin.com')) return 'linkedin';
    if (host.includes('twitter.com') || host === 't.co' || host.includes('x.com')) return 'twitter';
    if (host.includes('pinterest.com')) return 'pinterest';
    if (host.includes('bing.com')) return 'bing';
    if (host.includes('duckduckgo.com')) return 'duckduckgo';
    return host; // fallback ao domínio cru
  } catch {
    return null;
  }
}

function deriveFirstTouchSource(
  utm_source: string | null,
  referring_site: string | null,
  source_name: string | null,
): string {
  if (utm_source) return utm_source.toLowerCase();
  const referrer = normalizeReferringDomain(referring_site);
  if (referrer) return referrer;
  // source_name 'web' significa apenas que veio do storefront — não é origem útil
  if (source_name && source_name !== 'web') return source_name.toLowerCase();
  return 'direct';
}

function deriveFirstTouchMedium(
  utm_medium: string | null,
  source_name: string | null,
  referring_site: string | null,
): string | null {
  if (utm_medium) return utm_medium.toLowerCase();
  // Heurísticas conservadoras
  if (source_name === 'instagram' || source_name === 'facebook') return 'social';
  if (source_name === 'pos') return 'pos';
  if (referring_site) return 'referral';
  return null;
}

function detectDevice(user_agent: string | null | undefined): string | null {
  if (!user_agent) return null;
  const ua = user_agent.toLowerCase();
  // Tablet check primeiro porque alguns tablets contêm "mobile" no UA
  if (/ipad|android(?!.*mobile)|tablet/.test(ua)) return 'tablet';
  if (/iphone|ipod|android.*mobile|mobile|blackberry|opera mini/.test(ua)) return 'mobile';
  return 'desktop';
}

function buildAttributionRow(empresa_id: string, order: OrderRaw): AttributionRow {
  const p = (order.payload || {}) as ShopifyPayload;
  const utms = parseUtmsFromUrl(p.landing_site);
  const referrer_norm = normalizeReferringDomain(p.referring_site ?? null);
  const first_touch_source = deriveFirstTouchSource(
    utms.utm_source,
    p.referring_site ?? null,
    p.source_name ?? null,
  );
  const first_touch_medium = deriveFirstTouchMedium(
    utms.utm_medium,
    p.source_name ?? null,
    p.referring_site ?? null,
  );
  const discount_codes = Array.isArray(p.discount_codes) ? p.discount_codes : null;
  const has_discount = !!(discount_codes && discount_codes.length > 0);
  const primary_discount_code = has_discount && discount_codes![0]?.code
    ? discount_codes![0].code
    : null;
  const note_attributes = Array.isArray(p.note_attributes) ? p.note_attributes : null;

  // Override de first_touch_source quando temos referrer normalizado
  // mas sem UTM (referrer_norm tem precedência sobre source_name)
  const final_first_touch_source = utms.utm_source
    ? utms.utm_source.toLowerCase()
    : referrer_norm
      ? referrer_norm
      : first_touch_source;

  return {
    empresa_id,
    shopify_order_id: order.shopify_order_id,
    landing_site: p.landing_site ?? null,
    referring_site: p.referring_site ?? null,
    source_name: p.source_name ?? null,
    source_identifier: p.source_identifier ?? null,
    utm_source: utms.utm_source,
    utm_medium: utms.utm_medium,
    utm_campaign: utms.utm_campaign,
    utm_content: utms.utm_content,
    utm_term: utms.utm_term,
    first_touch_source: final_first_touch_source,
    first_touch_medium,
    discount_codes,
    has_discount,
    primary_discount_code,
    device: detectDevice(p.client_details?.user_agent ?? null),
    note_attributes,
  };
}

// ---- Main entry -------------------------------------------------------------

const BATCH_SIZE = 500;

export async function deriveAttributionShopify(
  empresa_id: string,
): Promise<DeriveAttributionResult> {
  // Fetch all orders for this empresa. Para empresas grandes (>50k orders)
  // paginar via .range() — versão actual processa até 50k de uma vez.
  const { data: ordersData, error: ordersErr } = await supabase
    .from('shopify_orders_raw')
    .select('shopify_order_id, payload')
    .eq('empresa_id', empresa_id)
    .limit(50000);

  if (ordersErr) {
    throw new Error(`derive attribution fetch orders: ${ordersErr.message}`);
  }
  assertNoLimitHit(ordersData, 50000, `attribution shopify fetch orders ${empresa_id}`);
  const orders = (ordersData ?? []) as OrderRaw[];

  if (orders.length === 0) {
    return { rows_derived: 0, rows_skipped: 0 };
  }

  let derived = 0;
  let skipped = 0;

  for (let i = 0; i < orders.length; i += BATCH_SIZE) {
    const batch = orders.slice(i, i + BATCH_SIZE);
    const rows = batch
      .map((o) => {
        try {
          return buildAttributionRow(empresa_id, o);
        } catch {
          skipped++;
          return null;
        }
      })
      .filter((r): r is AttributionRow => r !== null);

    if (rows.length === 0) continue;

    const { error: upsertErr } = await supabase
      .from('shopify_order_attribution')
      .upsert(rows, { onConflict: 'empresa_id,shopify_order_id' });
    if (upsertErr) {
      throw new Error(`upsert attribution: ${upsertErr.message}`);
    }
    derived += rows.length;
  }

  return { rows_derived: derived, rows_skipped: skipped };
}
