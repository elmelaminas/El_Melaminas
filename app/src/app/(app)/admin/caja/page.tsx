import { supabaseAdmin } from '@/lib/supabase/admin';
import { CajaClient, type TransferRow } from './caja-client';

/**
 * Página /admin/caja — el admin valida el efectivo que el contador
 * recibió de los choferes.
 *
 * Server Component: SELECT cash_transfers WHERE status='recibido' (los
 * que esperan validación) + nombres de chofer y contador resueltos en
 * memoria con un segundo SELECT a profiles. Hacemos esto en lugar de
 * un PostgREST embed múltiple porque cash_transfers tiene 3 FKs a
 * profiles (driver_id, contador_id, admin_id) y eso causa "embedding
 * ambiguity" si uno trata de joinear todo en un solo select.
 *
 * Sólo accesible para role=admin (RBAC del middleware).
 */
export const dynamic = 'force-dynamic';

export default async function CajaPage() {
  try {
    const admin = supabaseAdmin();

    const { data: transfers, error: tErr } = await admin
      .from('cash_transfers')
      .select(
        'id, driver_id, contador_id, amount, status, created_at, notes',
      )
      .eq('status', 'recibido')
      .order('created_at', { ascending: false });
    if (tErr) {
      return <ErrorState message={`Error leyendo caja: ${tErr.message}`} />;
    }

    const userIds = Array.from(
      new Set(
        (transfers ?? [])
          .flatMap((t) => [t.driver_id, t.contador_id])
          .filter((x): x is string => !!x),
      ),
    );
    let nameById = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: users, error: uErr } = await admin
        .from('profiles')
        .select('id, full_name')
        .in('id', userIds);
      if (uErr) {
        return <ErrorState message={`Error leyendo perfiles: ${uErr.message}`} />;
      }
      for (const u of users ?? []) {
        nameById.set(u.id, u.full_name ?? '(sin nombre)');
      }
    }

    const rows: TransferRow[] = (transfers ?? []).map((t) => ({
      id: t.id,
      driver_name: t.driver_id ? nameById.get(t.driver_id) ?? '—' : '—',
      contador_name: t.contador_id ? nameById.get(t.contador_id) ?? '—' : '—',
      amount: Number(t.amount ?? 0),
      created_at: t.created_at,
      notes: t.notes ?? null,
    }));

    const grandTotal = rows.reduce((s, r) => s + r.amount, 0);

    return <CajaClient transfers={rows} grandTotal={grandTotal} />;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al cargar caja';
    console.error('[CajaPage] excepción no controlada:', err);
    return <ErrorState message={message} />;
  }
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar la caja</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </div>
  );
}
