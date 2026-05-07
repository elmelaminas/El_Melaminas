import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Cliente de Supabase para Client Components / código de browser.
 *
 * - Usa la anon key + auto-cookies (vía `@supabase/ssr` `createBrowserClient`).
 *   Esto deja la sesión sincronizada automáticamente entre browser ↔ Server
 *   Components y Server Actions, que leen las mismas cookies con
 *   `supabaseServer()`.
 * - Singleton por proceso del browser: re-crear el cliente en cada render
 *   reinicia listeners y puede cuasi-duplicar suscripciones realtime. Lo
 *   memoizamos en un módulo-level `_client` que se conserva mientras viva
 *   el bundle del cliente.
 * - **No usar desde Server Components**: no tendrá las cookies correctas
 *   y `createBrowserClient` está pensado para `window`. Para SSR usa
 *   `supabaseServer()` (`./server`).
 *
 * Para operaciones admin (service_role) usa `supabaseAdmin()` desde el
 * server únicamente — la service_role NUNCA debe llegar al browser.
 */

let _client: SupabaseClient | null = null;

export function supabaseClient(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL no está definido');
  }
  if (!anonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY no está definido');
  }

  _client = createBrowserClient(url, anonKey);
  return _client;
}
