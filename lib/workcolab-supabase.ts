// Cliente read-only para a Supabase do work.colab.
//
// Source of truth para credenciais por empresa (Shopify, Meta Ads,
// Klaviyo, etc) é o work.colab — vive na tabela `marketing_sources`.
// Esta layer só LÊ. Nunca escrever aqui — operacional vs analítico
// têm DBs separadas precisamente para evitar coupling.
//
// Importante: este NÃO é o cliente principal do colab-intelligence.
// Para tudo o resto usar `lib/supabase.ts` (a NOSSA DB).
//
// TODO (segurança): substituir service-role por JWT com Postgres role
// `colab_intelligence_reader` (SELECT-only em marketing_sources + projects).
// A infra SQL já está pronta em `sql/external/work-colab-readonly-role.sql`
// e o mintador em `scripts/mint-workcolab-readonly-jwt.ts`. Foi adiado a
// 2026-05-10 por dificuldades a debugar "Invalid API key" — retomar quando
// houver tempo para validar end-to-end.

import { createClient } from '@supabase/supabase-js';

const url = process.env.WORKCOLAB_SUPABASE_URL;
const serviceKey = process.env.WORKCOLAB_SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  throw new Error(
    'WORKCOLAB_SUPABASE_URL e WORKCOLAB_SUPABASE_SERVICE_ROLE_KEY são obrigatórios — copia da Vercel do work.colab',
  );
}

export const workcolabSupabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
