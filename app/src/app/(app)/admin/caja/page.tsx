import { supabaseAdmin } from '@/lib/supabase/admin';
import { CajaClient, type TransferRow } from './caja-client';

/**
 * Página /admin/caja — el admin valida el efectivo que el contador
 * recibió de los choferes.
 *
 * Server Component con DOS secciones (tabs) controladas por searchParam:
 *   ?tab=por-validar (default) — cash_transfers.status='recibido'
 *                                con botón de acción "Validar pago".
 *   ?tab=validados             — cash_transfers.status='validado'
 *                                con info del admin validador y total
 *                                acumulado del mes calendario actual.
 *
 * Names resolución: cash_transfers tiene 3 FKs a profiles
 * (driver_id, contador_id, admin_id). PostgREST no puede embedirlas
 * todas en un solo select sin ambigüedad, así que cargamos el conjunto
 * único de user_ids y resolvemos full_name en una query separada.
 *
 * Sólo accesible para role=admin (RBAC del middleware).
 */
export const dynamic = 'force-dynamic';

type RawSearchParams = {
  tab?: string | string[];
};

function pickStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

type TabKey = 'por-validar' | 'validados';

const ALLOWED_TABS: readonly TabKey[] = ['por-validar', 'validados'];

export default async function CajaPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  try {
    const raw = await searchParams;
    const tabParam = pickStr(raw.tab);
    const tab: TabKey = (ALLOWED_TABS as readonly string[]).includes(tabParam)
      ? (tabParam as TabKey)
      : 'por-validar';

    const admin = supabaseAdmin();

    // Dos SELECTs en paralelo: por validar (status=recibido) y validados.
    // En el listado de validados limitamos a 200 para evitar render gigante;
    // si hay más historia, agregamos paginación luego.
    const [pendingResult, validatedResult] = await Promise.all([
      admin
        .from('cash_transfers')
        .select(
          'id, driver_id, contador_id, amount, status, created_at, notes',
        )
        .eq('status', 'recibido')
        .order('created_at', { ascending: false }),
      admin
        .from('cash_transfers')
        .select(
          'id, driver_id, contador_id, admin_id, amount, status, created_at, admin_validated_at, notes',
        )
        .eq('status', 'validado')
        .order('admin_validated_at', { ascending: false })
        .limit(200),
    ]);

    if (pendingResult.error) {
      return <ErrorState message={`Error leyendo pendientes: ${pendingResult.error.message}`} />;
    }
    if (validatedResult.error) {
      return <ErrorState message={`Error leyendo validados: ${validatedResult.error.message}`} />;
    }

    const pendingRaw = pendingResult.data ?? [];
    const validatedRaw = validatedResult.data ?? [];

    // Conjunto único de IDs de profiles a resolver (driver, contador, admin).
    const userIds = Array.from(
      new Set(
        [
          ...pendingRaw.flatMap((t) => [t.driver_id, t.contador_id]),
          ...validatedRaw.flatMap((t) => [
            t.driver_id,
            t.contador_id,
            t.admin_id,
          ]),
        ].filter((x): x is string => !!x),
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

    const pendingTransfers: TransferRow[] = pendingRaw.map((t) => ({
      id: t.id,
      driver_name: t.driver_id ? nameById.get(t.driver_id) ?? '—' : '—',
      contador_name: t.contador_id ? nameById.get(t.contador_id) ?? '—' : '—',
      admin_name: '—',
      amount: Number(t.amount ?? 0),
      created_at: t.created_at,
      admin_validated_at: null,
      notes: t.notes ?? null,
    }));

    const validatedTransfers: TransferRow[] = validatedRaw.map((t) => ({
      id: t.id,
      driver_name: t.driver_id ? nameById.get(t.driver_id) ?? '—' : '—',
      contador_name: t.contador_id ? nameById.get(t.contador_id) ?? '—' : '—',
      admin_name: t.admin_id ? nameById.get(t.admin_id) ?? '—' : '—',
      amount: Number(t.amount ?? 0),
      created_at: t.created_at,
      admin_validated_at: t.admin_validated_at,
      notes: t.notes ?? null,
    }));

    // Total validado del MES CALENDARIO ACTUAL (independiente del listado).
    // Esto es una métrica operativa que el admin quiere ver siempre del
    // mes en curso, no de un mes arbitrario seleccionado en otra pantalla.
    const now = new Date();
    const startOfCurrentMonthIso = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();
    const startOfNextMonthIso = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ).toISOString();
    const validatedThisMonthTotal = validatedRaw.reduce((s, t) => {
      const validatedAt = t.admin_validated_at;
      if (
        validatedAt &&
        validatedAt >= startOfCurrentMonthIso &&
        validatedAt < startOfNextMonthIso
      ) {
        return s + Number(t.amount ?? 0);
      }
      return s;
    }, 0);

    const pendingGrandTotal = pendingTransfers.reduce(
      (s, r) => s + r.amount,
      0,
    );

    return (
      <CajaClient
        tab={tab}
        pendingTransfers={pendingTransfers}
        validatedTransfers={validatedTransfers}
        pendingGrandTotal={pendingGrandTotal}
        validatedThisMonthTotal={validatedThisMonthTotal}
      />
    );
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
