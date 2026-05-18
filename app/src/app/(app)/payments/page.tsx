import { supabaseAdmin } from '@/lib/supabase/admin';
import { signEvidenceUrls } from '@/lib/supabase/storage';
import { PaymentsClient, type PaymentRow } from './payments-client';

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

function sanitizeQuery(q: string): string {
  return q.replace(/[,%*\\()]/g, '').trim().slice(0, 80);
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

    // Filtro mes/anio (ambos opcionales pero deben venir JUNTOS).
    // Drill-down típico desde el card "Cobrado en el mes" del dashboard.
    const mesRaw = Number.parseInt(pickStr(raw.mes), 10);
    const anioRaw = Number.parseInt(pickStr(raw.anio), 10);
    const mes =
      Number.isFinite(mesRaw) && mesRaw >= 1 && mesRaw <= 12 ? mesRaw : 0;
    const anio =
      Number.isFinite(anioRaw) && anioRaw >= 2000 && anioRaw <= 2100
        ? anioRaw
        : 0;
    const monthFilterActive = mes > 0 && anio > 0;
    // `paid_at` es timestamptz — comparamos con ISO completo.
    const startOfMonthIso = monthFilterActive
      ? new Date(Date.UTC(anio, mes - 1, 1)).toISOString()
      : null;
    const startOfNextMonthIso = monthFilterActive
      ? new Date(Date.UTC(anio, mes, 1)).toISOString()
      : null;

    const admin = supabaseAdmin();

    // Nombre real de la columna es `payment_method` (no `method`); el
    // schema interno del cliente sigue exponiéndolo como `method` por
    // simetría con `<MethodBadge>` y la URL `?method=…`. El mapeo
    // happens en el .map() de abajo. `driver_id` ya no se selecciona —
    // la columna ya no se muestra en el listado.
    let query = admin
      .from('payments')
      .select(
        `id, lead_id, amount, net_amount, payment_method, payment_type,
         status, paid_at, evidence_photo_url,
         leads ( client_name, total_amount, sale_type, product_type,
                 payment_status, delivery_status, row_color )`,
        { count: 'exact' },
      )
      .order('paid_at', { ascending: false });

    if (method) query = query.eq('payment_method', method);
    if (paymentType) query = query.eq('payment_type', paymentType);
    if (monthFilterActive && startOfMonthIso && startOfNextMonthIso) {
      query = query
        .gte('paid_at', startOfMonthIso)
        .lt('paid_at', startOfNextMonthIso);
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

    // Búsqueda por nombre del cliente — la sintaxis `leads.client_name.ilike`
    // funciona cuando hay embedding del lead. Si la DB rechaza este filter
    // (depende de la versión de PostgREST), el banner mostrará el error
    // exacto y lo cambiamos a un IN sobre lead_ids resueltos en memoria.
    if (qInput) {
      query = query.ilike('leads.client_name', `*${qInput}*`);
    }

    const start = (pageNumber - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE - 1;
    query = query.range(start, end);

    const { data, error, count } = await query;
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
      leads: RawLeadJoin | RawLeadJoin[] | null;
    };

    const rawRows = (data ?? []) as RawPayment[];

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

    const rows: PaymentRow[] = rawRows.map((r) => {
      const leadObj = Array.isArray(r.leads) ? r.leads[0] : r.leads;
      const leadId = r.lead_id ?? '';
      const leadTotal = Number(leadObj?.total_amount ?? 0);
      const paidSoFar = leadId ? paidByLead.get(leadId) ?? 0 : 0;
      const adeudo = Math.max(0, leadTotal - paidSoFar);
      return {
        id: r.id,
        lead_id: leadId,
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

    const total = count ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    // Totales globales (no de la página) — consulta extra rápida sin range.
    const { data: totalsData } = await admin
      .from('payments')
      .select('amount, net_amount')
      .eq('status', 'exitoso');
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

    return (
      <PaymentsClient
        payments={rows}
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
        }}
        pendingLeadCount={pendingLeadCount ?? 0}
        contraEntregaLeadIds={contraEntregaLeadIds}
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
