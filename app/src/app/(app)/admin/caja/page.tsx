import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  CajaClient,
  type TransferRow,
  type CashMovement,
} from './caja-client';

/**
 * Página /admin/caja — gestión de caja desde la perspectiva del admin.
 *
 * Refactor (2026-05): el admin ahora recibe el efectivo directamente
 * del chofer; el contador valida la caja del admin desde /contador.
 *
 * Tabs (searchParam `tab`):
 *   ?tab=efectivo-choferes (default) — cash_transfers.status='pendiente'
 *      con botón "Recibí efectivo de {driver}".
 *   ?tab=validados                   — cash_transfers.status='recibido'
 *      historial de lo que el admin ya recibió de choferes.
 *   ?tab=mi-caja                     — admin_cash_register del usuario
 *      autenticado: ingresos, egresos, saldo y movimientos.
 *
 * Acceso: admin, admin2 y contador (middleware). El contador entra para
 * auditar; las acciones de "recibir del chofer" requieren admin/admin2
 * (defensa en profundidad en la action).
 */
export const dynamic = 'force-dynamic';

type RawSearchParams = {
  tab?: string | string[];
  mes?: string | string[];
  anio?: string | string[];
};

function pickStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

type TabKey = 'efectivo-choferes' | 'validados' | 'mi-caja';

