-- 2026-05-10 — Customers Foundation (Sprint 3 PR A.5)
--
-- Tabela canónica `customers` agnóstica de plataforma. Source of truth
-- para tudo o que é cliente: lifetime aggregates, acquisition do
-- primeiro order, qualidade computada.
--
-- Alimentada a partir de raw tables platform-specific:
--   shopify_customers_raw + shopify_orders_raw + shopify_order_attribution → customers (platform='shopify')
--   custom_site_customers_raw + custom_site_orders_raw → customers (platform='custom_site')   [futuro]
--   klaviyo_profiles_raw → customers (platform='klaviyo')                                      [futuro]
--
-- Dedup decision (2026-05-10): 1 customer por (empresa, platform, email).
-- Mesmo email em 2 plataformas da mesma empresa = 2 rows distintas.
-- Mantém vista granular por plataforma. Cross-platform LTV consolidation
-- pode ser feita on-the-fly em queries quando necessário.
--
-- Why uma tabela em vez de várias platform-specific:
-- - Uma só lista de "customers da empresa X" sem unions
-- - Customer Quality Engine queries só esta tabela
-- - Acquisition source/medium/campaign canonicalizados aqui (não no raw)
--
-- Idempotente: synthesize recomputa de raw, upsert por chave única.

create table customers (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  platform text not null,                  -- 'shopify' | 'custom_site' | 'klaviyo' | ...

  -- Identity
  email_hash text not null,                -- sha256(lower(trim(email)))
  email text,                              -- raw, mantido para conveniência (não é chave)
  phone text,
  external_customer_id text,               -- ID do customer na plataforma de origem (string para uniformizar)

  -- Lifetime aggregates (recomputados a cada synthesize a partir do raw)
  first_order_at timestamptz,
  last_order_at timestamptz,
  orders_count integer not null default 0,
  total_revenue numeric not null default 0,

  -- Acquisition (do PRIMEIRO order, derivado via shopify_order_attribution)
  acquisition_source text,                 -- 'google' | 'instagram' | 'direct' | ...
  acquisition_medium text,                 -- 'cpc' | 'social' | 'referral' | ...
  acquisition_campaign text,
  acquisition_landing_site text,
  acquisition_discount_code text,
  acquisition_first_touch_confidence text, -- 'high' (UTMs) | 'medium' (referrer) | 'low' (só source_name/direct)

  -- Quality (preenchido pelo Customer Quality Engine em PR B)
  projected_ltv numeric,

  synced_at timestamptz default now(),
  unique (empresa_id, platform, email_hash)
);

create index customers_empresa_first_order
  on customers (empresa_id, first_order_at desc);
create index customers_empresa_acq_source
  on customers (empresa_id, acquisition_source);
create index customers_empresa_platform
  on customers (empresa_id, platform);
