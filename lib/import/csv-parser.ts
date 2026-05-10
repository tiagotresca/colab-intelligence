// CSV parsing wrapper sobre papaparse + adapters por formato.
//
// Dois formatos suportados em v1:
//   - 'shopify_csv'  — formato nativo do Shopify Export (Admin → Orders → Export)
//                      Cada line item é uma linha no CSV. Agrupamos por order Id
//                      e mantemos só o primeiro (order-level fields são iguais
//                      em todas as linhas do mesmo order).
//   - 'standard_v1'  — formato standard que definimos para sites custom.
//                      Ver docs/manual-import-format.md.
//
// Adicionar novo formato = nova função parse<X>Format. Adapter = transformar
// linhas do CSV para o shape ParsedOrder.

import Papa from 'papaparse';

export interface ParsedOrder {
  external_order_id: string;
  created_at: string;                // ISO string
  email: string | null;
  total_price: number | null;
  subtotal_price: number | null;
  total_discounts: number | null;
  total_tax: number | null;
  total_shipping: number | null;
  currency: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  customer_id: string | null;
  discount_codes: unknown[] | null;
  primary_discount_code: string | null;
  has_discount: boolean;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  landing_url: string | null;
  referrer: string | null;
  device: string | null;
  extra: Record<string, unknown> | null;
}

export interface ParseResult {
  orders: ParsedOrder[];
  errors: Array<{ line: number; reason: string }>;
  rows_processed: number;
}

export type SupportedFormat = 'shopify_csv' | 'standard_v1';

// ---- Helpers ----------------------------------------------------------------

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function trimOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function detectDeviceFromUA(ua: string | null): string | null {
  if (!ua) return null;
  const lower = ua.toLowerCase();
  if (/ipad|android(?!.*mobile)|tablet/.test(lower)) return 'tablet';
  if (/iphone|ipod|android.*mobile|mobile|blackberry|opera mini/.test(lower)) return 'mobile';
  return 'desktop';
}

function parseUtmFromUrl(url: string | null): {
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
  if (!url) return empty;
  try {
    const u = new URL(url, 'https://placeholder.invalid');
    return {
      utm_source: u.searchParams.get('utm_source') || null,
      utm_medium: u.searchParams.get('utm_medium') || null,
      utm_campaign: u.searchParams.get('utm_campaign') || null,
      utm_content: u.searchParams.get('utm_content') || null,
      utm_term: u.searchParams.get('utm_term') || null,
    };
  } catch {
    return empty;
  }
}

