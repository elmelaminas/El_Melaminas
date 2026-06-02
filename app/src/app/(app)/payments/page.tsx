import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { signEvidenceUrls } from '@/lib/supabase/storage';
import { PaymentsClient, type PaymentRow } from './payments-client';
import { getDateWindow } from '../dashboard/constants';
import { normalizeSearch } from '@/lib/normalize-search';

/**
 * Página /payments — listado paginado.
 *
 * Server Component que ejecuta dos SELECTs principales:
 *   1. payments con su lead (client_name) — paginado.
 *   2. payment_deductibles para los payments_id de la página actual.
 *
 * El SELECT de profiles para "nombre del chofer" se eliminó: la columna
 * "Chofer" salió del listado porque el chofer ahora vive en
 * `leads.driver_id` y no se trackea por pago. Si más adelante quieres
 * volver a mostrarlo, JOIN payments → leads → profiles vía leads.driver_id.
 *
 * Filtros: method, payment_type, búsqueda por client_name (vía join).
 *  La búsqueda por nombre de cliente requiere `.or()` sobre la relación
 *  embebida — PostgREST lo soporta como `leads.client_name.ilike.*X*`
 *  cuando se usa `.or()` con la sintaxis de filter on related table.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

const METHOD_VALUES = ['efectivo', 'transferencia', 'clip'] as const;
const TYPE_VALUES = ['anticipo', 'liquidacion', 'contra_entrega'] as const;
const ADEUDO_VALUES = ['pendiente', 'liquidado'] as const;

type RawSearchParams = {
  q?: string | string[];
  method?: string | string[];
  type?: string | string[];
  /** Mes 1-12 — si presente filtra `paid_at` por la ventana del mes. */
  mes?: string | string[];
  /** Año 4-dígitos — pareja inseparable con `mes`. */
  anio?: string | string[];
  /** Periodo del dashboard ('dia' | 'semana' | 'mes'). Con `fecha` toma
   *  prioridad sobre `mes`/`anio` y filtra `paid_at` por la ventana. */
  periodo?: string | string[];
  /** Fecha YYYY-MM-DD del dashboard. Sin `periodo` se ignora. */
  fecha?: string | string[];
  page?: string | string[];
  /** Filtro por estado de adeudo del LEAD asociado al pago.
   *  - 'pendiente' → solo pagos cuyo lead tiene payment_status ≠ 'pagado'
   *  - 'liquidado' → solo pagos cuyo lead tiene payment_status = 'pagado'
   *  - vacío/desconocido → sin filtro
   */
  adeudo?: string | string[];
};

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

