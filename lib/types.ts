// Tipos partilhados entre ingest, synthesize e serve.
// Fonte de verdade para o shape dos dados. Quando uma MCP tool muda
// o seu output, actualiza aqui primeiro e depois consumidores.

export type Channel =
  | 'shopify'
  | 'meta_ads'
  | 'klaviyo'
  | 'wa'
  | 'ga4'
  | 'blog';

export type PeriodGrain = 'hour' | 'day' | 'week' | 'month';

export interface KpiSnapshot {
  empresa_id: string;
  channel: Channel;
  metric_key: string;
  period_grain: PeriodGrain;
  period_start: string; // ISO
  value: number | null;
  meta?: Record<string, unknown>;
}

export interface EtlRunInput {
  empresa_id: string;
  channel: Channel;
  range_start: string;
  range_end: string;
}

// Output shape da MCP tool `get_business_health`. Decision-ready —
// sumarizado, não raw. < 2k tokens em qualquer caso real.
export interface BusinessHealthOutput {
  empresa_id: string;
  empresa_name: string;
  generated_at: string;
  period: { start: string; end: string };
  currency: string | null;
  headline: string; // 1 frase: "estado geral em 1 frase"
  kpis: {
    revenue_30d: number | null;
    revenue_change_pct: number | null;       // ainda null — precisa 60d para comparar
    orders_30d: number | null;
    aov_30d: number | null;
    new_customers_30d: number | null;
    repeat_purchase_rate_30d: number | null; // 0..1
    // Meta Ads — base metrics e ratios
    meta_spend_30d: number | null;
    meta_impressions_30d: number | null;
    meta_clicks_30d: number | null;
    meta_ctr_30d: number | null;             // 0..1 (clicks÷impressions)
    meta_cpc_30d: number | null;             // currency
    meta_purchases_30d: number | null;       // Meta-attributed purchases
    // GA4 — traffic + last-touch attribution
    ga4_sessions_30d: number | null;
    ga4_users_30d: number | null;
    ga4_engagement_rate_30d: number | null;  // 0..1 (engaged÷sessions, weighted)
    ga4_conversions_30d: number | null;
    ga4_revenue_30d: number | null;          // GA4-attributed revenue (compare com Shopify)
    ga4_organic_sessions_30d: number | null; // sessions de Organic Search
    ga4_paid_social_sessions_30d: number | null; // sessions de Paid Social
    // Cross-channel — só preenchidos quando Shopify + Meta presentes
    cac_30d: number | null;                  // meta_spend ÷ shopify_new_customers
    roas_30d: number | null;                 // shopify_revenue ÷ meta_spend (verdadeiro)
    ltv_30d: number | null;                  // ainda null — precisa cohort
  };
  signals: Array<{
    severity: 'info' | 'warning' | 'critical';
    message: string;
    suggested_action?: string;
  }>;
  staleness: Partial<Record<Channel, string>>; // ISO timestamp do último ETL bem-sucedido por canal
}
