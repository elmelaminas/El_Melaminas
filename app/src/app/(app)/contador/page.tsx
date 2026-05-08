import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  ContadorClient,
  type DriverWithCash,
  type HistoryRow,
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

    // Auth para el historial — necesitamos el contador_id del usuario
    // logueado para filtrar las transferencias que ÉL recibió.
    const userClient = await supabaseServer();
    const {
      data: { user },
    } = await userClient.auth.getUser();
    const contadorId = user?.id ?? null;

    // Dos queries en paralelo:
    //   1. Pendientes GLOBALES (cualquier contador puede recibir de
    //      cualquier chofer; no filtramos por contador_id).
    //   2. Historial PERSONAL del contador logueado: transferencias
    //      donde él aparece como contador_id, sin filtrar por status
    //      (incluye recibido + validado para que vea el ciclo completo).
    //      Si no hay user (caso teórico, el middleware ya bloquea), el
    //      historial sale vacío.
    const [pendingResult, historyResult] = await Promise.all([
      admin
        .from('cash_transfers')
        .select('driver_id, amount')
        .eq('status', 'pendiente'),
      contadorId
        ? admin
            .from('cash_transfers')
            .select('id, driver_id, amount, status, created_at')
            .eq('contador_id', contadorId)
            .order('created_at', { ascending: false })
            .limit(20)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (pendingResult.error) {
      return <ErrorState message={`Error leyendo transferencias: ${pendingResult.error.message}`} />;
    }
    if (historyResult.error) {
      return <ErrorState message={`Error leyendo historial: ${historyResult.error.message}`} />;
    }

    // Sumamos pendientes por driver_id.
    const totalsByDriver = new Map<string, number>();
    for (const t of pendingResult.data ?? []) {
      if (!t.driver_id) continue;
      totalsByDriver.set(
        t.driver_id,
        (totalsByDriver.get(t.driver_id) ?? 0) + Number(t.amount ?? 0),
      );
    }

    // Conjunto de driver_ids únicos a resolver: pendientes + historial.
    const allDriverIds = Array.from(
      new Set(
        [
          ...totalsByDriver.keys(),
          ...((historyResult.data ?? []).map((h) => h.driver_id).filter(
            (id): id is string => !!id,
          )),
        ],
      ),
    );
    let nameById = new Map<string, string>();
    if (allDriverIds.length > 0) {
      const { data: drivers, error: dErr } = await admin
        .from('profiles')
        .select('id, full_name')
        .in('id', allDriverIds);
      if (dErr) {
        return <ErrorState message={`Error leyendo choferes: ${dErr.message}`} />;
      }
      for (const d of drivers ?? []) {
        nameById.set(d.id, d.full_name ?? '(sin nombre)');
      }
    }

    const rows: DriverWithCash[] = Array.from(totalsByDriver.keys())
      .map((id) => ({
        driver_id: id,
        driver_name: nameById.get(id) ?? '(chofer desconocido)',
        amount: totalsByDriver.get(id) ?? 0,
      }))
      // Choferes con más efectivo pendiente arriba.
      .sort((a, b) => b.amount - a.amount);

    const grandTotal = rows.reduce((s, r) => s + r.amount, 0);

    type RawHistory = {
      id: string;
      driver_id: string | null;
      amount: number | string | null;
      status: string | null;
      created_at: string | null;
    };
    const history: HistoryRow[] = ((historyResult.data ?? []) as RawHistory[]).map(
      (h) => ({
        id: h.id,
        driver_name: h.driver_id
          ? nameById.get(h.driver_id) ?? '(chofer desconocido)'
          : '—',
        amount: Number(h.amount ?? 0),
        // Sólo nos interesan los estados post-pendiente; si por raro
        // motivo aparece un 'pendiente' del propio contador (no debería),
        // lo mostramos igual con un fallback a 'recibido' para el badge.
        status:
          h.status === 'validado'
            ? 'validado'
            : h.status === 'recibido'
            ? 'recibido'
            : 'recibido',
        created_at: h.created_at,
      }),
    );

    return (
      <ContadorClient
        drivers={rows}
        grandTotal={grandTotal}
        history={history}
      />
    );
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
