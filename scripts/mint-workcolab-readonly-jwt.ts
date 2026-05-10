// Mintar JWT com claim `role: 'colab_intelligence_reader'` para aceder ao
// work.colab via PostgREST com privilégios reduzidos (SELECT-only em
// marketing_sources e projects).
//
// Uso:
//   WORKCOLAB_JWT_SECRET="<jwt-secret>" \
//   WORKCOLAB_SUPABASE_URL="https://<ref>.supabase.co" \
//   npx tsx scripts/mint-workcolab-readonly-jwt.ts
//
// Onde os valores vivem (work.colab Supabase Dashboard):
//   - JWT Secret: Project Settings → API → JWT Settings → JWT Secret
//   - URL: Project Settings → API → Project URL (formato https://<ref>.supabase.co)
//
// O JWT resultante é o valor a setar como WORKCOLAB_SUPABASE_READONLY_KEY
// no Vercel do colab-intelligence. Tem expiry longo (10 anos) — rotação
// faz-se mintando um novo + actualizar env var.
//
// Claims usadas:
//   - iss: "supabase" (Supabase API gateway exige isto — chaves anon/
//     service_role do projeto também usam este iss)
//   - ref: project ref extraído da URL (defesa adicional contra
//     reuso de chaves cross-project)
//   - role: "colab_intelligence_reader" (Postgres role com SELECT-only)

import crypto from 'node:crypto';

const secret = process.env.WORKCOLAB_JWT_SECRET;
const url = process.env.WORKCOLAB_SUPABASE_URL;

if (!secret) {
  console.error(
    'WORKCOLAB_JWT_SECRET é obrigatório. Vai a Supabase Dashboard (work.colab) → Project Settings → API → JWT Settings.',
  );
  process.exit(1);
}
if (!url) {
  console.error(
    'WORKCOLAB_SUPABASE_URL é obrigatório (ex: https://abcdef123456.supabase.co). Project Settings → API → Project URL.',
  );
  process.exit(1);
}

const refMatch = url.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i);
if (!refMatch) {
  console.error(`URL não parece válida (esperado https://<ref>.supabase.co): ${url}`);
  process.exit(1);
}
const ref = refMatch[1];

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

const now = Math.floor(Date.now() / 1000);
const expYears = 10;

const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const payload = base64url(
  JSON.stringify({
    iss: 'supabase',
    ref,
    role: 'colab_intelligence_reader',
    iat: now,
    exp: now + expYears * 365 * 24 * 3600,
  }),
);
const data = `${header}.${payload}`;
const sig = base64url(crypto.createHmac('sha256', secret).update(data).digest());

console.log(`${data}.${sig}`);
