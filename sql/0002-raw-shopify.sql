-- 2026-05-09 — Raw tables para Shopify ingest
--
-- Padrão para todos os canais: armazenar o payload completo da API
-- em jsonb + extrair colunas-chave para permitir queries eficientes
-- sem ter de explodir o jsonb.
--
-- Idempotência: primary key = (empresa_id, external_id). Re-correr o
-- ETL faz upsert, não duplica. Quando o `updated_at` muda (refunds,
-- fulfillments, edits), o upsert actualiza a row inteira.
--
-- A camada Synthesize (lib/synthesize/shopify.ts) é que lê estas
-- tabelas e produz kpi_snapshots. Estas raw tables NÃO são expostas
-- via MCP — só os artefactos derivados.

-- ---- Orders -----------------------------------------------------------------
create table shopify_orders_raw (
  empresa_id uuid not null references empresas(id) on delete cascade,
  shopify_order_id bigint not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  financial_status text,                    -- 'paid' | 'pending' | 'refunded' | 'partially_refunded' | ...
  fulfillment_status text,                  -- 'fulfilled' | 'partial' | null
  total_price numeric,
  subtotal_price numeric,
  total_discounts numeric,
  total_tax numeric,
  currency text,
  customer_id bigint,                       -- shopify customer id (pode ser null em guest checkouts)
  email text,
  payload jsonb not null,                   -- payload completo da API (para reprocessing)
  ingested_at timestamptz default now(),
  primary key (empresa_id, shopify_order_id)
);

create index shopify_orders_raw_created on shopify_orders_raw (empresa_id, created_at desc);
create index shopify_orders_raw_updated on shopify_orders_raw (empresa_id, updated_at desc);
create index shopify_orders_raw_customer on shopify_orders_raw (empresa_id, customer_id);

-- ---- Customers --------------------------------------------------------------
create table shopify_customers_raw (
  empresa_id uuid not null references empresas(id) on delete cascade,
  shopify_customer_id bigint not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  email text,
  orders_count int,
  total_spent numeric,
  state text,                               -- 'enabled' | 'disabled' | 'invited' | 'declined'
  payload jsonb not null,
  ingested_at timestamptz default now(),
  primary key (empresa_id, shopify_customer_id)
);

create index shopify_customers_raw_created on shopify_customers_raw (empresa_id, created_at desc);
