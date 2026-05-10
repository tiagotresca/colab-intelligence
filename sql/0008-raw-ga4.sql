-- 2026-05-10 — Raw tables para GA4 ingest
--
-- GA4 preenche o gap de attribution que Shopify+Meta sozinhos não cobrem
-- (organic search, direct, referral, paid social last-touch, etc).
--
-- Mesmo padrão: payload jsonb completo + colunas-chave extraídas,
-- idempotente via primary key composto.
--
-- Credenciais:
--   - Property ID + Service Account JSON vivem em work.colab
--     marketing_sources (campos ga4_property_id, ga4_service_account_json,
--     ga4_measurement_id). NÃO replicar aqui.
--
-- ga4_metrics_raw: 1 row por (empresa, dia) com totais agregados.
-- ga4_channel_breakdown_raw: 1 row por (empresa, dia, channel_group)
--   com sessions/conversions/revenue por canal default GA4
--   (Direct, Organic Search, Paid Social, Email, ...).

create table ga4_metrics_raw (
  empresa_id uuid not null references empresas(id) on delete cascade,
  date_start date not null,
  property_id text not null,
  sessions bigint,
  total_users bigint,
  new_users bigint,
  engaged_sessions bigint,
  screen_page_views bigint,
  conversions numeric,                          -- pode ser fraccional (events_per_session etc)
  purchase_revenue numeric,                     -- GA4-attributed revenue
  transactions bigint,
  payload jsonb not null,
  ingested_at timestamptz default now(),
  primary key (empresa_id, date_start)
);
create index ga4_metrics_raw_date on ga4_metrics_raw (empresa_id, date_start desc);

create table ga4_channel_breakdown_raw (
  empresa_id uuid not null references empresas(id) on delete cascade,
  date_start date not null,
  property_id text not null,
  channel_group text not null,                  -- 'Direct' | 'Organic Search' | 'Paid Social' | ...
  sessions bigint,
  conversions numeric,
  purchase_revenue numeric,
  payload jsonb not null,
  ingested_at timestamptz default now(),
  primary key (empresa_id, date_start, channel_group)
);
create index ga4_channel_breakdown_raw_date on ga4_channel_breakdown_raw (empresa_id, date_start desc);
create index ga4_channel_breakdown_raw_channel on ga4_channel_breakdown_raw (empresa_id, channel_group, date_start desc);
