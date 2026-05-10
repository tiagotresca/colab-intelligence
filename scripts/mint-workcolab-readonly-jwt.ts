// Mintar JWT com claim `role: 'colab_intelligence_reader'` para aceder ao
// work.colab via PostgREST com privilégios reduzidos (SELECT-only em
// marketing_sources e projects).
//
// Uso:
//   WORKCOLAB_JWT_SECRET="<jwt-secret>" npx tsx scripts/mint-workcolab-readonly-jwt.ts
//
// Onde o secret vive: Supabase Dashboard (work.colab) → Project Settings →
// API → JWT Settings → JWT Secret.
//
// O JWT resultante é o valor a setar como WORKCOLAB_SUPABASE_READONLY_KEY
// no Vercel do colab-intelligence. Tem expiry longo (10 anos) — rotação
// faz-se mintando um novo + actualizar env var.

import crypto from 'node:crypto';

const secret = process.env.WORKCOLAB_JWT_SECRET;
if (!secret) {
  console.error(
    'WORKCOLAB_JWT_SECRET é obrigatório. Vai a Supabase Dashboard (work.colab) → Project Settings → API → JWT Settings.',
  );
  process.exit(1);
}

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
    role: 'colab_intelligence_reader',
    iss: 'colab-intelligence-mint',
    iat: now,
    exp: now + expYears * 365 * 24 * 3600,
  }),
);
const data = `${header}.${payload}`;
const sig = base64url(crypto.createHmac('sha256', secret).update(data).digest());

console.log(`${data}.${sig}`);