const ALLOWED_TABS: readonly TabKey[] = [
  'efectivo-choferes',
  'validados',
  'mi-caja',
];

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
      : 'efectivo-choferes';

    // Mes/año del filtro. Defaults al mes actual UTC; valores fuera de
    // rango (URL stale o manipulada) caen al default silenciosamente.
    // Aplica a las queries de cash_transfers (tabs choferes / validados)
    // y admin_cash_register (tab mi-caja). Las actions NO filtran por
    // fecha — el filtro solo controla qué SE MUESTRA.
    const now = new Date();
    const mesRaw = Number.parseInt(pickStr(raw.mes), 10);
    const anioRaw = Number.parseInt(pickStr(raw.anio), 10);
    const mes =
      Number.isFinite(mesRaw) && mesRaw >= 1 && mesRaw <= 12
        ? mesRaw
        : now.getUTCMonth() + 1;
    const anio =
      Number.isFinite(anioRaw) && anioRaw >= 2000 && anioRaw <= 2100
        ? anioRaw
        : now.getUTCFullYear();
    const startIso = new Date(Date.UTC(anio, mes - 1, 1)).toISOString();
    const endIso = new Date(Date.UTC(anio, mes, 1)).toISOString();

    const userClient = await supabaseServer();
    const {
      data: { user },
    } = await userClient.auth.getUser();
    const currentUserId = user?.id ?? null;

    const admin = supabaseAdmin();

    // Tres queries en paralelo:
    //   1. cash_transfers status='pendiente' dirigidos a este admin
    //      específico (receiver_role='admin' AND receiver_id=uid()).
    //      El chofer eligió a quién entregar el cash — sólo ese
    //      admin lo ve en su panel.
    //   2. cash_transfers status='recibido' → historial completo de
    //      recibidos por este admin (últimos 200).
    //   3. admin_cash_register del usuario actual → tab "Mi caja".
    const [pendingResult, receivedResult, myMovementsResult] =
      await Promise.all([
        currentUserId
          ? admin
              .from('cash_transfers')
              .select(
                'id, driver_id, contador_id, receiver_id, receiver_role, amount, status, created_at, notes',
              )
              .eq('status', 'pendiente')
              .eq('receiver_role', 'admin')
              .eq('receiver_id', currentUserId)
              .gte('created_at', startIso)
              .lt('created_at', endIso)
              .order('created_at', { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        currentUserId
          ? admin
              .from('cash_transfers')
              .select(
                'id, driver_id, contador_id, admin_id, receiver_id, receiver_role, amount, status, created_at, admin_validated_at, notes',
              )
              .eq('status', 'recibido')
              .eq('receiver_role', 'admin')
              .eq('receiver_id', currentUserId)
              // Tab "validados": filtramos por `admin_validated_at`
              // (cuándo el admin marcó como recibido), no por created_at,
              // para que el historial respete el mes en que SE VALIDÓ.
              .gte('admin_validated_at', startIso)
              .lt('admin_validated_at', endIso)
              .order('admin_validated_at', { ascending: false })
              .limit(200)
          : Promise.resolve({ data: [], error: null }),
        currentUserId
          ? admin
              .from('admin_cash_register')
              .select(
                'id, admin_id, amount, operation_type, source, created_at, notes, registered_by',
              )
              .eq('admin_id', currentUserId)
              .gte('created_at', startIso)
              .lt('created_at', endIso)
              .order('created_at', { ascending: false })
              .limit(100)
          : Promise.resolve({ data: [], error: null }),
      ]);

    if (pendingResult.error) {
      return (
        <ErrorState
          message={`Error leyendo pendientes: ${pendingResult.error.message}`}
        />
      );
    }
    if (receivedResult.error) {
      return (
        <ErrorState
          message={`Error leyendo recibidos: ${receivedResult.error.message}`}
        />
      );
    }
    if (myMovementsResult.error) {
      console.error(
        '[CajaPage] mi-caja select falló (no fatal):',
        myMovementsResult.error,
      );
    }

    const pendingRaw = pendingResult.data ?? [];
    const receivedRaw = receivedResult.data ?? [];
    const myMovsRaw = myMovementsResult.data ?? [];

    // Resolver nombres en una sola query (todos los user ids únicos
    // referenciados en los 3 datasets).
    const userIds = Array.from(
      new Set(
        [
          ...pendingRaw.flatMap((t) => [t.driver_id, t.contador_id]),
          ...receivedRaw.flatMap((t) => [
            t.driver_id,
            t.contador_id,
            t.admin_id,
          ]),
          ...myMovsRaw.flatMap((m) => [m.admin_id, m.registered_by]),
        ].filter((x): x is string => !!x),
      ),
    );
    const nameById = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: users, error: uErr } = await admin
        .from('profiles')
        .select('id, full_name')
        .in('id', userIds);
      if (uErr) {
        return (
          <ErrorState message={`Error leyendo perfiles: ${uErr.message}`} />
        );
      }
      for (const u of users ?? []) {
        nameById.set(u.id, u.full_name ?? '(sin nombre)');
      }
    }

    const pendingTransfers: TransferRow[] = pendingRaw.map((t) => ({
      id: t.id,
      driver_name: t.driver_id ? nameById.get(t.driver_id) ?? '—' : '—',
      received_by_name: '—',
      amount: Number(t.amount ?? 0),
      created_at: t.created_at,
      received_at: null,
      notes: t.notes ?? null,
    }));

    const receivedTransfers: TransferRow[] = receivedRaw.map((t) => ({
      id: t.id,
      driver_name: t.driver_id ? nameById.get(t.driver_id) ?? '—' : '—',
      // contador_id en realidad guarda el ID del admin que recibió
      // (reusamos la columna para no migrar). Se muestra como
      // "Recibido por".
      received_by_name: t.contador_id
        ? nameById.get(t.contador_id) ?? '—'
        : '—',
      amount: Number(t.amount ?? 0),
      created_at: t.created_at,
      received_at: null,
      notes: t.notes ?? null,
    }));

    const pendingGrandTotal = pendingTransfers.reduce(
      (s, r) => s + r.amount,
      0,
    );

    // ── Tab "Mi caja": movimientos del admin actual + saldo.
    // `myMovsRaw` ya viene filtrado al mes; el filtro inner sólo es
    // defensivo para que el cálculo del "del mes" reuse la misma
    // ventana sin recomputar.
    const myMovements: CashMovement[] = myMovsRaw.map((m) => ({
      id: m.id,
      amount: Number(m.amount ?? 0),
      operation_type:
        m.operation_type === 'egreso'
          ? 'egreso'
          : m.operation_type === 'validacion'
            ? 'validacion'
            : 'ingreso',
      source: m.source ?? '',
      created_at: m.created_at ?? null,
      registered_by_name: m.registered_by
        ? nameById.get(m.registered_by) ?? '—'
        : '—',
      notes: m.notes ?? null,
    }));

    const myIngresosTotal = myMovements
      .filter((m) => m.operation_type === 'ingreso')
      .reduce((s, m) => s + m.amount, 0);
    const myEgresosTotal = myMovements
      .filter((m) => m.operation_type !== 'ingreso')
      .reduce((s, m) => s + m.amount, 0);
    const myBalance = myIngresosTotal - myEgresosTotal;

    const myIngresosThisMonth = myMovements
      .filter(
        (m) =>
          m.operation_type === 'ingreso' &&
          m.created_at &&
          m.created_at >= startIso &&
          m.created_at < endIso,
      )
      .reduce((s, m) => s + m.amount, 0);
    const myEgresosThisMonth = myMovements
      .filter(
        (m) =>
          m.operation_type !== 'ingreso' &&
          m.created_at &&
          m.created_at >= startIso &&
          m.created_at < endIso,
      )
      .reduce((s, m) => s + m.amount, 0);

    return (
      <CajaClient
        tab={tab}
        pendingTransfers={pendingTransfers}
        receivedTransfers={receivedTransfers}
        pendingGrandTotal={pendingGrandTotal}
        myMovements={myMovements}
        myIngresosTotal={myIngresosTotal}
        myEgresosTotal={myEgresosTotal}
        myBalance={myBalance}
        myIngresosThisMonth={myIngresosThisMonth}
        myEgresosThisMonth={myEgresosThisMonth}
        mes={mes}
        anio={anio}
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
