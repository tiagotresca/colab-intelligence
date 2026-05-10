-- 2026-05-10 — Modules: Subjects, Subscriptions, Stores, Channels (Sprint 3 PR D.1)
--
-- Architectural decision: layered data model. Core (customers, orders,
-- attribution) stays generic. Module tables são opt-in por empresa,
-- consoante o seu modelo de negócio.
--
--   Module 1: Subjects + Subscriptions  (Quinta, Luky Dog — modelo
--             subscription-with-subject onde cada subscrição é para
--             uma "thing" — cão, criança, planta, máquina)
--
--   Module 2: Stores + Channels  (O Passe — omnichannel, com pontos
--             de venda físicos + online)
--
-- Empresas podem opt-in nos módulos que se aplicam. Empresas que não
-- usem um módulo ignoram-no — tabelas ficam vazias para essa empresa.
--
-- Synthesize layer terá funções dedicadas por módulo:
--   - synthesizeSubscriptionMetrics(empresa_id) — MRR, churn, retention
--     by subject attributes
--   - synthesizeOmnichannelJourneys(empresa_id) — sequências de canais

-- ===== Module 1: Subjects + Subscriptions ===================================

-- Subjects: a "thing" que o customer compra para. Genérico — pode ser
-- cão, gato, criança, planta, máquina. attributes jsonb permite cada
-- subject_type ter o seu próprio shape sem mudar schema.
create table subjects (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  customer_email_hash text not null,        -- liga ao customer pela mesma chave que customers usa
  external_subject_id text,                 -- ID na fonte (ex: 'dog_001' do sistema do Tiago)
  subject_type text not null,               -- 'dog' | 'cat' | 'child' | 'plant' | ...
  name text,                                -- 'Bobby', 'Rex', etc
  -- Attributes específicos do tipo (breed, age_years, size, weight_kg
  -- para cães; outros para outros tipos). Estruturado em jsonb para
  -- queryability sem schema rigido.
  attributes jsonb,
  active boolean not null default true,
  created_at timestamptz,
  imported_at timestamptz default now(),
  unique (empresa_id, external_subject_id)
);
create index subjects_customer
  on subjects (empresa_id, customer_email_hash);
create index subjects_type
  on subjects (empresa_id, subject_type);
-- Index GIN para queryability de attributes específicos (ex: breed='poodle')
create index subjects_attributes_gin
  on subjects using gin (attributes);

-- Subscriptions: um plano recurrente. 1 customer pode ter N
-- subscriptions (ex: Maria tem 2 cães, 2 subscriptions, uma por cão).
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  customer_email_hash text not null,
  subject_id uuid references subjects(id) on delete set null,  -- opcional: cão a que esta sub pertence
  external_subscription_id text,
  status text not null,                     -- 'active' | 'paused' | 'cancelled'
  product_sku text,
  frequency_days int,                       -- 30 = mensal, 7 = semanal, etc
  mrr numeric,                              -- monthly recurring revenue (calculado se daily/weekly)
  started_at timestamptz not null,
  cancelled_at timestamptz,
  cancelled_reason text,                    -- 'too_expensive' | 'didnt_like_product' | 'pet_died' | 'other'
  metadata jsonb,                           -- campo livre para info adicional
  imported_at timestamptz default now(),
  unique (empresa_id, external_subscription_id)
);
create index subscriptions_customer
  on subscriptions (empresa_id, customer_email_hash);
create index subscriptions_subject
  on subscriptions (empresa_id, subject_id);
create index subscriptions_status
  on subscriptions (empresa_id, status);

-- Liga orders (de qualquer fonte raw) a subscriptions. Permite query
-- "qual o LTV de um customer adquirido pela campanha X que tem um cão
-- de raça poodle"? Joins: attribution → orders → links → subscription
-- → subject.
create table order_subscription_links (
  empresa_id uuid not null references empresas(id) on delete cascade,
  source_platform text not null,            -- 'shopify' | 'shopify_export' | 'aquinta_custom' | ...
  external_order_id text not null,
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  delivery_number int,                      -- 1 = primeira entrega, 2 = segunda, etc
  primary key (empresa_id, source_platform, external_order_id)
);
create index order_sub_links_subscription
  on order_subscription_links (empresa_id, subscription_id);

-- ===== Module 2: Stores + Channels (O Passe omnichannel) ====================

create table stores (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  external_store_id text,
  name text not null,
  store_type text not null,                 -- 'physical_pos' | 'online_store' | 'pop_up' | 'event'
  city text,
  country text,
  active boolean default true,
  imported_at timestamptz default now(),
  unique (empresa_id, external_store_id)
);
create index stores_empresa on stores (empresa_id, store_type);

-- Liga orders ao store/channel onde aconteceram. Permite query
-- "% dos novos clientes que fizeram primeira compra online voltaram
-- numa loja física no mês seguinte?"
create table order_channels (
  empresa_id uuid not null references empresas(id) on delete cascade,
  source_platform text not null,
  external_order_id text not null,
  store_id uuid references stores(id) on delete set null,
  channel_type text not null,               -- 'online' | 'pos' | 'phone' | 'partner_marketplace'
  primary key (empresa_id, source_platform, external_order_id)
);
create index order_channels_store
  on order_channels (empresa_id, store_id);
create index order_channels_type
  on order_channels (empresa_id, channel_type);
