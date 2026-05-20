import { supabaseAdmin } from '@/lib/supabase/admin';
import { signEvidenceUrl, signEvidenceUrls } from '@/lib/supabase/storage';
import {
  EntregasClient,
  type EntregaRow,
  type DriverOption,
  type IssueRow,
  type RouteCandidate,
  type LeadDetail,
  type LeadPayment,
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

// Mismo whitelist que /leads/page.tsx para los tabs de color (4
// automáticos + 2 manuales + 'all'/'' = sin filtro). Mantener sync
// con /leads para no divergir entre las dos vistas.
const COLOR_FILTER_VALUES = [
  'all',
  'azul',
  'rosa',
  'naranja',
  'amarillo',
  'verde',
  'morado',
] as const;

type RawSearchParams = {
  driver?: string | string[];
  status?: string | string[];
  /** Fecha YYYY-MM-DD para la sección "Ruta del día". Default = hoy
   *  (UTC) en page.tsx si no viene o es inválida. */
  fecha?: string | string[];
  /** Tab de color (ver COLOR_FILTER_VALUES). 'all' o vacío = sin filtro. */
  color_filter?: string | string[];
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

    const colorFilterRaw = whitelist(pickStr(raw.color_filter), COLOR_FILTER_VALUES);
    // 'all' y '' son equivalentes (sin filtro). Normalizamos a ''.
    const colorFilter: '' | Exclude<typeof colorFilterRaw, 'all' | ''> =
      colorFilterRaw === 'all' || colorFilterRaw === ''
        ? ''
        : (colorFilterRaw as Exclude<typeof colorFilterRaw, 'all' | ''>);

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
        `id, client_name, phone, address, maps_url, channel, total_amount,
         delivery_status, payment_status, sale_date, created_at,
         driver_id, seller_id, sale_type, product_type, purchase_type, row_color,
         failed_delivery_reason, failed_delivery_photo_url, stock_returned,
         cost_per_sheet, has_hojas, has_cubrecanto, has_catalogo,
         cuts_count, cuts_total, edge_banding_type, edge_banding_meters,
         edge_banding_total, edgebanding_manual_cost, catalog_price,
         delivery_cost, document_url, document_urls,
         sellers ( name ),
         lead_colors ( quantity, cost_per_sheet, unit_cost, colors ( name ) ),
         lead_edgebanding_colors ( quantity, colors ( name ) )`,
      )
      .is('deleted_at', null);

    if (validDriver) query = query.eq('driver_id', validDriver);
    if (statusFilter === 'pendiente') {
      query = query.in('delivery_status', ['pendiente', 'en_transito']);
    } else if (statusFilter) {
      query = query.eq('delivery_status', statusFilter);
    }

    // Filtro por color (tab). Mismo patrón que /leads/page.tsx para
    // mantener semántica consistente — un drill-down desde /leads que
    // navegue a /admin/entregas con el mismo `color_filter` ve los
    // mismos leads. Naranja requiere un pre-query a `payments` para
    // resolver los lead_ids con pago contra_entrega.
    if (colorFilter === 'azul') {
      query = query.or('product_type.eq.con_corte,row_color.eq.azul');
    } else if (colorFilter === 'rosa') {
      query = query.or('sale_type.eq.venta_empleado,row_color.eq.rosa');
    } else if (colorFilter === 'amarillo') {
      // Amarillo es 100% manual; sólo coincide con row_color='amarillo'.
      query = query.eq('row_color', 'amarillo');
    } else if (colorFilter === 'naranja') {
      // Pre-query defensivo: tolerar enum sin 'contra_entrega' o
      // schema cache stale (mismo manejo que /leads/page.tsx).
      let ceIds: string[] = [];
      try {
        const { data: ceLeads, error: ceErr } = await admin
          .from('payments')
          .select('lead_id')
          .eq('payment_type', 'contra_entrega');
        if (ceErr) {
          console.error(
            '[EntregasPage] naranja contra_entrega lookup falló (no fatal):',
            ceErr,
          );
        } else {
          ceIds = Array.from(
            new Set(
              (ceLeads ?? [])
                .map((p) => p.lead_id)
                .filter((x): x is string => !!x),
            ),
          );
        }
      } catch (e) {
        console.error(
          '[EntregasPage] naranja contra_entrega excepción (no fatal):',
          e,
        );
      }
      if (ceIds.length > 0) {
        query = query.or(`row_color.eq.naranja,id.in.(${ceIds.join(',')})`);
      } else {
        query = query.eq('row_color', 'naranja');
      }
    } else if (colorFilter === 'verde') {
      query = query.eq('row_color', 'verde');
    } else if (colorFilter === 'morado') {
      query = query.eq('row_color', 'morado');
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
      phone: string | null;
      address: string | null;
      maps_url: string | null;
      channel: string | null;
      total_amount: number | string | null;
      delivery_status: string | null;
      payment_status: string | null;
      sale_date: string | null;
      created_at: string | null;
      driver_id: string | null;
      seller_id: string | null;
      sale_type: string | null;
      product_type: string | null;
      purchase_type: string | null;
      row_color: string | null;
      failed_delivery_reason: string | null;
      failed_delivery_photo_url: string | null;
      stock_returned: boolean | null;
      cost_per_sheet: number | string | null;
      has_hojas: boolean | null;
      has_cubrecanto: boolean | null;
      has_catalogo: boolean | null;
      cuts_count: number | null;
      cuts_total: number | string | null;
      edge_banding_type: string | null;
      edge_banding_meters: number | string | null;
      edge_banding_total: number | string | null;
      edgebanding_manual_cost: number | string | null;
      catalog_price: number | string | null;
      delivery_cost: number | string | null;
      document_url: string | null;
      document_urls: string[] | null;
      sellers: { name: string } | { name: string }[] | null;
      lead_colors:
        | {
            quantity: number | null;
            cost_per_sheet: number | null;
            unit_cost: number | null;
            colors: { name: string } | { name: string }[] | null;
          }[]
        | null;
      lead_edgebanding_colors:
        | {
            quantity: number | null;
            colors: { name: string } | { name: string }[] | null;
          }[]
        | null;
    };

    // Acumulamos los detalles por lead aquí mientras mapeamos `rows`;
    // el modal de detalle del cliente los consume sin re-fetch.
    const leadDetails: Record<string, LeadDetail> = {};

    const rows: EntregaRow[] = ((leadsData ?? []) as RawLead[]).map((l) => {
      const total = Number(l.total_amount ?? 0);
      const paid = paidByLead.get(l.id) ?? 0;
      const adeudo = Math.max(0, total - paid);
      // Fallback: si lead_colors.cost_per_sheet es null (lead viejo
      // pre-migración), usamos el costo del lead como representante de
      // la fila — al menos algo a mostrar en el desglose.
      const legacyCost = Number(l.cost_per_sheet ?? 0);
      const colors = (l.lead_colors ?? [])
        .map((lc) => {
          const colorObj = Array.isArray(lc.colors) ? lc.colors[0] : lc.colors;
          return {
            color_name: colorObj?.name ?? '(sin nombre)',
            quantity: Number(lc.quantity ?? 0),
            cost_per_sheet:
              lc.cost_per_sheet == null
                ? legacyCost
                : Number(lc.cost_per_sheet),
          };
        })
        .filter((c) => c.quantity > 0);
      // Colores del cubrecanto — informativos para el chofer
      // (qué llevar). No tienen costo asociado por fila; el costo
      // está en `edgebanding_manual_cost` a nivel de lead.
      const edgebandingColors = (l.lead_edgebanding_colors ?? [])
        .map((lc) => {
          const colorObj = Array.isArray(lc.colors) ? lc.colors[0] : lc.colors;
          return {
            color_name: colorObj?.name ?? '(sin nombre)',
            quantity: Number(lc.quantity ?? 0),
          };
        })
        .filter((c) => c.quantity > 0);
      // Datos extendidos del lead para el modal de detalle. Se calculan
      // una vez aquí (mismo loop) para no duplicar parsing.
      const sellerObj = Array.isArray(l.sellers) ? l.sellers[0] : l.sellers;
      const documentUrlsArr = Array.isArray(l.document_urls)
        ? (l.document_urls as string[]).filter((u): u is string => !!u)
        : [];
      const mergedDocs =
        documentUrlsArr.length > 0
          ? documentUrlsArr
          : l.document_url
            ? [l.document_url]
            : [];
      const colorsWithUnit = (l.lead_colors ?? [])
        .map((lc) => {
          const colorObj = Array.isArray(lc.colors) ? lc.colors[0] : lc.colors;
          const unit =
            lc.unit_cost != null
              ? Number(lc.unit_cost)
              : lc.cost_per_sheet != null
                ? Number(lc.cost_per_sheet)
                : legacyCost;
          return {
            color_name: colorObj?.name ?? '(sin nombre)',
            quantity: Number(lc.quantity ?? 0),
            unit_cost: unit,
          };
        })
        .filter((c) => c.quantity > 0);

      leadDetails[l.id] = {
        phone: l.phone ?? '',
        channel: l.channel ?? '',
        seller_name: sellerObj?.name ?? null,
        has_hojas: Boolean(l.has_hojas),
        has_cubrecanto: Boolean(l.has_cubrecanto),
        has_catalogo: Boolean(l.has_catalogo),
        cuts_count: l.cuts_count ?? null,
        cuts_total: l.cuts_total == null ? null : Number(l.cuts_total),
        edge_banding_type: l.edge_banding_type ?? null,
        edge_banding_meters:
          l.edge_banding_meters == null ? null : Number(l.edge_banding_meters),
        edge_banding_total:
          l.edge_banding_total == null ? null : Number(l.edge_banding_total),
        edgebanding_manual_cost:
          l.edgebanding_manual_cost == null
            ? null
            : Number(l.edgebanding_manual_cost),
        catalog_price:
          l.catalog_price == null ? null : Number(l.catalog_price),
        delivery_cost:
          l.delivery_cost == null ? null : Number(l.delivery_cost),
        document_urls: mergedDocs,
        colors_with_unit: colorsWithUnit,
        payments: [],
      };

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
        sale_type: l.sale_type,
        product_type: l.product_type,
        purchase_type: l.purchase_type,
        row_color: l.row_color,
        failed_delivery_reason: l.failed_delivery_reason,
        failed_delivery_photo_url: l.failed_delivery_photo_url,
        // Default a false si la columna aún no existe en DB
        // (migración pendiente): la UI trata null como "no devuelto",
        // pinta la fila roja y muestra el botón.
        stock_returned: l.stock_returned ?? false,
        colors,
        edgebanding_colors: edgebandingColors,
      };
    });

    // Bulk de pagos por lead (todos, no solo exitosos) para mostrar la
    // lista en el modal. Una sola query, agrupamos por lead_id.
    if (leadIds.length > 0) {
      try {
        const { data: pmtRows, error: pmtErr } = await admin
          .from('payments')
          .select(
            'id, lead_id, amount, method, payment_type, status, paid_at, created_at',
          )
          .in('lead_id', leadIds)
          .order('created_at', { ascending: false });
        if (pmtErr) {
          console.error(
            '[EntregasPage] payments detail select falló (no fatal):',
            pmtErr,
          );
        } else {
          for (const p of pmtRows ?? []) {
            if (!p.lead_id) continue;
            const detail = leadDetails[p.lead_id];
            if (!detail) continue;
            const row: LeadPayment = {
              id: p.id,
              amount: Number(p.amount ?? 0),
              method: (p.method as string) ?? '',
              payment_type: (p.payment_type as string) ?? '',
              status: (p.status as string) ?? '',
              paid_at: p.paid_at ?? p.created_at ?? null,
            };
            detail.payments.push(row);
          }
        }
      } catch (e) {
        console.error(
          '[EntregasPage] payments detail excepción (no fatal):',
          e,
        );
      }
    }

    // Lookup bulk de pagos contra_entrega para los leads visibles.
    // Mismo patrón que /leads. Un lead con AL MENOS un payment
    // contra_entrega se marca naranja por las reglas de color de fila.
    // Try/catch para tolerar enum sin 'contra_entrega' o schema cache
    // stale en PostgREST — no bloqueamos la página por una métrica de
    // color que es cosmética.
    const contraEntregaSet = new Set<string>();
    if (leadIds.length > 0) {
      try {
        const { data: ceData, error: ceErr } = await admin
          .from('payments')
          .select('lead_id')
          .eq('payment_type', 'contra_entrega')
          .in('lead_id', leadIds);
        if (ceErr) {
          console.error(
            '[EntregasPage] contra_entrega lookup falló (no fatal):',
            ceErr,
          );
        } else {
          for (const p of ceData ?? []) {
            if (p.lead_id) contraEntregaSet.add(p.lead_id);
          }
        }
      } catch (e) {
        console.error(
          '[EntregasPage] contra_entrega excepción (no fatal):',
          e,
        );
      }
    }
    const contraEntregaLeadIds = Array.from(contraEntregaSet);

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

    // Cargar driver_deliveries (Grupo 4) — evidencia del cobro hecho
    // por el chofer. Bulk SELECT para los leads visibles, mismo
    // patrón que los otros bulk-lookups arriba. Si la tabla no
    // existe / RLS bloquea, el catch loguea y la columna
    // "Evidencia cobro" queda vacía.
    //
    // Adicional 2026-05: también resolvemos el `payment_method` del
    // cobro hecho por el chofer (último payment con driver_id != null
    // por lead). Como `driver_deliveries` no almacena el método, lo
    // sacamos de la tabla `payments` y lo combinamos por lead_id.
    const evidenceByLead: Record<
      string,
      {
        url: string;
        amount: number;
        delivered_at: string | null;
        payment_method: string | null;
      }
    > = {};
    if (leadIds.length > 0) {
      try {
        const { data: deliveriesData, error: delErr } = await admin
          .from('driver_deliveries')
          .select('lead_id, evidence_photo_url, amount_collected, delivered_at')
          .in('lead_id', leadIds)
          .not('evidence_photo_url', 'is', null);
        if (delErr) {
          console.error(
            '[EntregasPage] driver_deliveries select falló (no fatal):',
            delErr,
          );
        } else {
          // Si un lead tiene múltiples driver_deliveries (re-entrega
          // tras falla, etc.), nos quedamos con el más reciente —
          // ordenamos in-memory por delivered_at DESC y tomamos el
          // primero.
          const byLead = new Map<
            string,
            {
              url: string;
              amount: number;
              delivered_at: string | null;
            }[]
          >();
          for (const d of deliveriesData ?? []) {
            if (!d.lead_id || !d.evidence_photo_url) continue;
            const list = byLead.get(d.lead_id) ?? [];
            list.push({
              url: d.evidence_photo_url,
              amount: Number(d.amount_collected ?? 0),
              delivered_at: d.delivered_at ?? null,
            });
            byLead.set(d.lead_id, list);
          }
          for (const [leadId, list] of byLead.entries()) {
            list.sort((a, b) => {
              const ta = a.delivered_at
                ? new Date(a.delivered_at).getTime()
                : 0;
              const tb = b.delivered_at
                ? new Date(b.delivered_at).getTime()
                : 0;
              return tb - ta;
            });
            evidenceByLead[leadId] = {
              ...list[0],
              payment_method: null,
            };
          }
        }
      } catch (e) {
        console.error(
          '[EntregasPage] driver_deliveries lookup excepción (no fatal):',
          e,
        );
      }

      // Resolver payment_method del cobro del chofer (último payment
      // del lead donde driver_id != null). Una query bulk; map por
      // lead_id. Si falla, dejamos payment_method=null silenciosamente.
      try {
        const { data: driverPayments } = await admin
          .from('payments')
          .select('lead_id, payment_method, paid_at')
          .in('lead_id', leadIds)
          .not('driver_id', 'is', null)
          .order('paid_at', { ascending: false });
        const methodByLead = new Map<string, string>();
        for (const p of driverPayments ?? []) {
          if (!p.lead_id) continue;
          if (!methodByLead.has(p.lead_id)) {
            methodByLead.set(p.lead_id, (p.payment_method as string) ?? '');
          }
        }
        for (const leadId of Object.keys(evidenceByLead)) {
          const m = methodByLead.get(leadId);
          if (m) evidenceByLead[leadId].payment_method = m;
        }
      } catch (e) {
        console.error(
          '[EntregasPage] driver payments lookup excepción (no fatal):',
          e,
        );
      }
    }

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
           cost_per_sheet,
           lead_colors ( quantity, cost_per_sheet, colors ( name ) )`,
        )
        .in('delivery_status', ['pendiente', 'en_transito'])
        // La ruta del día sólo aplica a entregas a domicilio. Las
        // compras en fábrica las recoge el cliente, así que NO viajan
        // con un chofer y no deben aparecer entre los candidatos.
        .eq('purchase_type', 'domicilio')
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
          cost_per_sheet: number | string | null;
          lead_colors:
            | {
                quantity: number | null;
                cost_per_sheet: number | null;
                colors: { name: string } | { name: string }[] | null;
              }[]
            | null;
        };
        for (const r of (routeRows ?? []) as RawRouteRow[]) {
          const legacyCost = Number(r.cost_per_sheet ?? 0);
          const colors = (r.lead_colors ?? [])
            .map((lc) => {
              const colorObj = Array.isArray(lc.colors)
                ? lc.colors[0]
                : lc.colors;
              return {
                color_name: colorObj?.name ?? '(sin nombre)',
                quantity: Number(lc.quantity ?? 0),
                cost_per_sheet:
                  lc.cost_per_sheet == null
                    ? legacyCost
                    : Number(lc.cost_per_sheet),
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

    // El bucket `driver-evidence` es PRIVADO. Las URLs públicas que se
    // guardaron al subir devuelven 404 en el navegador (admin se
    // autentica contra Next, no contra Supabase Storage). Firmamos
    // signed URLs (1h TTL) en TRES lugares antes de mandar al cliente:
    //   - rows[].failed_delivery_photo_url (lead-level, bulk)
    //   - evidenceByLead[*].url (driver_deliveries, uno por lead)
    //   - issuesByLead[*][*].photo_url (delivery_issues, bulk)
    //
    // Todo en paralelo para minimizar latencia. Si alguna firma
    // falla, signEvidenceUrl devuelve la URL original (best-effort).
    const evidenceLeadIds = Object.keys(evidenceByLead);
    const issuesFlat: { leadId: string; idx: number; url: string | null }[] = [];
    for (const leadId of Object.keys(issuesByLead)) {
      const list = issuesByLead[leadId];
      for (let i = 0; i < list.length; i++) {
        issuesFlat.push({
          leadId,
          idx: i,
          url: list[i].photo_url,
        });
      }
    }
    const [signedFailed, signedEvidenceList, signedIssues] = await Promise.all([
      signEvidenceUrls(
        rows.map((r) => r.failed_delivery_photo_url),
        'driver-evidence',
      ),
      Promise.all(
        evidenceLeadIds.map((id) =>
          signEvidenceUrl(evidenceByLead[id].url, 'driver-evidence'),
        ),
      ),
      signEvidenceUrls(
        issuesFlat.map((f) => f.url),
        'driver-evidence',
      ),
    ]);
    for (let i = 0; i < rows.length; i++) {
      rows[i].failed_delivery_photo_url = signedFailed[i];
    }
    for (let i = 0; i < evidenceLeadIds.length; i++) {
      const id = evidenceLeadIds[i];
      const signed = signedEvidenceList[i];
      // signEvidenceUrl puede devolver null si la URL era null, pero
      // acá filtramos antes (evidenceByLead solo tiene URLs no-null);
      // el ?? deja la original si la firma fue null por error.
      evidenceByLead[id] = {
        ...evidenceByLead[id],
        url: signed ?? evidenceByLead[id].url,
      };
    }
    for (let i = 0; i < issuesFlat.length; i++) {
      const { leadId, idx } = issuesFlat[i];
      issuesByLead[leadId][idx].photo_url = signedIssues[i];
    }

    return (
      <EntregasClient
        rows={rows}
        drivers={drivers}
        filters={{
          driver: validDriver,
          status: statusFilter,
          color_filter: colorFilter,
        }}
        issuesByLead={issuesByLead}
        routeDate={routeDate}
        routeCandidates={routeCandidates}
        evidenceByLead={evidenceByLead}
        contraEntregaLeadIds={contraEntregaLeadIds}
        leadDetails={leadDetails}
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
