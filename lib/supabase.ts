import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  throw new Error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios');
}

// Server-side client com service role — bypassa RLS. Nunca expor ao browser.
export const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
