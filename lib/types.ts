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
    revenue_change_pct: number | null;       // Phase 2 — precisa 60d para comparar
    orders_30d: number | null;
    aov_30d: number | null;
    new_customers_30d: number | null;
    repeat_purchase_rate_30d: number | null; // 0..1
    cac_30d: number | null;                  // Phase 2 — precisa Meta Ads
    ltv_30d: number | null;                  // Phase 2 — precisa cohort
    roas_30d: number | null;                 // Phase 2 — precisa Meta Ads
  };
  signals: Array<{
    severity: 'info' | 'warning' | 'critical';
    message: string;
    suggested_action?: string;
  }>;
  staleness: Partial<Record<Channel, string>>; // ISO timestamp do último ETL bem-sucedido por canal
}