// Sanitiza + normaliza el término de búsqueda (lowercase + sin
// acentos). Mismo patrón que `/leads/page.tsx`.
function sanitizeQuery(q: string): string {
  return normalizeSearch(q.replace(/[,%*\\()]/g, '')).slice(0, 80);
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  try {
    const raw = await searchParams;
    const qInput = sanitizeQuery(pickStr(raw.q));
    const method = whitelist(pickStr(raw.method), METHOD_VALUES);
    const paymentType = whitelist(pickStr(raw.type), TYPE_VALUES);
    const adeudoFilter = whitelist(pickStr(raw.adeudo), ADEUDO_VALUES);
    const pageNumber = Math.max(1, Number(pickStr(raw.page)) || 1);

    // Filtro de fecha — dos formas (drill-down desde /dashboard):
    //   1. `periodo` + `fecha` (nuevo): día/semana/mes con ventana exacta.
    //   2. `mes` + `anio` (legacy): se mantiene por backwards-compat.
    // Si vienen ambas, `periodo` gana. `filters.mes/anio` siguen
    // expuestos al cliente para que el chip "Mes: may/2026" funcione
    // cuando coincide con un mes calendario (en 'dia'/'semana' quedan
    // en 0 y el chip no aparece, pero el rango sí se aplica al query).
    const periodoRaw = pickStr(raw.periodo);
    const fechaRaw = pickStr(raw.fecha);
    const usePeriodFilter =
      (periodoRaw === 'dia' || periodoRaw === 'semana' || periodoRaw === 'mes') &&
      fechaRaw.length > 0;

    let mes = 0;
    let anio = 0;
    let startIsoFilter: string | null = null;
    let endIsoFilter: string | null = null;

    if (usePeriodFilter) {
      const window = getDateWindow(periodoRaw, fechaRaw);
      startIsoFilter = window.startIso;
      endIsoFilter = window.endIso;
      if (window.periodo === 'mes') {
        const [yStr, mStr] = window.fecha.split('-');
        mes = Number(mStr);
        anio = Number(yStr);
      }
    } else {
      const mesRaw = Number.parseInt(pickStr(raw.mes), 10);
      const anioRaw = Number.parseInt(pickStr(raw.anio), 10);
      mes =
        Number.isFinite(mesRaw) && mesRaw >= 1 && mesRaw <= 12 ? mesRaw : 0;
      anio =
        Number.isFinite(anioRaw) && anioRaw >= 2000 && anioRaw <= 2100
          ? anioRaw
          : 0;
      if (mes > 0 && anio > 0) {
        startIsoFilter = new Date(Date.UTC(anio, mes - 1, 1)).toISOString();
        endIsoFilter = new Date(Date.UTC(anio, mes, 1)).toISOString();
      }
    }
    const monthFilterActive = startIsoFilter !== null && endIsoFilter !== null;

    const admin = supabaseAdmin();

    // Nombre real de la columna es `payment_method` (no `method`); el
    // schema interno del cliente sigue exponiéndolo como `method` por
    // simetría con `<MethodBadge>` y la URL `?method=…`. El mapeo
    // happens en el .map() de abajo. `driver_id` ya no se selecciona —
    // la columna ya no se muestra en el listado.
    // `leads!inner(...)` fuerza un INNER JOIN: pagos huérfanos (lead
    // borrado físicamente o soft-deleted con `deleted_at != null`) NO
    // aparecen en la respuesta. Antes era un LEFT JOIN y los pagos
    // huérfanos salían con `leads = null` → fila "(lead no encontrado)"
    // en la UI y peor aún, contribuían a los totales globales.
    // Combinamos con `.is('leads.deleted_at', null)` para excluir los
    // soft-deleted (donde el row sigue existiendo en la tabla pero
    // está marcado como borrado).
    let query = admin
      .from('payments')
      .select(
        `id, lead_id, amount, net_amount, payment_method, payment_type,
         status, paid_at, evidence_photo_url, registered_by,
         leads!inner ( client_name, total_amount, sale_type, product_type,
                       payment_status, delivery_status, row_color )`,
        { count: 'exact' },
      )
      .is('leads.deleted_at', null)
      .order('paid_at', { ascending: false });

    if (method) query = query.eq('payment_method', method);
    if (paymentType) query = query.eq('payment_type', paymentType);
    if (monthFilterActive && startIsoFilter && endIsoFilter) {
      query = query
        .gte('paid_at', startIsoFilter)
        .lt('paid_at', endIsoFilter);
    }

    // Filtro por adeudo. Apoyamos en `leads.payment_status` (que
    // savePaymentAction + liquidateLeadAction mantienen actualizado)
    // en lugar de recalcular sum(payments) por cada lead — más rápido
    // y preserva el `count: 'exact'` correcto para paginación.
    //   'liquidado' → leads.payment_status = 'pagado'
    //   'pendiente' → leads.payment_status ≠ 'pagado'
    // Misma sintaxis de filter sobre relación embebida que el ilike
    // de client_name de abajo.
    if (adeudoFilter === 'liquidado') {
      query = query.eq('leads.payment_status', 'pagado');
    } else if (adeudoFilter === 'pendiente') {
      query = query.neq('leads.payment_status', 'pagado');
    }

    // Búsqueda por nombre o teléfono del cliente — consistente con
    // /leads (que ya busca por ambos campos). PostgREST permite
    // `.or()` sobre una relación embebida cuando pasamos
    // `referencedTable`: cada fragmento del OR se aplica sobre la
    // tabla `leads`. `qInput` ya viene normalizado (lowercase + sin
    // acentos) desde `sanitizeQuery`.
    if (qInput) {
      query = query.or(
        `client_name.ilike.*${qInput}*,phone.ilike.*${qInput}*`,
        { referencedTable: 'leads' },
      );
    }

    // Cap defensivo: la tabla ahora paginará por LEAD (en JS) tras
    // agrupar, no por pago. Traemos hasta 1000 pagos que matchean los
    // filtros para identificar los leads relevantes; en práctica un
    // mes típico cae muy por debajo. Si llegáramos al cap, el efecto
    // es que las páginas más viejas no aparecen — preferible a
    // OOM o queries lentas.
    query = query.limit(1000);

    const { data, error } = await query;
    if (error) {
      return <ErrorState message={`Error leyendo pagos: ${error.message}`} />;
    }

    type RawLeadJoin = {
      client_name: string;
      total_amount: number | string | null;
      sale_type: string | null;
      product_type: string | null;
      payment_status: string | null;
      delivery_status: string | null;
      row_color: string | null;
    };
    type RawPayment = {
      id: string;
      lead_id: string | null;
      amount: number | string | null;
      net_amount: number | string | null;
      payment_method: string | null;
      payment_type: string | null;
      status: string | null;
      paid_at: string | null;
      evidence_photo_url: string | null;
      registered_by: string | null;
      leads: RawLeadJoin | RawLeadJoin[] | null;
    };

    const filteredMatchRows = (data ?? []) as RawPayment[];

    // Identificamos los lead_ids que MATCHEAN los filtros y luego
    // hacemos un SEGUNDO SELECT para traer TODOS los pagos de esos
    // leads (no solo los que pasan el filtro). Esto es lo que permite
    // que la tabla agrupada muestre `monto_cobrado_total` real y que
    // el modal de detalle liste TODOS los pagos del lead aunque la
    // búsqueda esté filtrando por método/tipo/etc. Mismo principio
    // que `/leads` cuando agrupa por cliente.
    const matchingLeadIds = Array.from(
      new Set(
        filteredMatchRows
          .map((r) => r.lead_id)
          .filter((x): x is string => !!x),
      ),
    );

    let rawRows: RawPayment[] = [];
    if (matchingLeadIds.length > 0) {
      const { data: allLeadPayments, error: allErr } = await admin
        .from('payments')
        .select(
          `id, lead_id, amount, net_amount, payment_method, payment_type,
           status, paid_at, evidence_photo_url, registered_by,
           leads!inner ( client_name, total_amount, sale_type, product_type,
                         payment_status, delivery_status, row_color )`,
        )
        .in('lead_id', matchingLeadIds)
        .is('leads.deleted_at', null)
        .order('paid_at', { ascending: false });
      if (allErr) {
        return (
          <ErrorState
            message={`Error leyendo pagos de los leads: ${allErr.message}`}
          />
        );
      }
      rawRows = (allLeadPayments ?? []) as RawPayment[];
    }

    // Resolver nombres de quien registró cada pago — los usa el modal
    // de detalle por lead (timeline). Bulk lookup deduplicado;
    // best-effort: si falla, los nombres caen a "—" en el cliente.
    const registeredByIds = Array.from(
      new Set(
        rawRows
          .map((r) => r.registered_by)
          .filter((x): x is string => !!x),
      ),
    );
    const nameByUserId = new Map<string, string>();
    if (registeredByIds.length > 0) {
      try {
        const { data: profiles, error: profErr } = await admin
          .from('profiles')
          .select('id, full_name')
          .in('id', registeredByIds);
        if (profErr) {
          console.error(
            '[PaymentsPage] registered_by names lookup falló (no fatal):',
            profErr,
          );
        } else {
          for (const p of profiles ?? []) {
            nameByUserId.set(p.id, p.full_name ?? '(sin nombre)');
          }
        }
      } catch (e) {
        console.error(
          '[PaymentsPage] registered_by excepción (no fatal):',
          e,
        );
      }
    }

    // Cargar solo los deducibles de la página actual; el SELECT de
    // profiles para resolver nombre de chofer se eliminó junto con la
    // columna del listado.
    const paymentIds = rawRows.map((r) => r.id);
    const dedResult =
      paymentIds.length > 0
        ? await admin
            .from('payment_deductibles')
            .select('payment_id, concept, amount')
            .in('payment_id', paymentIds)
        : { data: [], error: null };

    if (dedResult.error) {
      return <ErrorState message={`Error leyendo deducibles: ${dedResult.error.message}`} />;
    }

    const dedByPaymentId = new Map<string, { concept: string; amount: number }[]>();
    for (const d of dedResult.data ?? []) {
      const list = dedByPaymentId.get(d.payment_id) ?? [];
      list.push({ concept: d.concept, amount: Number(d.amount ?? 0) });
      dedByPaymentId.set(d.payment_id, list);
    }

    // Bulk: total pagado (status='exitoso') por lead — para calcular
    // adeudo de cada lead visible. Una sola query, group by JS.
    const visibleLeadIds = Array.from(
      new Set(
        rawRows
          .map((r) => r.lead_id)
          .filter((x): x is string => !!x),
      ),
    );
    const paidByLead = new Map<string, number>();
    if (visibleLeadIds.length > 0) {
      const { data: paidRows, error: paidErr } = await admin
        .from('payments')
        .select('lead_id, amount')
        .eq('status', 'exitoso')
        .in('lead_id', visibleLeadIds);
      if (paidErr) {
        console.error(
          '[PaymentsPage] paid lookup falló (no fatal):',
          paidErr,
        );
      } else {
        for (const p of paidRows ?? []) {
          if (!p.lead_id) continue;
          paidByLead.set(
            p.lead_id,
            (paidByLead.get(p.lead_id) ?? 0) + Number(p.amount ?? 0),
          );
        }
      }
    }

    // Bulk: lead_ids con pago contra_entrega — para regla naranja.
    // Try/catch defensivo por si el enum aún no tiene el valor o
    // PostgREST tiene el schema cache stale; la regla naranja es
    // cosmética y no debe tirar la página entera.
    const contraEntregaSet = new Set<string>();
    if (visibleLeadIds.length > 0) {
      try {
        const { data: ceRows, error: ceErr } = await admin
          .from('payments')
          .select('lead_id')
          .eq('payment_type', 'contra_entrega')
          .in('lead_id', visibleLeadIds);
        if (ceErr) {
          console.error(
            '[PaymentsPage] contra_entrega lookup falló (no fatal):',
            ceErr,
          );
        } else {
          for (const p of ceRows ?? []) {
            if (p.lead_id) contraEntregaSet.add(p.lead_id);
          }
        }
      } catch (e) {
        console.error(
          '[PaymentsPage] contra_entrega excepción (no fatal):',
          e,
        );
      }
    }
    const contraEntregaLeadIds = Array.from(contraEntregaSet);

    // Safety-net JS-side: si por alguna razón un row se cuela con
    // `leads = null` o sin `lead_id` (ej: cache de PostgREST stale,
    // diferencia transitoria entre el momento del JOIN y del SELECT
    // embebido), igual lo filtramos. El `!inner` ya debería cubrir
    // este caso server-side; este check es defensa en profundidad.
    const filteredRawRows = rawRows.filter((r) => {
      const leadObj = Array.isArray(r.leads) ? r.leads[0] : r.leads;
      if (!leadObj) return false;
      if (typeof r.lead_id !== 'string' || r.lead_id.length === 0) {
        return false;
      }
      return true;
    });

    const rows: PaymentRow[] = filteredRawRows.map((r) => {
      const leadObj = Array.isArray(r.leads) ? r.leads[0] : r.leads;
      const leadId = r.lead_id ?? '';
      const leadTotal = Number(leadObj?.total_amount ?? 0);
      const paidSoFar = leadId ? paidByLead.get(leadId) ?? 0 : 0;
      const adeudo = Math.max(0, leadTotal - paidSoFar);
      return {
        id: r.id,
        lead_id: leadId,
        // El filter anterior garantiza que `leadObj` exista, pero
        // dejamos el fallback por si el TS narrowing no lo ve.
        client_name: leadObj?.client_name ?? '(lead no encontrado)',
        amount: Number(r.amount ?? 0),
        net_amount: Number(r.net_amount ?? 0),
        // DB column `payment_method` se expone al cliente como `method`
        // para mantener el contrato simple del PaymentRow.
        method: (r.payment_method ?? 'efectivo') as 'efectivo' | 'transferencia' | 'clip',
        payment_type: (r.payment_type ?? 'anticipo') as
          | 'anticipo'
          | 'liquidacion'
          | 'contra_entrega',
        status: (r.status ?? 'exitoso') as 'exitoso' | 'pendiente' | 'rechazado',
        paid_at: r.paid_at,
        evidence_photo_url: r.evidence_photo_url,
        deductibles: dedByPaymentId.get(r.id) ?? [],
        // Datos del lead para colorear la fila + calcular adeudo.
        lead_sale_type: leadObj?.sale_type ?? null,
        lead_product_type: leadObj?.product_type ?? null,
        lead_payment_status:
          (leadObj?.payment_status as PaymentRow['lead_payment_status']) ??
          'pendiente',
        lead_delivery_status:
          (leadObj?.delivery_status as PaymentRow['lead_delivery_status']) ??
          'pendiente',
        lead_row_color: leadObj?.row_color ?? null,
        lead_total_amount: leadTotal,
        adeudo,
        // Nombre del usuario que insertó el pago — null si no se pudo
        // resolver (registered_by ausente o perfil borrado).
        registered_by_name: r.registered_by
          ? nameByUserId.get(r.registered_by) ?? null
          : null,
      };
    });

    // El bucket `payments-evidence` es PRIVADO en Supabase. La
    // `pub.publicUrl` que se guardó al subir devuelve 404 en el
    // navegador porque el path /object/public/ requiere bucket
    // público. Firmamos signed URLs (1h TTL) en bulk antes de
    // pasarlas al cliente. Si la URL es de otro bucket o no parsea,
    // signEvidenceUrl la deja como está (best-effort).
    const signedEvidence = await signEvidenceUrls(
      rows.map((r) => r.evidence_photo_url),
      'payments-evidence',
    );
    for (let i = 0; i < rows.length; i++) {
      rows[i].evidence_photo_url = signedEvidence[i];
    }

    // ── Agrupado por lead. Cada fila de la tabla representa UN lead
    // con TODOS sus pagos (el segundo SELECT trajo todos), no un pago
    // suelto. La paginación cuenta LEADS, no pagos.
    type LeadGroupBuild = {
      lead_id: string;
      client_name: string;
      total_amount: number;
      adeudo: number;
      payments: PaymentRow[];
      latestPaidAt: string;
      // Campos de coloreado a nivel lead — los mismos para todas las
      // filas del lead, así que tomamos cualquiera (la primera).
      lead_sale_type: string | null;
      lead_product_type: string | null;
      lead_payment_status: PaymentRow['lead_payment_status'];
      lead_delivery_status: PaymentRow['lead_delivery_status'];
      lead_row_color: string | null;
    };
    const groupMap = new Map<string, LeadGroupBuild>();
    for (const r of rows) {
      const existing = groupMap.get(r.lead_id);
      if (existing) {
        existing.payments.push(r);
        // Llevamos la fecha más reciente para ordenar grupos al final.
        if ((r.paid_at ?? '') > existing.latestPaidAt) {
          existing.latestPaidAt = r.paid_at ?? '';
        }
      } else {
        groupMap.set(r.lead_id, {
          lead_id: r.lead_id,
          client_name: r.client_name,
          total_amount: r.lead_total_amount,
          adeudo: r.adeudo,
          payments: [r],
          latestPaidAt: r.paid_at ?? '',
          lead_sale_type: r.lead_sale_type,
          lead_product_type: r.lead_product_type,
          lead_payment_status: r.lead_payment_status,
          lead_delivery_status: r.lead_delivery_status,
          lead_row_color: r.lead_row_color,
        });
      }
    }
    const allGroups: LeadGroupBuild[] = Array.from(groupMap.values()).sort(
      (a, b) => b.latestPaidAt.localeCompare(a.latestPaidAt),
    );

    // Computar agregados por grupo. Métodos / tipos = 'varios' si hay
    // mezcla. Monto/deducibles/neto se calculan SOLO con pagos
    // exitosos (lo mismo que reportan las cards superiores).
    const leadGroups = allGroups.map((g) => {
      const sortedPayments = [...g.payments].sort((a, b) =>
        (b.paid_at ?? '').localeCompare(a.paid_at ?? ''),
      );
      const exitosos = sortedPayments.filter((p) => p.status === 'exitoso');
      const montoCobrado = exitosos.reduce((s, p) => s + p.amount, 0);
      const deduciblesTotal = exitosos.reduce(
        (s, p) => s + p.deductibles.reduce((ss, d) => ss + d.amount, 0),
        0,
      );
      const netoTotal = Math.max(0, montoCobrado - deduciblesTotal);
      const methods = new Set(sortedPayments.map((p) => p.method));
      const types = new Set(sortedPayments.map((p) => p.payment_type));
      const latest = sortedPayments[0];
      return {
        lead_id: g.lead_id,
        client_name: g.client_name,
        total_amount: g.total_amount,
        adeudo: g.adeudo,
        payments: sortedPayments,
        monto_cobrado_total: montoCobrado,
        deducibles_total: deduciblesTotal,
        neto_total: netoTotal,
        ultimo_metodo:
          methods.size === 1
            ? (Array.from(methods)[0] as PaymentRow['method'])
            : ('varios' as const),
        ultimo_tipo:
          types.size === 1
            ? (Array.from(types)[0] as PaymentRow['payment_type'])
            : ('varios' as const),
        ultima_fecha: latest?.paid_at ?? null,
        tiene_evidencia: sortedPayments.some(
          (p) => p.evidence_photo_url != null,
        ),
        payments_count: sortedPayments.length,
        lead_sale_type: g.lead_sale_type,
        lead_product_type: g.lead_product_type,
        lead_payment_status: g.lead_payment_status,
        lead_delivery_status: g.lead_delivery_status,
        lead_row_color: g.lead_row_color,
      };
    });

    const total = leadGroups.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const pageStart = (pageNumber - 1) * PAGE_SIZE;
    const pageEnd = pageStart + PAGE_SIZE;
    const pagedLeadGroups = leadGroups.slice(pageStart, pageEnd);

    // "Por cobrar" — suma de adeudos pendientes sobre los leads
    // visibles (no toda la BD), así el número refleja la vista
    // filtrada que el usuario tiene en pantalla. Cada `adeudo` ya
    // es `max(0, total - sum(pagos exitosos))`, calculado en el
    // mapping; aquí solo sumamos.
    const totalOutstanding = leadGroups.reduce(
      (s, g) => s + g.adeudo,
      0,
    );

    // Totales globales (no de la página) — consulta extra rápida sin
    // range. Mismo INNER JOIN + filtro de soft-delete que la query
    // principal: los pagos huérfanos NO deben inflar Cobrado bruto /
    // Ingreso neto.
    const { data: totalsData } = await admin
      .from('payments')
      .select('amount, net_amount, leads!inner(deleted_at)')
      .eq('status', 'exitoso')
      .is('leads.deleted_at', null);
    const totalGross = (totalsData ?? []).reduce(
      (s, p) => s + Number(p.amount ?? 0),
      0,
    );
    const totalNet = (totalsData ?? []).reduce(
      (s, p) => s + Number(p.net_amount ?? 0),
      0,
    );

    // Conteo de leads con adeudo pendiente. Para el badge del select
    // de filtro: "Con adeudo (N)". Usamos `payment_status ≠ 'pagado'`
    // sobre `leads` activos (no eliminados/cancelados).
    //
    // Non-fatal: si el COUNT falla, dejamos en 0 y el select no muestra
    // contador — preferible a abortar la página entera.
    const { count: pendingLeadCount, error: pendingErr } = await admin
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .in('payment_status', ['pendiente', 'parcial'])
      .is('deleted_at', null);
    if (pendingErr) {
      console.error(
        '[PaymentsPage] pending leads count falló (no fatal):',
        pendingErr,
      );
    }

    // Rol del usuario actual. Lo usamos para mostrar el botón "Editar"
    // en cada fila solo a admin/admin2. La action ya valida server-side;
    // ocultar el botón es una mejora de UX (no de seguridad).
    let isAdmin = false;
    try {
      const userClient = await supabaseServer();
      const {
        data: { user },
      } = await userClient.auth.getUser();
      if (user) {
        const { data: callerProfile } = await admin
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .maybeSingle();
        const role = callerProfile?.role ?? '';
        isAdmin = role === 'admin' || role === 'admin2';
      }
    } catch (e) {
      console.error(
        '[PaymentsPage] role lookup falló (no fatal):',
        e,
      );
    }

    return (
      <PaymentsClient
        leadGroups={pagedLeadGroups}
        total={total}
        page={pageNumber}
        pageSize={PAGE_SIZE}
        totalPages={totalPages}
        filters={{
          q: qInput,
          method,
          type: paymentType,
          mes: monthFilterActive ? mes : 0,
          anio: monthFilterActive ? anio : 0,
          adeudo: adeudoFilter,
        }}
        totals={{
          gross: totalGross,
          deductibles: totalGross - totalNet,
          net: totalNet,
          outstanding: totalOutstanding,
        }}
        pendingLeadCount={pendingLeadCount ?? 0}
        contraEntregaLeadIds={contraEntregaLeadIds}
        isAdmin={isAdmin}
      />
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al cargar pagos';
    console.error('[PaymentsPage] excepción no controlada:', err);
    return <ErrorState message={message} />;
  }
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar los pagos</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </div>
  );
}
