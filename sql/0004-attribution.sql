-- 2026-05-10 — Attribution layer (Sprint 3 v1)
--
-- Tabela 1:1 com shopify_orders_raw que extrai e normaliza os campos
-- de atribuição que já vêm no payload do Shopify Admin API:
--
--   - landing_site, referring_site, source_name → fonte/medium derivados
--   - UTMs parseadas a partir de landing_site URL params
--   - discount_codes para detectar promoções/influencer codes
--   - device hint a partir do user_agent
--
-- Why separada do raw: raw é fiel à API, atribuição é interpretação
-- nossa. Permite re-derivar (mudar regras de mapping) sem re-ingerir.
-- Idempotente via primary key composto.
--
-- O que NÃO está aqui (precisa instrumentação adicional, ver
-- docs/vision-attribution-engine.md):
--   - creative_id / ad_id / adset_id (precisa Meta CAPI)
--   - landing page URL completa pós-SPA navigation
--   - WhatsApp entry point custom flag
--   - Affiliate / influencer separados de discount code

create table shopify_order_attribution (
  empresa_id uuid not null references empresas(id) on delete cascade,
  shopify_order_id bigint not null,

  -- Raw fields extraídos directamente do payload
  landing_site text,
  referring_site text,
  source_name text,                 -- 'web' | 'instagram' | 'facebook' | 'shopify_draft_order' | ...
  source_identifier text,           -- ID da plataforma de origem (quando aplicável)

  -- UTMs parseadas a partir de landing_site URL query string
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,

  -- Derived first-touch (priority: utm_source → referring_site domain → source_name → 'direct')
  first_touch_source text not null default 'direct',
  first_touch_medium text,           -- 'cpc' | 'social' | 'referral' | 'organic' | etc

  -- Discount codes do order (jsonb array de {code, amount, type})
  discount_codes jsonb,
  has_discount boolean not null default false,
  primary_discount_code text,        -- código primeiro discount aplicado, para joins fáceis

  -- Device a partir do user_agent
  device text,                       -- 'mobile' | 'tablet' | 'desktop' | null

  -- Note attributes capturados por tracking scripts (alguns shops
  -- guardam aqui campos custom de atribuição). Mantemos jsonb para
  -- futuro parsing sem mexer no schema.
  note_attributes jsonb,

  computed_at timestamptz default now(),
  primary key (empresa_id, shopify_order_id)
);

create index shopify_order_attribution_first_touch
  on shopify_order_attribution (empresa_id, first_touch_source);
create index shopify_order_attribution_utm_campaign
  on shopify_order_attribution (empresa_id, utm_campaign)
  where utm_campaign is not null;
create index shopify_order_attribution_discount
  on shopify_order_attribution (empresa_id, primary_discount_code)
  where primary_discount_code is not null;
