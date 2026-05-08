import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  ContadorClient,
  type DriverWithCash,
} from './contador-client';

/**
 * Página /contador.
 *
 * Server Component: lee todos los `cash_transfers` con `status='pendiente'`,
 * resuelve los nombres de los choferes que tienen efectivo pendiente, y
 * pasa al cliente la lista agrupada (un row por chofer con su monto total).
 *
 * Política de errores idéntica al resto: try/catch + ErrorState con el
 * mensaje preciso de Postgres.
 *
 * Nota sobre RLS: usamos supabaseAdmin (service_role) para bypassear RLS
 * en lectura, consistente con el resto de los Server Components del
 * proyecto. El middleware ya asegura que solo roles {admin, contador}
 * lleguen a esta ruta.
 */
export const dynamic = 'force-dynamic';

export default async function ContadorPage() {
  try {
    const admin = supabaseAdmin();

    // Pendientes globales — los contadores ven todos los pendientes,
    // no filtramos por contador_id (cualquier contador puede recibir
    // de cualquier chofer).
    const { data: transfers, error: tErr } = await admin
      .from('cash_transfers')
      .select('driver_id, amount')
      .eq('status', 'pendiente');
    if (tErr) {
      return <ErrorState message={`Error leyendo transferencias: ${tErr.message}`} />;
    }

    // Sumamos por driver_id.
    const totalsByDriver = new Map<string, number>();
    for (const t of transfers ?? []) {
      if (!t.driver_id) continue;
      totalsByDriver.set(
        t.driver_id,
        (totalsByDriver.get(t.driver_id) ?? 0) + Number(t.amount ?? 0),
      );
    }

    // Si no hay pendientes, no necesitamos ir a profiles.
    const driverIds = Array.from(totalsByDriver.keys());
    let nameById = new Map<string, string>();
    if (driverIds.length > 0) {
      const { data: drivers, error: dErr } = await admin
        .from('profiles')
        .select('id, full_name')
        .in('id', driverIds);
      if (dErr) {
        return <ErrorState message={`Error leyendo choferes: ${dErr.message}`} />;
      }
      for (const d of drivers ?? []) {
        nameById.set(d.id, d.full_name ?? '(sin nombre)');
      }
    }

    const rows: DriverWithCash[] = driverIds
      .map((id) => ({
        driver_id: id,
        driver_name: nameById.get(id) ?? '(chofer desconocido)',
        amount: totalsByDriver.get(id) ?? 0,
      }))
      // Choferes con más efectivo pendiente arriba.
      .sort((a, b) => b.amount - a.amount);

    const grandTotal = rows.reduce((s, r) => s + r.amount, 0);

    return <ContadorClient drivers={rows} grandTotal={grandTotal} />;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al cargar caja';
    console.error('[ContadorPage] excepción no controlada:', err);
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
