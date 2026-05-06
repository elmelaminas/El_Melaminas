import { cookies } from 'next/headers';
import { createServerClient, type CookieMethodsServer } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Cliente de Supabase para Server Components, Server Actions y Route Handlers.
 *
 * Usa la anon key + cookies de la request, así que respeta RLS y representa
 * al usuario autenticado. Para operaciones privilegiadas (crear usuarios,
 * mutar cualquier profile sin importar quién esté logueado) usa
 * `supabaseAdmin()` desde `./admin`.
 *
 * En Next.js 16 `cookies()` es async — hay que `await`-earla antes de leer.
 *
 * `setAll` puede fallar dentro de Server Components puros (no se pueden
 * escribir cookies después de empezar a streamear). En esos casos lo
 * envolvemos en try/catch: el refresh del token pasará en el próximo
 * Server Action / middleware, que sí pueden escribir cookies.
 */
export async function supabaseServer(): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL no está definido');
  }
  if (!anonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY no está definido');
  }

  const cookieStore = await cookies();

  const cookieMethods: CookieMethodsServer = {
    getAll: () => cookieStore.getAll(),
    setAll: (cookiesToSet) => {
      try {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options);
        }
      } catch {
        // Llamado desde un Server Component puro: ignorar. El middleware o
        // un Server Action posterior se encargará de refrescar la cookie.
      }
    },
  };

  return createServerClient(url, anonKey, { cookies: cookieMethods });
}