function parseDate(s: unknown): string | null {
  if (!s) return null;
  const str = String(s).trim();
  if (!str) return null;
  // Aceita ISO ou formato Shopify "YYYY-MM-DD HH:MM:SS +0000"
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ---- Shopify CSV adapter ----------------------------------------------------
// Shopify export tem 1 row por LINE ITEM. Order-level fields repetem-se
// em cada linha do mesmo order. Agrupamos por Id (ou Name se Id em falta)
// e mantemos só a primeira ocorrência.
//
// Colunas conhecidas que extraímos:
//   - Id (numérico) → preferred external_order_id (mais estável que Name)
//   - Name (#1001)   → fallback se Id estiver vazio
//   - Email
//   - Created at
//   - Total
//   - Subtotal
//   - Discount Amount
//   - Taxes
//   - Shipping
//   - Currency
//   - Financial Status
//   - Fulfillment Status
//   - Discount Code
//   - Source (custom field se Shopify export incluir)
//   - Browser User Agent (custom field)
//   - Landing site (custom field) / Referring site (custom field)
//   - Note Attributes (string com formato "key: value\nkey: value")
//
// Tudo o que não conhecermos vai para `extra` jsonb.

function parseShopifyRow(
  row: Record<string, string>,
  rowExtra: Record<string, unknown>,
): ParsedOrder | null {
  const externalId = trimOrNull(row['Id']) ?? trimOrNull(row['Name']);
  if (!externalId) return null;

  const created = parseDate(row['Created at']);
  if (!created) return null;

  const discountCode = trimOrNull(row['Discount Code']);
  const landingUrl = trimOrNull(row['Landing site']) ?? trimOrNull(row['Landing Site']);
  const referrer = trimOrNull(row['Referring site']) ?? trimOrNull(row['Referring Site']);
  const userAgent = trimOrNull(row['Browser User Agent']) ?? trimOrNull(row['User Agent']);

  const utms = parseUtmFromUrl(landingUrl);

  return {
    external_order_id: externalId,
    created_at: created,
    email: trimOrNull(row['Email']),
    total_price: num(row['Total']),
    subtotal_price: num(row['Subtotal']),
    total_discounts: num(row['Discount Amount']),
    total_tax: num(row['Taxes']),
    total_shipping: num(row['Shipping']),
    currency: trimOrNull(row['Currency']),
    financial_status: trimOrNull(row['Financial Status']),
    fulfillment_status: trimOrNull(row['Fulfillment Status']),
    customer_id: null, // Shopify CSV típico não inclui customer Id
    discount_codes: discountCode ? [{ code: discountCode, amount: num(row['Discount Amount']) }] : null,
    primary_discount_code: discountCode,
    has_discount: !!discountCode,
    utm_source: utms.utm_source,
    utm_medium: utms.utm_medium,
    utm_campaign: utms.utm_campaign,
    utm_content: utms.utm_content,
    utm_term: utms.utm_term,
    landing_url: landingUrl,
    referrer,
    device: detectDeviceFromUA(userAgent),
    extra: Object.keys(rowExtra).length > 0 ? rowExtra : null,
  };
}

// ---- Standard v1 adapter ----------------------------------------------------
// Formato definido por nós para sites custom — direct mapping coluna→campo.

function parseStandardRow(
  row: Record<string, string>,
  rowExtra: Record<string, unknown>,
): ParsedOrder | null {
  const externalId = trimOrNull(row['external_order_id']);
  if (!externalId) return null;

  const created = parseDate(row['created_at']);
  if (!created) return null;

  return {
    external_order_id: externalId,
    created_at: created,
    email: trimOrNull(row['email']),
    total_price: num(row['total_price']),
    subtotal_price: num(row['subtotal_price']),
    total_discounts: num(row['total_discounts']),
    total_tax: num(row['total_tax']),
    total_shipping: num(row['total_shipping']),
    currency: trimOrNull(row['currency']),
    financial_status: trimOrNull(row['financial_status']),
    fulfillment_status: trimOrNull(row['fulfillment_status']),
    customer_id: trimOrNull(row['external_customer_id']) ?? trimOrNull(row['customer_id']),
    discount_codes: null,
    primary_discount_code: trimOrNull(row['discount_code']),
    has_discount: !!trimOrNull(row['discount_code']),
    utm_source: trimOrNull(row['utm_source']),
    utm_medium: trimOrNull(row['utm_medium']),
    utm_campaign: trimOrNull(row['utm_campaign']),
    utm_content: trimOrNull(row['utm_content']),
    utm_term: trimOrNull(row['utm_term']),
    landing_url: trimOrNull(row['landing_url']),
    referrer: trimOrNull(row['referrer']),
    device: trimOrNull(row['device']),
    extra: Object.keys(rowExtra).length > 0 ? rowExtra : null,
  };
}

// ---- Main entry -------------------------------------------------------------

const KNOWN_SHOPIFY_FIELDS = new Set([
  'Id', 'Name', 'Email', 'Created at', 'Total', 'Subtotal',
  'Discount Amount', 'Taxes', 'Shipping', 'Currency',
  'Financial Status', 'Fulfillment Status', 'Discount Code',
  'Landing site', 'Referring site', 'Browser User Agent',
  'Lineitem name', 'Lineitem quantity', 'Lineitem price', 'Lineitem sku',
  'Note Attributes',
]);

const KNOWN_STANDARD_FIELDS = new Set([
  'external_order_id', 'created_at', 'email', 'total_price',
  'subtotal_price', 'total_discounts', 'total_tax', 'total_shipping',
  'currency', 'financial_status', 'fulfillment_status',
  'external_customer_id', 'customer_id', 'discount_code',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'landing_url', 'referrer', 'device',
]);

export function parseOrdersCsv(
  csvContent: string,
  format: SupportedFormat,
): ParseResult {
  const result = Papa.parse<Record<string, string>>(csvContent, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });

  const errors: Array<{ line: number; reason: string }> = [];
  if (result.errors.length > 0) {
    for (const e of result.errors) {
      errors.push({ line: (e.row ?? 0) + 2, reason: e.message });
    }
  }

  const rows = result.data ?? [];
  const knownFields = format === 'shopify_csv' ? KNOWN_SHOPIFY_FIELDS : KNOWN_STANDARD_FIELDS;

  // Dedup by external_order_id (Shopify especialmente: 1 row por line item)
  const ordersById = new Map<string, ParsedOrder>();
  let i = 0;
  for (const row of rows) {
    i++;
    // Build extra: campos que não estão na known list
    const rowExtra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (!knownFields.has(k) && v !== '' && v !== null && v !== undefined) {
        rowExtra[k] = v;
      }
    }

    let parsed: ParsedOrder | null = null;
    try {
      parsed = format === 'shopify_csv'
        ? parseShopifyRow(row, rowExtra)
        : parseStandardRow(row, rowExtra);
    } catch (err) {
      errors.push({
        line: i + 1,
        reason: err instanceof Error ? err.message : 'parse error',
      });
      continue;
    }

    if (!parsed) {
      errors.push({
        line: i + 1,
        reason: 'missing required fields (external_order_id and/or created_at)',
      });
      continue;
    }

    if (!ordersById.has(parsed.external_order_id)) {
      ordersById.set(parsed.external_order_id, parsed);
    }
    // Se já existe, ignoramos (line items repetidos do mesmo order)
  }

  return {
    orders: Array.from(ordersById.values()),
    errors,
    rows_processed: rows.length,
  };
}
