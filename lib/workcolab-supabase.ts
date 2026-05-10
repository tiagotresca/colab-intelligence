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
// Auth: usa `WORKCOLAB_SUPABASE_READONLY_KEY` — JWT mintado com claim
// `role: 'colab_intelligence_reader'`, que tem GRANT SELECT só em
// `marketing_sources` e `projects`. Setup em
// `sql/external/work-colab-readonly-role.sql` (aplicar no work.colab).
// Mintar JWT com `scripts/mint-workcolab-readonly-jwt.ts`.
//
// Antes era a service-role key — bypass total de RLS, leitura+escrita em
// TUDO o work.colab. Substituído por defesa em profundidade.

import { createClient } from '@supabase/supabase-js';

const url = process.env.WORKCOLAB_SUPABASE_URL;
const readonlyKey = process.env.WORKCOLAB_SUPABASE_READONLY_KEY;

if (!url || !readonlyKey) {
  throw new Error(
    'WORKCOLAB_SUPABASE_URL e WORKCOLAB_SUPABASE_READONLY_KEY são obrigatórios. ' +
      'Aplicar sql/external/work-colab-readonly-role.sql no Supabase do work.colab e ' +
      'mintar o JWT com `npx tsx scripts/mint-workcolab-readonly-jwt.ts`.',
  );
}

export const workcolabSupabase = createClient(url, readonlyKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
