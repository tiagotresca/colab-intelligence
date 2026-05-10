-- 2026-05-10 — CHECK constraints em colunas de texto-livre.
--
-- channel/status/period_grain/acceptance estavam como `text` sem constraint —
-- typo silencioso (e.g. 'meta_ad' vs 'meta_ads') passa no INSERT e contamina
-- queries downstream. Agora valida no DB.
--
-- Valores enumerados aqui devem bater 1:1 com lib/types.ts (Channel,
-- PeriodGrain) e com os strings literais usados em ingest/synth/serve.

-- ---- etl_runs ---------------------------------------------------------------

alter table etl_runs
  add constraint etl_runs_channel_check
  check (channel in ('shopify', 'meta_ads', 'klaviyo', 'wa', 'ga4', 'blog'));

alter table etl_runs
  add constraint etl_runs_status_check
  check (status in ('running', 'success', 'failed'));

-- ---- kpi_snapshots ----------------------------------------------------------

alter table kpi_snapshots
  add constraint kpi_snapshots_channel_check
  check (channel in ('shopify', 'meta_ads', 'klaviyo', 'wa', 'ga4', 'blog'));

alter table kpi_snapshots
  add constraint kpi_snapshots_period_grain_check
  check (period_grain in ('hour', 'day', 'week', 'month'));

-- ---- creative_assets --------------------------------------------------------
-- Nota: domínio diferente do etl_runs.channel — aqui é tipo de asset criativo,
-- não um canal de ingest. Mantemos colunas separadas mas reutilizamos o nome
-- `channel` que já está no schema.

alter table creative_assets
  add constraint creative_assets_channel_check
  check (channel in ('meta_ad', 'email', 'wa_flow', 'landing', 'blog'));

-- ---- task_drafts ------------------------------------------------------------

alter table task_drafts
  add constraint task_drafts_status_check
  check (status in ('pending', 'pushed', 'rejected_by_agent'));

-- ---- eval_outcomes ----------------------------------------------------------

alter table eval_outcomes
  add constraint eval_outcomes_acceptance_check
  check (
    acceptance is null
    or acceptance in ('as_is', 'edited_lightly', 'edited_heavily', 'rejected')
  );

notify pgrst, 'reload schema';
