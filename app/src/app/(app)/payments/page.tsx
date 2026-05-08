import { supabaseAdmin } from '@/lib/supabase/admin';
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

type RawSearchParams = {
  q?: string | string[];
  method?: string | string[];
  type?: string | string[];
  /** Mes 1-12 — si presente filtra `paid_at` por la ventana del mes. */
  mes?: string | string[];
  /** Año 4-dígitos — pareja inseparable con `mes`. */
  anio?: string | string[];
  page?: string | string[];
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
        `id, amount, net_amount, payment_method, payment_type, status, paid_at,
         evidence_photo_url,
         leads ( client_name )`,
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

    type RawPayment = {
      id: string;
      amount: number | string | null;
      net_amount: number | string | null;
      payment_method: string | null;
      payment_type: string | null;
      status: string | null;
      paid_at: string | null;
      evidence_photo_url: string | null;
      leads: { client_name: string } | { client_name: string }[] | null;
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

    const rows: PaymentRow[] = rawRows.map((r) => {
      const leadObj = Array.isArray(r.leads) ? r.leads[0] : r.leads;
      return {
        id: r.id,
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
      };
    });

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
        }}
        totals={{
          gross: totalGross,
          deductibles: totalGross - totalNet,
          net: totalNet,
        }}
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
