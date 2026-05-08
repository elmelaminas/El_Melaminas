import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  EntregasClient,
  type EntregaRow,
  type DriverOption,
  type IssueRow,
  type RouteCandidate,
} from './entregas-client';

/**
 * Página /admin/entregas — vista admin de TODAS las entregas con info
 * del chofer asignado.
 *
 * Distinta de /driver (donde un chofer ve solo sus propias entregas) y
 * de /leads (que muestra leads como entidades de negocio con filtros
 * comerciales). Acá el foco es operativo-logístico: ¿qué entrega va con
 * qué chofer? ¿cuál sigue pendiente? ¿qué adeudo trae?
 *
 * Filtros (searchParams, bookmarkables):
 *   - `driver`: uuid del chofer (whitelist contra lista activa).
 *   - `status`: 'pendiente' | 'entregado' | 'cancelado'.
 *     'pendiente' es semántico: en DB cubre `pendiente` Y `en_transito`
 *     (mismo patrón que /leads desde el commit del drill-down). Quien
 *     necesita el detalle puede mirar el badge azul "En tránsito" en la
 *     tabla.
 *
 * Orden: pendientes primero, después entregados, después cancelados;
 * dentro de cada grupo por `created_at DESC`. PostgREST no expone un
 * `ORDER BY CASE` directo, así que ordenamos en JS post-fetch — costo
 * O(n log n) con n = filas visibles, irrelevante.
 *
 * Adeudo: en lugar de inferirlo del flag `payment_status` (que puede
 * estar stale o no decir el monto exacto), hacemos UN SELECT bulk de
 * `payments` con `status='exitoso'` filtrado por `lead_id IN (los de la
 * página)`, y restamos del `total_amount` en memoria. Es UNA query
 * extra, no N — el costo es lineal con el número de filas, no con el
 * número de leads totales.
 *
 * Sólo accesible para role=admin (RBAC ya cubre /admin/* en middleware).
 */
export const dynamic = 'force-dynamic';

const STATUS_VALUES = ['pendiente', 'entregado', 'cancelado'] as const;

type RawSearchParams = {
  driver?: string | string[];
  status?: string | string[];
  /** Fecha YYYY-MM-DD para la sección "Ruta del día". Default = hoy
   *  (UTC) en page.tsx si no viene o es inválida. */
  fecha?: string | string[];
};

