import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  CajaClient,
  type TransferRow,
  type AdminCashSummary,
  type AdminCashMovement,
} from './caja-client';
import { MES_LABEL } from '../../dashboard/constants';

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
  /** Mes 1-12 — filtra el listado de validados por `admin_validated_at`. */
  mes?: string | string[];
  /** Año 4-dígitos — pareja inseparable con `mes`. */
  anio?: string | string[];
};

function pickStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

type TabKey = 'por-validar' | 'validados' | 'efectivo-admin';

const ALLOWED_TABS: readonly TabKey[] = [
  'por-validar',
  'validados',
  'efectivo-admin',
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
      : 'por-validar';

    // Filtro mes/anio opcional. Drill-down típico desde el card
    // "Efectivo validado" del dashboard, que linkea con
    // `?tab=validados&mes=…&anio=…`. Solo aplica al tab "validados"
    // — el de "por validar" muestra siempre el estado AHORA sin
    // importar el rango.
    const mesRaw = Number.parseInt(pickStr(raw.mes), 10);
    const anioRaw = Number.parseInt(pickStr(raw.anio), 10);
    const mes =
      Number.isFinite(mesRaw) && mesRaw >= 1 && mesRaw <= 12 ? mesRaw : 0;
    const anio =
      Number.isFinite(anioRaw) && anioRaw >= 2000 && anioRaw <= 2100
        ? anioRaw
        : 0;
    const monthFilterActive = mes > 0 && anio > 0;
    const startOfMonthIso = monthFilterActive
      ? new Date(Date.UTC(anio, mes - 1, 1)).toISOString()
      : null;
    const startOfNextMonthIso = monthFilterActive
      ? new Date(Date.UTC(anio, mes, 1)).toISOString()
      : null;

    const admin = supabaseAdmin();

    // Dos SELECTs en paralelo: por validar (status=recibido) y validados.
    // En el listado de validados limitamos a 200 para evitar render gigante;
    // si hay más historia, agregamos paginación luego.
    let validatedQuery = admin
      .from('cash_transfers')
      .select(
        'id, driver_id, contador_id, admin_id, amount, status, created_at, admin_validated_at, notes',
      )
      .eq('status', 'validado')
      .order('admin_validated_at', { ascending: false })
      .limit(200);
    if (monthFilterActive && startOfMonthIso && startOfNextMonthIso) {
      validatedQuery = validatedQuery
        .gte('admin_validated_at', startOfMonthIso)
        .lt('admin_validated_at', startOfNextMonthIso);
    }

    const [pendingResult, validatedResult] = await Promise.all([
      admin
        .from('cash_transfers')
        .select(
          'id, driver_id, contador_id, amount, status, created_at, notes',
        )
        .eq('status', 'recibido')
        .order('created_at', { ascending: false }),
      validatedQuery,
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

    // Total validado:
    //   - Si hay filtro mes/anio activo: suma TODO el listado filtrado
    //     (que ya viene acotado al rango por la query Supabase).
    //   - Sin filtro: suma solo los del mes calendario actual,
    //     comportamiento original.
    const now = new Date();
    const startOfCurrentMonthIso = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();
    const startOfNextCurrentMonthIso = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ).toISOString();
    const validatedTotal = monthFilterActive
      ? validatedRaw.reduce((s, t) => s + Number(t.amount ?? 0), 0)
      : validatedRaw.reduce((s, t) => {
          const validatedAt = t.admin_validated_at;
          if (
            validatedAt &&
            validatedAt >= startOfCurrentMonthIso &&
            validatedAt < startOfNextCurrentMonthIso
          ) {
            return s + Number(t.amount ?? 0);
          }
          return s;
        }, 0);

    const pendingGrandTotal = pendingTransfers.reduce(
      (s, r) => s + r.amount,
      0,
    );

    // Label del total card del tab validados:
    //   "Total validado este mes" cuando no hay filtro,
    //   "Total validado en <Mes> <Anio>" cuando sí.
    const validatedTotalLabel = monthFilterActive
      ? `Total validado en ${MES_LABEL[mes] ?? mes} ${anio}`
      : 'Total validado este mes';

    // ── Tab "Efectivo Admin": agregamos:
    //   - Por cada admin activo: saldo (ingresos - egresos) + ingresos
    //     del mes en curso.
    //   - Lista completa de movimientos recientes para auditoría.
    //   - Resumen general: efectivo en contador (cash_transfers
    //     status=recibido) + efectivo en admins (sum positivos).
    //
    // Toda la lectura es best-effort: si la tabla no existe (migración
    // pendiente), las listas salen vacías y el tab muestra ceros.
    let adminCashSummaries: AdminCashSummary[] = [];
    let adminCashMovements: AdminCashMovement[] = [];
    let totalCashWithContador = 0;
    let totalCashWithAdmins = 0;
    try {
      const nowDate = new Date();
      const startCurMonthIso = new Date(
        Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1),
      ).toISOString();

      const [adminsRes, cashAllRes, contadorCashRes, recentMovRes] =
        await Promise.all([
          admin
            .from('profiles')
            .select('id, full_name, role')
            .in('role', ['admin', 'admin2'])
            .eq('is_active', true)
            .order('full_name', { ascending: true }),
          admin
            .from('admin_cash_register')
            .select('admin_id, amount, operation_type, created_at'),
          // Efectivo que el contador ya recibió pero todavía no se
          // valida ni se transfiere — `status='recibido'`.
          admin
            .from('cash_transfers')
            .select('amount')
            .eq('status', 'recibido'),
          // Últimos 50 movimientos de admin_cash_register con join a
          // profiles para mostrar nombres en la tabla.
          admin
            .from('admin_cash_register')
            .select(
              'id, admin_id, amount, operation_type, source, created_at, notes, registered_by',
            )
            .order('created_at', { ascending: false })
            .limit(50),
        ]);

      if (adminsRes.error) {
        console.error(
          '[CajaPage] admins select falló (no fatal):',
          adminsRes.error,
        );
      }
      if (cashAllRes.error) {
        console.error(
          '[CajaPage] admin_cash_register select falló (no fatal):',
          cashAllRes.error,
        );
      }
      if (contadorCashRes.error) {
        console.error(
          '[CajaPage] cash_transfers recibidos select falló (no fatal):',
          contadorCashRes.error,
        );
      }
      if (recentMovRes.error) {
        console.error(
          '[CajaPage] movimientos recientes select falló (no fatal):',
          recentMovRes.error,
        );
      }

      // Agregar por admin_id
      type CashSlot = {
        ingresos: number;
        egresos: number;
        thisMonthIngresos: number;
      };
      const byAdmin = new Map<string, CashSlot>();
      for (const r of cashAllRes.data ?? []) {
        if (!r.admin_id) continue;
        const slot = byAdmin.get(r.admin_id) ?? {
          ingresos: 0,
          egresos: 0,
          thisMonthIngresos: 0,
        };
        const amt = Number(r.amount ?? 0);
        if (r.operation_type === 'ingreso') {
          slot.ingresos += amt;
          if (r.created_at && r.created_at >= startCurMonthIso) {
            slot.thisMonthIngresos += amt;
          }
        } else {
          slot.egresos += amt;
        }
        byAdmin.set(r.admin_id, slot);
      }

      adminCashSummaries = (adminsRes.data ?? []).map((a) => {
        const slot = byAdmin.get(a.id) ?? {
          ingresos: 0,
          egresos: 0,
          thisMonthIngresos: 0,
        };
        return {
          admin_id: a.id,
          admin_name: a.full_name ?? '(sin nombre)',
          role: a.role as 'admin' | 'admin2',
          ingresos: slot.ingresos,
          egresos: slot.egresos,
          balance: slot.ingresos - slot.egresos,
          this_month_ingresos: slot.thisMonthIngresos,
        };
      });

      totalCashWithAdmins = adminCashSummaries.reduce(
        (s, a) => s + Math.max(0, a.balance),
        0,
      );
      totalCashWithContador = (contadorCashRes.data ?? []).reduce(
        (s, t) => s + Number(t.amount ?? 0),
        0,
      );

      // Resolución de nombres para los movimientos recientes.
      const movRaw = recentMovRes.data ?? [];
      const movUserIds = Array.from(
        new Set(
          movRaw
            .flatMap((m) => [m.admin_id, m.registered_by])
            .filter((x): x is string => !!x),
        ),
      );
      const movNameById = new Map<string, string>();
      if (movUserIds.length > 0) {
        const { data: movUsers } = await admin
          .from('profiles')
          .select('id, full_name')
          .in('id', movUserIds);
        for (const u of movUsers ?? []) {
          movNameById.set(u.id, u.full_name ?? '(sin nombre)');
        }
      }
      adminCashMovements = movRaw.map((m) => ({
        id: m.id,
        admin_name: m.admin_id
          ? movNameById.get(m.admin_id) ?? '—'
          : '—',
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
          ? movNameById.get(m.registered_by) ?? '—'
          : '—',
        notes: m.notes ?? null,
      }));
    } catch (e) {
      console.error(
        '[CajaPage] efectivo admin lookup excepción (no fatal):',
        e,
      );
    }

    const totalCashInSystem = totalCashWithContador + totalCashWithAdmins;

    return (
      <CajaClient
        tab={tab}
        pendingTransfers={pendingTransfers}
        validatedTransfers={validatedTransfers}
        pendingGrandTotal={pendingGrandTotal}
        validatedThisMonthTotal={validatedTotal}
        validatedTotalLabel={validatedTotalLabel}
        monthFilterActive={monthFilterActive}
        adminCashSummaries={adminCashSummaries}
        adminCashMovements={adminCashMovements}
        totalCashWithContador={totalCashWithContador}
        totalCashWithAdmins={totalCashWithAdmins}
        totalCashInSystem={totalCashInSystem}
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
