import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The only module that reads `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.
 *
 * Neither has the `NEXT_PUBLIC_` prefix, so Next never inlines them into the
 * browser bundle; CI builds with a canary key and scans `.next/static` for it
 * (`scripts/conferir-bundle-web.ts`). The client is built at request time, not
 * at import, so `next build` needs no secret and a missing one closes the
 * routes with 503 instead of failing the build.
 */

export class BancoSemConfiguracao extends Error {}

let cliente: SupabaseClient | null = null;

export function banco(): SupabaseClient {
  if (cliente !== null) return cliente;
  const url = process.env['SUPABASE_URL'];
  const chave = process.env['SUPABASE_SERVICE_KEY'];
  if (!url || !chave) {
    throw new BancoSemConfiguracao('falta SUPABASE_URL ou SUPABASE_SERVICE_KEY no servidor');
  }
  cliente = createClient(url, chave, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cliente;
}
