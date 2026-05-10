-- 2026-05-10 — Raw tables para Meta Ads ingest
--
-- Mesmo padrão de Shopify: payload jsonb completo + colunas-chave
-- extraídas. Idempotente via primary key composto.
--
-- meta_ads_campaigns_raw: cada campanha (incluindo paused/archived)
--   com metadata + budgets. Re-fetch refresca tudo.
-- meta_ads_insights_raw: breakdown DIÁRIO por campanha com métricas
--   chave (spend, impressions, clicks, conversions). É daqui que o
--   Synthesize agrega em kpi_snapshots.

create table meta_ads_campaigns_raw (
  empresa_id uuid not null references empresas(id) on delete cascade,
  campaign_id text not null,                  -- Meta IDs vêm como strings na API
  ad_account_id text not null,                -- 'act_<id>'
  name text,
  objective text,                             -- 'OUTCOME_SALES' | 'OUTCOME_LEADS' | ...
  status text,                                -- 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED'
  effective_status text,
  created_time timestamptz,
  updated_time timestamptz,
  daily_budget numeric,                       -- account currency, em cents (Meta)
  lifetime_budget numeric,
  payload jsonb not null,
  ingested_at timestamptz default now(),
  primary key (empresa_id, campaign_id)
);
create index meta_ads_campaigns_raw_status on meta_ads_campaigns_raw (empresa_id, status);

create table meta_ads_insights_raw (
  empresa_id uuid not null references empresas(id) on delete cascade,
  campaign_id text not null,
  ad_account_id text not null,
  date_start date not null,                   -- ISO date para o dia
  spend numeric,
  impressions bigint,
  reach bigint,
  clicks bigint,
  unique_clicks bigint,
  ctr numeric,                                -- Meta-computed (clicks/impressions × 100)
  cpc numeric,
  cpm numeric,
  frequency numeric,
  -- Action breakdowns mais úteis extraídos do array `actions`/`action_values`
  -- Os outros (lead, view_content, etc) ficam no payload jsonb completo.
  purchases bigint,                           -- count de action_type='purchase'
  purchases_value numeric,                    -- soma de action_values para purchase (Meta-attributed revenue)
  add_to_carts bigint,
  initiated_checkouts bigint,
  payload jsonb not null,
  ingested_at timestamptz default now(),
  primary key (empresa_id, campaign_id, date_start)
);
create index meta_ads_insights_raw_date on meta_ads_insights_raw (empresa_id, date_start desc);