/** Devuelve hoy en formato YYYY-MM-DD. Usamos UTC para consistencia
 *  servidor/cliente (igual que el campo `delivery_date` que es DATE
 *  y no tiene huso). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function pickStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

function whitelist<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | '' {
  if (!value) return '';
  return (allowed as readonly string[]).includes(value) ? (value as T) : '';
}

export default async function EntregasPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  try {
    const raw = await searchParams;
    const driverParam = pickStr(raw.driver);
    const statusFilter = whitelist(pickStr(raw.status), STATUS_VALUES);

    // Fecha para la sección "Ruta del día". Si viene mal formateada
    // caemos a hoy — no es un filtro estricto, es un selector de fecha
    // sobre la que el admin opera la ruta.
    const fechaParam = pickStr(raw.fecha);
    const routeDate = /^\d{4}-\d{2}-\d{2}$/.test(fechaParam)
      ? fechaParam
      : todayIso();

    const admin = supabaseAdmin();

    // Lista de choferes activos para el dropdown del filtro. Se usa
    // también para resolver el driver_name en cada fila — los choferes
    // INACTIVOS los resolvemos en una query extra solo si aparecen en
    // los leads listados (ej: lead viejo con un chofer ya desactivado).
    const driversResult = await admin
      .from('profiles')
      .select('id, full_name')
      .eq('role', 'driver')
      .eq('is_active', true)
      .order('full_name', { ascending: true });
    if (driversResult.error) {
      return (
        <ErrorState
          message={`Error leyendo choferes: ${driversResult.error.message}`}
        />
      );
    }

    // Validar `driver` contra la lista (uuid manipulado lo ignoramos).
    const validDriver = (driversResult.data ?? []).some(
      (d) => d.id === driverParam,
    )
      ? driverParam
      : '';

    // SELECT principal de leads.
    let query = admin
      .from('leads')
      .select(
        `id, client_name, address, maps_url, total_amount,
         delivery_status, payment_status, sale_date, created_at,
         driver_id,
         lead_colors ( quantity, colors ( name ) )`,
      )
      .is('deleted_at', null);

    if (validDriver) query = query.eq('driver_id', validDriver);
    if (statusFilter === 'pendiente') {
      query = query.in('delivery_status', ['pendiente', 'en_transito']);
    } else if (statusFilter) {
      query = query.eq('delivery_status', statusFilter);
    }

    const { data: leadsData, error: leadsErr } = await query;
    if (leadsErr) {
      return <ErrorState message={`Error leyendo entregas: ${leadsErr.message}`} />;
    }

    // Resolver nombres de chofer. Empezamos con los activos del SELECT
    // anterior; si algún lead apunta a un chofer inactivo o de otro rol,
    // lo traemos en un SELECT extra (best-effort).
    const driverNameById = new Map<string, string>();
    for (const d of driversResult.data ?? []) {
      driverNameById.set(d.id, d.full_name ?? '(sin nombre)');
    }
    const referencedDriverIds = Array.from(
      new Set(
        (leadsData ?? [])
          .map((l) => l.driver_id)
          .filter((id): id is string => !!id),
      ),
    );
    const missingDriverIds = referencedDriverIds.filter(
      (id) => !driverNameById.has(id),
    );
    if (missingDriverIds.length > 0) {
      const { data: more } = await admin
        .from('profiles')
        .select('id, full_name')
        .in('id', missingDriverIds);
      for (const d of more ?? []) {
        driverNameById.set(d.id, d.full_name ?? '(sin nombre)');
      }
    }

    // Bulk SELECT payments.amount para los leads visibles. Una sola
    // query, sumamos por lead_id en memoria.
    const leadIds = (leadsData ?? []).map((l) => l.id);
    const paidByLead = new Map<string, number>();
    if (leadIds.length > 0) {
      const { data: payments, error: payErr } = await admin
        .from('payments')
        .select('lead_id, amount')
        .eq('status', 'exitoso')
        .in('lead_id', leadIds);
      if (payErr) {
        // Non-fatal — si falla seguimos mostrando entregas con adeudo
        // = total_amount (peor caso, sobrestimación). Loguamos.
        console.error(
          '[EntregasPage] payments select falló (no fatal):',
          payErr,
        );
      }
      for (const p of payments ?? []) {
        if (!p.lead_id) continue;
        paidByLead.set(
          p.lead_id,
          (paidByLead.get(p.lead_id) ?? 0) + Number(p.amount ?? 0),
        );
      }
    }

    type RawLead = {
      id: string;
      client_name: string;
      address: string | null;
      maps_url: string | null;
      total_amount: number | string | null;
      delivery_status: string | null;
      payment_status: string | null;
      sale_date: string | null;
      created_at: string | null;
      driver_id: string | null;
      lead_colors:
        | {
            quantity: number | null;
            colors: { name: string } | { name: string }[] | null;
          }[]
        | null;
    };

    const rows: EntregaRow[] = ((leadsData ?? []) as RawLead[]).map((l) => {
      const total = Number(l.total_amount ?? 0);
      const paid = paidByLead.get(l.id) ?? 0;
      const adeudo = Math.max(0, total - paid);
      const colors = (l.lead_colors ?? [])
        .map((lc) => {
          const colorObj = Array.isArray(lc.colors) ? lc.colors[0] : lc.colors;
          return {
            color_name: colorObj?.name ?? '(sin nombre)',
            quantity: Number(lc.quantity ?? 0),
          };
        })
        .filter((c) => c.quantity > 0);
      return {
        id: l.id,
        client_name: l.client_name,
        address: l.address ?? '',
        maps_url: l.maps_url ?? '',
        total_amount: total,
        adeudo,
        delivery_status:
          (l.delivery_status as EntregaRow['delivery_status']) ?? 'pendiente',
        payment_status:
          (l.payment_status as EntregaRow['payment_status']) ?? 'pendiente',
        sale_date: l.sale_date,
        created_at: l.created_at,
        driver_id: l.driver_id,
        driver_name: l.driver_id
          ? driverNameById.get(l.driver_id) ?? null
          : null,
        colors,
      };
    });

    // Orden: pendientes (incluye en tránsito) primero, luego entregados,
    // luego cancelados. Dentro de cada grupo, created_at DESC.
    const STATUS_ORDER: Record<string, number> = {
      pendiente: 0,
      en_transito: 0,
      entregado: 1,
      cancelado: 2,
    };
    rows.sort((a, b) => {
      const oa = STATUS_ORDER[a.delivery_status] ?? 3;
      const ob = STATUS_ORDER[b.delivery_status] ?? 3;
      if (oa !== ob) return oa - ob;
      const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
      const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return cb - ca;
    });

    const drivers: DriverOption[] = (driversResult.data ?? []).map((d) => ({
      id: d.id,
      name: d.full_name ?? '(sin nombre)',
    }));

    // Cargar delivery_issues (sin resolver) para los leads visibles.
    // El admin necesita ver el badge ⚠️ N en cada fila + abrirlas en
    // modal para resolver. Si la tabla no existe (migración pendiente)
    // el catch loguea y seguimos con issues vacíos — la página sigue
    // funcionando sin la feature.
    const issuesByLead: Record<string, IssueRow[]> = {};
    if (leadIds.length > 0) {
      try {
        const { data: issues, error: issuesErr } = await admin
          .from('delivery_issues')
          .select(
            'id, lead_id, issue_type, description, photo_url, resolved, created_at',
          )
          .in('lead_id', leadIds)
          .eq('resolved', false)
          .order('created_at', { ascending: false });
        if (issuesErr) {
          console.error(
            '[EntregasPage] delivery_issues select falló (no fatal):',
            issuesErr,
          );
        }
        for (const i of issues ?? []) {
          if (!i.lead_id) continue;
          const list = issuesByLead[i.lead_id] ?? [];
          list.push({
            id: i.id,
            issue_type: (i.issue_type as 'faltante' | 'detalle') ?? 'detalle',
            description: i.description ?? '',
            photo_url: i.photo_url ?? null,
            resolved: i.resolved ?? false,
            created_at: i.created_at ?? null,
          });
          issuesByLead[i.lead_id] = list;
        }
      } catch (e) {
        console.error('[EntregasPage] issues lookup excepción (no fatal):', e);
      }
    }

    // ── Ruta del día: candidatos para `routeDate`.
    // Criterio (matchea spec): leads donde
    //   delivery_date = routeDate
    //   OR (delivery_date IS NULL AND delivery_status IN
    //       ('pendiente','en_transito') AND deleted_at IS NULL)
    //
    // Los con delivery_date asignada para esa fecha llegan con
    // su `delivery_order` actual; los sin fecha llegan con
    // `delivery_order=null` y el admin los puede agregar a la ruta.
    //
    // PostgREST `.or()` para combinar dos cláusulas. La sintaxis
    // exige escapar adecuadamente — usamos una expresión simple:
    //   delivery_date.eq.YYYY-MM-DD,delivery_date.is.null
    // y añadimos los demás filtros con `.in()`/`.is()` separados (que
    // se aplican a TODA la query, no a cada lado del OR). Eso es OK
    // porque el filtro de "delivery_status IN (pendiente,en_transito)"
    // y "deleted_at IS NULL" son válidos también para la rama
    // `delivery_date = routeDate` — solo nos interesan entregas
    // activas (no entregadas/canceladas) en cualquiera de los dos
    // casos.
    const routeCandidates: RouteCandidate[] = [];
    try {
      const { data: routeRows, error: routeErr } = await admin
        .from('leads')
        .select(
          `id, client_name, address, sale_date, driver_id,
           delivery_status, delivery_order, delivery_date,
           lead_colors ( quantity, colors ( name ) )`,
        )
        .in('delivery_status', ['pendiente', 'en_transito'])
        .is('deleted_at', null)
        .or(`delivery_date.eq.${routeDate},delivery_date.is.null`)
        .order('delivery_order', {
          ascending: true,
          nullsFirst: false,
        })
        .limit(100);
      if (routeErr) {
        console.error(
          '[EntregasPage] route candidates select falló (no fatal):',
          routeErr,
        );
      } else {
        type RawRouteRow = {
          id: string;
          client_name: string | null;
          address: string | null;
          sale_date: string | null;
          driver_id: string | null;
          delivery_status: string | null;
          delivery_order: number | null;
          delivery_date: string | null;
          lead_colors:
            | {
                quantity: number | null;
                colors: { name: string } | { name: string }[] | null;
              }[]
            | null;
        };
        for (const r of (routeRows ?? []) as RawRouteRow[]) {
          const colors = (r.lead_colors ?? [])
            .map((lc) => {
              const colorObj = Array.isArray(lc.colors)
                ? lc.colors[0]
                : lc.colors;
              return {
                color_name: colorObj?.name ?? '(sin nombre)',
                quantity: Number(lc.quantity ?? 0),
              };
            })
            .filter((c) => c.quantity > 0);
          routeCandidates.push({
            id: r.id,
            client_name: r.client_name ?? '(sin nombre)',
            address: r.address ?? '',
            sale_date: r.sale_date,
            driver_id: r.driver_id,
            driver_name: r.driver_id
              ? driverNameById.get(r.driver_id) ?? null
              : null,
            // Solo asignados a ESTA fecha tienen orden visible.
            // Los con delivery_date IS NULL llegan con order=null →
            // el cliente los muestra como "no asignados".
            delivery_order:
              r.delivery_date === routeDate
                ? r.delivery_order ?? null
                : null,
            assigned_to_this_date: r.delivery_date === routeDate,
            colors,
          });
        }
      }
    } catch (e) {
      console.error(
        '[EntregasPage] route candidates excepción (no fatal):',
        e,
      );
    }

    return (
      <EntregasClient
        rows={rows}
        drivers={drivers}
        filters={{ driver: validDriver, status: statusFilter }}
        issuesByLead={issuesByLead}
        routeDate={routeDate}
        routeCandidates={routeCandidates}
      />
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al cargar entregas';
    console.error('[EntregasPage] excepción no controlada:', err);
    return <ErrorState message={message} />;
  }
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudieron cargar las entregas</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </div>
  );
}
