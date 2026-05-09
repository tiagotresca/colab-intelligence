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
  headline: string; // 1 frase: "estado geral em 1 frase"
  kpis: {
    revenue_30d: number | null;
    revenue_change_pct: number | null;
    new_customers_30d: number | null;
    cac_30d: number | null;
    ltv_30d: number | null;
    roas_30d: number | null;
  };
  signals: Array<{
    severity: 'info' | 'warning' | 'critical';
    message: string;
    suggested_action?: string;
  }>;
  staleness: Partial<Record<Channel, string>>; // ISO timestamp do último ETL bem-sucedido por canal
}
