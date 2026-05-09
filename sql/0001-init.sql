-- 2026-05-09 — Schema inicial colab-intelligence
--
-- Esta DB é SEPARADA do work.colab. Mantém só o que precisa para
-- analítica + RAG + drafts de tarefas. Source of truth para `empresas`
-- (id, name) é o work.colab; aqui só guardamos uma cópia para evitar
-- joins cross-DB e ter foreign keys.

create extension if not exists vector;
create extension if not exists pgcrypto;  -- gen_random_uuid

-- Empresas (mirror do work.colab projects.id+name)
-- Sync via cron periódico ou trigger no work.colab.
create table empresas (
  id uuid primary key,
  name text not null,
  synced_at timestamptz default now()
);

-- Tracking de runs de ETL: cada chamada a /api/ingest/* cria uma row
-- aqui. Permite saber o que falhou, retomar incrementais e calcular
-- staleness por canal/empresa.
create table etl_runs (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid references empresas(id) on delete cascade,
  channel text not null,                    -- 'shopify' | 'meta_ads' | 'klaviyo' | 'wa' | 'ga4' | 'blog'
  status text not null default 'running',   -- 'running' | 'success' | 'failed'
  started_at timestamptz default now(),
  completed_at timestamptz,
  rows_ingested int default 0,
  error_message text,
  range_start timestamptz,                  -- janela do incremental
  range_end timestamptz
);
create index etl_runs_lookup on etl_runs (empresa_id, channel, started_at desc);
create index etl_runs_failed on etl_runs (status, started_at desc) where status = 'failed';

-- KPIs derivados, time-series. Granularidade configurável (`period_grain`).
-- Unique constraint garante idempotência: re-correr o ETL para o mesmo
-- período faz upsert, não duplica.
create table kpi_snapshots (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid references empresas(id) on delete cascade,
  channel text not null,
  metric_key text not null,                 -- 'cac', 'ltv_30d', 'roas', 'open_rate', etc.
  period_grain text not null,               -- 'hour' | 'day' | 'week' | 'month'
  period_start timestamptz not null,
  value numeric,
  meta jsonb,                               -- breakdown / supporting data
  computed_at timestamptz default now()
);
create unique index kpi_snapshots_uq
  on kpi_snapshots (empresa_id, channel, metric_key, period_grain, period_start);
create index kpi_snapshots_recent
  on kpi_snapshots (empresa_id, channel, period_start desc);

-- Creative library: ads, emails, fluxos WA, landing pages, blog posts.
-- Cada asset tem embedding para RAG semântico ("hooks vencedores
-- para audiência similar"). Outcome metrics preenchidos depois pelo
-- eval loop (Fase 2-3).
create table creative_assets (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid references empresas(id) on delete cascade,
  channel text not null,                    -- 'meta_ad' | 'email' | 'wa_flow' | 'landing' | 'blog'
  asset_type text not null,                 -- 'image_ad' | 'video_ad' | 'subject' | 'body' | 'flow' | etc.
  external_id text,                         -- ID no canal de origem
  title text,
  content text,                             -- texto principal (usado para embedding)
  meta jsonb,                               -- tags, audience, hook category, restrições de marca
  embedding vector(1024),                   -- Voyage voyage-3 = 1024 dims (ajustar se mudar provider)
  outcome_metrics jsonb,                    -- { ctr: 0.024, cpa: 12.50, ... }
  outcome_score numeric,                    -- normalized 0-1, "este asset foi vencedor?"
  created_at timestamptz default now(),
  outcome_updated_at timestamptz
);
create index creative_assets_lookup on creative_assets (empresa_id, channel, asset_type);
create index creative_assets_winners on creative_assets (empresa_id, channel, outcome_score desc nulls last);
-- Vector index — recriar quando tabela tiver dados (ivfflat precisa de samples)
-- create index creative_assets_embedding on creative_assets using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Snapshots periódicos do estado do negócio (sintetizados, não raw).
-- Gerados pela camada de synthesize (cron semanal/mensal).
create table business_snapshots (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid references empresas(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  summary text,                             -- prose ~500 words, decision-ready
  kpis_json jsonb,                          -- KPI block estruturado
  signals_json jsonb,                       -- anomalias / oportunidades detectadas
  generated_at timestamptz default now()
);
create unique index business_snapshots_uq
  on business_snapshots (empresa_id, period_start, period_end);
create index business_snapshots_recent on business_snapshots (empresa_id, period_end desc);

-- Drafts de tarefas geradas pelo agente autónomo. Antes de irem para
-- pendentes do work.colab passam por aqui — assim podemos fazer eval
-- sem depender do work.colab para o tracking.
create table task_drafts (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid references empresas(id) on delete cascade,
  draft_version text not null default 'v1', -- versão do template/prompt
  context_bundle jsonb not null,            -- snapshot do contexto que levou a este draft
  payload jsonb not null,                   -- { title, desc, bloco, priority, hooks: [], etc. }
  status text not null default 'pending',   -- 'pending' | 'pushed' | 'rejected_by_agent'
  pushed_to_workcolab_task_id uuid,         -- task ID no work.colab depois do push
  pushed_at timestamptz,
  created_at timestamptz default now()
);
create index task_drafts_status on task_drafts (status, created_at desc);

-- Eval loop: tracking de aceitação + outcomes
create table eval_outcomes (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid references task_drafts(id) on delete cascade,
  acceptance text,                          -- 'as_is' | 'edited_lightly' | 'edited_heavily' | 'rejected'
  edited_diff jsonb,                        -- diff entre draft e a tarefa final
  performance_metrics jsonb,                -- métricas de execução (CTR, opens, conversions)
  measured_at timestamptz
);
create index eval_outcomes_draft on eval_outcomes (draft_id);
