-- 2026-05-10 — Manual import foundation (Sprint 3 PR A.6)
--
-- Permite importar via upload de CSV no dashboard:
--   - Histórico Shopify completo (formato CSV nativo do Shopify export)
--   - Dados de sites custom-made em formato standard (definido em
--     docs/manual-import-format.md)
--
-- Resolve dois problemas:
--   1. read_all_orders do Shopify só dá 60d sem aprovação demorada
--   2. Sites custom-made não têm API igual ao Shopify
--
-- Cron API ETL e manual import coexistem: synth dedupe por
-- (source_platform, external_order_id), com API a ganhar sobre manual
-- quando há conflito (refunds/edits posteriores ao import).

create table manual_orders_raw (
  empresa_id uuid not null references empresas(id) on delete cascade,
  source_platform text not null,        -- 'shopify_export' | 'aquinta_custom' | 'lukydog_custom' | etc
  external_order_id text not null,      -- ID único dentro de (empresa, source_platform)

  -- Order facts (pelo menos created_at + total_price obrigatórios)
  created_at timestamptz not null,
  email text,
  total_price numeric,
  subtotal_price numeric,
  total_discounts numeric,
  total_tax numeric,
  total_shipping numeric,
  currency text,
  financial_status text,                -- 'paid' | 'refunded' | 'pending' | ...
  fulfillment_status text,
  customer_id text,                     -- external customer id (texto para flexibilidade)

  -- Discount info
  discount_codes jsonb,                 -- array livre quando o source dá structure
  primary_discount_code text,
  has_discount boolean default false,

  -- Attribution
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  landing_url text,
  referrer text,
  device text,                          -- 'mobile' | 'tablet' | 'desktop'

  -- Free-form: o que vier no CSV e não couber nos campos acima
  extra jsonb,

  imported_at timestamptz default now(),
  primary key (empresa_id, source_platform, external_order_id)
);

create index manual_orders_raw_email
  on manual_orders_raw (empresa_id, email)
  where email is not null;
create index manual_orders_raw_created
  on manual_orders_raw (empresa_id, created_at desc);
create index manual_orders_raw_platform
  on manual_orders_raw (empresa_id, source_platform);

-- Tracking: cada upload cria 1 row aqui para auditoria
create table import_runs (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid references empresas(id) on delete cascade,
  source_platform text not null,
  format text not null,                 -- 'shopify_csv' | 'standard_v1'
  filename text,
  rows_processed integer default 0,
  rows_imported integer default 0,
  rows_skipped integer default 0,
  errors jsonb,                          -- array de {line, reason} para debug
  status text default 'running',         -- 'running' | 'success' | 'failed'
  started_at timestamptz default now(),
  completed_at timestamptz
);
create index import_runs_recent on import_runs (empresa_id, started_at desc);
