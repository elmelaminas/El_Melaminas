import { supabaseAdmin } from '@/lib/supabase/admin';
import type { Role } from '@/data/mock';
import { UsersClient, type UserRow } from './users-client';

/**
 * Página /admin/users.
 *
 * Server Component: lee `profiles` con service_role (esta ruta es
 * exclusivamente admin; cuando se agregue middleware de RBAC se gateará por
 * rol del usuario autenticado). Para enriquecer con email — que vive en
 * `auth.users` — usamos `auth.admin.listUsers` y mergeamos en memoria.
 *
 * No cacheamos: forzamos render dinámico al usar service_role en cada
 * request para que la lista refleje el estado actual tras revalidatePath.
 */
export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const admin = supabaseAdmin();

  const [profilesResult, usersResult] = await Promise.all([
    admin
      .from('profiles')
      .select('id, full_name, role, phone, is_active, created_at')
      .order('created_at', { ascending: false }),
    admin.auth.admin.listUsers({ perPage: 200 }),
  ]);

  if (profilesResult.error) {
    return <ErrorState message={`Error leyendo profiles: ${profilesResult.error.message}`} />;
  }
  if (usersResult.error) {
    return <ErrorState message={`Error leyendo auth.users: ${usersResult.error.message}`} />;
  }

  const emailById = new Map(
    usersResult.data.users.map((u) => [u.id, u.email ?? '—'] as const),
  );

  const rows: UserRow[] = (profilesResult.data ?? []).map((p) => ({
    id: p.id,
    full_name: p.full_name,
    role: p.role as Role,
    phone: p.phone ?? null,
    is_active: p.is_active ?? false,
    email: emailById.get(p.id) ?? '—',
  }));

  return <UsersClient initialUsers={rows} />;
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card p-6">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar usuarios</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </div>
  );
}
