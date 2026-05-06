import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Cliente de Supabase con service_role.
 *
 * - `import 'server-only'` falla en build si alguien lo importa desde un
 *   Client Component, evitando filtrar la service_role al navegador.
 * - Sin sesión persistente / sin auto-refresh: el cliente admin no representa
 *   a un usuario, ejecuta operaciones privilegiadas (createUser, bypass RLS).
 * - No reutilizamos una instancia global porque cada request en un entorno
 *   serverless debe partir de cero (módulos pueden vivir entre requests con
 *   estado contaminado en HMR de dev). El costo de crearlo es trivial.
 */
export function supabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL no está definido');
  }
  if (!serviceKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY no está definido');
  }

  return createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
