-- 2026-05-10 — Role read-only para colab-intelligence aceder ao work.colab.
--
-- ⚠️ APLICAR NO SUPABASE DO **WORK.COLAB**, NÃO DO COLAB-INTELLIGENCE ⚠️
--
-- Motivação: hoje colab-intelligence usa a service-role key do work.colab
-- para ler `marketing_sources` (ver lib/workcolab-supabase.ts). Service-role
-- bypassa RLS e dá acesso total — se colab-intelligence for comprometido,
-- o atacante tem leitura+escrita em TODO o work.colab (tasks, comments,
-- profiles, marketing_sources com SAs/tokens, tudo).
--
-- Esta migration cria um role Postgres com SELECT-only nas 2 tabelas
-- estritamente necessárias. Depois de aplicar, segue os passos no README
-- da migration para mintar um JWT que será usado em vez da service-role.

-- ---- 1. Role com SELECT-only nas tabelas necessárias -----------------------

-- Drop se existir (idempotente)
drop role if exists colab_intelligence_reader;

create role colab_intelligence_reader nologin noinherit;

-- Schema access
grant usage on schema public to colab_intelligence_reader;

-- SELECT-only nas tabelas que colab-intelligence consome
grant select on public.marketing_sources to colab_intelligence_reader;
grant select on public.projects          to colab_intelligence_reader;

-- Permitir que o `authenticator` (role que processa requests JWT em PostgREST)
-- assuma este role quando o token tiver claim `role: 'colab_intelligence_reader'`
grant colab_intelligence_reader to authenticator;

-- ---- 2. Próximos passos (manual) -------------------------------------------
--
-- Depois de aplicar este SQL no Supabase do work.colab:
--
-- a) Vai a Supabase Dashboard (work.colab) → Project Settings → API → JWT Settings.
--    Copia o "JWT Secret" (string longa, mantém-na privada).
--
-- b) No colab-intelligence, mintar o JWT:
--      cd ~/Desktop/colab-intelligence
--      WORKCOLAB_JWT_SECRET="<jwt-secret-do-passo-a>" npm run mint:workcolab-jwt
--    Vai imprimir um JWT. Esse JWT é o WORKCOLAB_SUPABASE_READONLY_KEY.
--
-- c) Setar no Vercel do colab-intelligence:
--      vercel env add WORKCOLAB_SUPABASE_READONLY_KEY production preview
--    (cola o JWT do passo b)
--
-- d) Remover (rotacionar) a service-role key antiga do Vercel:
--      vercel env rm WORKCOLAB_SUPABASE_SERVICE_ROLE_KEY production preview
--
-- e) Redeploy → testar → confirmar que ETLs ainda lêem credenciais OK.
