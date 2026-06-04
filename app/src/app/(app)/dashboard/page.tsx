import Link from 'next/link';
import {
  ClipboardList,
  DollarSign,
  Truck,
  TriangleAlert,
  TrendingUp,
  Wallet,
  PackagePlus,
  Banknote,
  Layers,
  Ruler,
  Factory,
  Home,
  ShieldCheck,
  ArrowLeftRight,
  CreditCard,
} from 'lucide-react';
import {
  ChannelBadge,
  DeliveryBadge,
  PaymentBadge,
} from '@/components/ui/Badges';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { formatMXN, type Channel } from '@/data/mock';
import { PeriodFilter } from './dashboard-client';
import {
  getDateWindow,
  normalizeSaleType,
  SALE_TYPE_SUBTITLE,
} from './constants';

/**
 * Dashboard /dashboard.
 *
 * Server Component con un Client Component pequeño embebido (el
 * `<PeriodFilter>`) para elegir el periodo. Todas las queries pesadas
 * se ejecutan server-side; el cliente solo construye URLs nuevas
 * cuando el usuario cambia el filtro.
 *
 * Filtros vía searchParams (bookmarkable):
 *   - `periodo` ('dia' | 'semana' | 'mes', default = 'mes')
 *   - `fecha`   ('YYYY-MM-DD', default = hoy en CDMX)
 *
 * La ventana real (startDate/endDate/startIso/endIso) se calcula con
 * `getDateWindow()` y se aplica a todas las queries con rango.
 *
 * Métricas que SÍ respetan el rango del periodo:
 *   - Leads del periodo           (`leads.sale_date`)
 *   - Cobrado en el periodo       (`payments.paid_at`)
 *   - Efectivo validado           (`admin_cash_register.created_at`,
 *     egresos source='validado_contador'). CRITERIO: fecha de
 *     VALIDACIÓN — un cobro de mayo validado en junio aparece en junio.
 *     Por eso este valor puede SUPERAR a "Cobrado en el periodo": no
 *     son la misma cohorte de pagos.
 *   - Gasto en materiales         (`inventory_movements.created_at`)
 *   - Mi efectivo                 (`admin_cash_register.created_at`,
 *     ingresos − egresos del admin actual). CRITERIO: delta NETO del
 *     periodo, NO saldo acumulado. Para ver el saldo disponible
 *     histórico ir a `/admin/mi-caja` (card "Mi efectivo disponible").
 *   - Hojas / Cubrecantos / Por tipo de compra / Por vendedor
 *     (todos vía `leads.sale_date`)
 *   - Desglose de dinero (5 cards):
 *     · "Recibidos" replica el cálculo del tab homónimo de /contador:
 *       cobros pago_efectivo del periodo (por fecha del COBRO, no de
 *       la recepción) cuyo payment_id ya tiene un ingreso
 *       recibido_contador o recibido_directo_admin (cualquier fecha).
 *       Global — no filtra por admin_id, igual que el tab.
 *     · "Dinero total" / "En efectivo" / "En transferencia" / "En
 *       Clip" se calculan de la misma query #2 de `payments`
 *       agrupando `payment_method` en JS — por construcción la suma
 *       de los tres métodos = "Dinero total".
 *
 * Métricas que NO respetan el rango (siempre estado actual):
 *   - Entregas pendientes (operativo: lo que hay AHORA por entregar)
 *   - Stock bajo          (operativo: lo que hay AHORA bajo el mínimo)
 *
 * Chart de canales: últimos 7 días (independiente del filtro,
 * intencionalmente — es una vista de tendencia corta, no histórica).
 * Últimos leads: 5 más recientes (idem).
 *
 * Ventanas TZ-aware: las fechas-puras se anclan a medianoche CDMX
 * (UTC-6 fijo desde 2022) para evitar drift de 6h en el filtro por día.
 *
 * Política de errores: try/catch envolvente + ErrorState con el mensaje
 * preciso, mismo patrón que el resto del proyecto.
 */
export const dynamic = 'force-dynamic';

type RecentLead = {
  id: string;
  client_name: string;
  channel: Channel;
  seller_name: string;
  total_amount: number;
  delivery_status:
    | 'pendiente'
    | 'en_transito'
    | 'entregado'
    | 'cancelado';
  payment_status: 'pendiente' | 'parcial' | 'pagado' | 'cancelado';
};

type ChannelBar = {
  label: string;
  value: number;
  color: string;
};

const CHANNEL_BAR_META: Record<string, { label: string; color: string }> = {
  whatsapp: { label: 'WhatsApp', color: '#16A34A' },
  tiktok: { label: 'TikTok', color: '#7C3AED' },
  google: { label: 'Google', color: '#2E74B5' },
  tienda: { label: 'Tienda', color: '#EA580C' },
};

type RawSearchParams = {
  periodo?: string | string[];
  fecha?: string | string[];
  /** Tipo de venta — primer_contacto | recompra | seguimiento |
   *  venta_empleado. Vacío/inválido = todos. */
  sale_type?: string | string[];
};

function pickStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  try {
    const raw = await searchParams;
    const now = new Date();

    // Ventana de fechas para el periodo activo. `getDateWindow` valida
    // y normaliza periodo+fecha; entradas inválidas caen a los defaults
    // ('mes' + hoy CDMX) sin romper la página.
    const window = getDateWindow(pickStr(raw.periodo), pickStr(raw.fecha));
    const { startDate, endDate, startIso, endIso, periodo, fecha } = window;
    const saleType = normalizeSaleType(pickStr(raw.sale_type));
    // `sale_date` es DATE (YYYY-MM-DD); usamos comparación inclusiva con
    // el último día del periodo. Para timestamptz, usamos `< endIso`
    // donde endIso es el primer instante del día siguiente al endDate.

    // Ventana de últimos 7 días para el chart (independiente del filtro).
    const sevenDaysAgo = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - 6,
      ),
    )
      .toISOString()
      .slice(0, 10);

    const userClient = await supabaseServer();
    const {
      data: { user },
    } = await userClient.auth.getUser();

    const admin = supabaseAdmin();

    const [
      leadsMonthResult,
      paymentsMonthResult,
      deliveriesPendingResult,
      stockResult,
      cashValidatedResult,
      materialsSpendResult,
      channelChartResult,
      recentLeadsResult,
      profileResult,
      adminCashResult,
      hojasSoldResult,
      cubrecantoLeadsResult,
      cubrecantoMetersResult,
      sellerSummaryResult,
      purchaseTypeResult,
      cashPaymentsPeriodResult,
    ] = await Promise.all([
      // 1. Leads del periodo (sale_date ∈ [startDate, endDate])
      (() => {
        let q = admin
          .from('leads')
          .select('id', { count: 'exact', head: true })
          .gte('sale_date', startDate)
          .lte('sale_date', endDate)
          .is('deleted_at', null);
        if (saleType) q = q.eq('sale_type', saleType);
        return q;
      })(),
      // 2. Pagos exitosos del periodo (paid_at ∈ [startIso, endIso)).
      //    Trae `amount` + `payment_method` para alimentar tanto
      //    "Cobrado en el periodo" como el desglose por método de la
      //    sección "Desglose de dinero" (cards "Dinero total",
      //    "En efectivo", "En transferencia", "En Clip"). Mantener
      //    UNA query es lo que garantiza que el desglose por método
      //    sume exactamente al total. Si hay filtro de sale_type,
      //    inner-join con leads.
      (() => {
        let q;
        if (saleType) {
          q = admin
            .from('payments')
            .select('amount, payment_method, leads!inner(sale_type)')
            .eq('status', 'exitoso')
            .eq('leads.sale_type', saleType)
            .gte('paid_at', startIso)
            .lt('paid_at', endIso);
        } else {
          q = admin
            .from('payments')
            .select('amount, payment_method')
            .eq('status', 'exitoso')
            .gte('paid_at', startIso)
            .lt('paid_at', endIso);
        }
        return q;
      })(),
      // 3. Entregas pendientes (NO filtra por periodo — operativo actual)
      admin
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .in('delivery_status', ['pendiente', 'en_transito'])
        .is('deleted_at', null),
      // 4. Inventory para stock bajo (NO filtra por periodo)
      admin
        .from('inventory')
        .select('stock_total, stock_committed, stock_minimum'),
      // 5. Efectivo validado del periodo — la validación vive en
      //    `admin_cash_register` con source='validado_contador' (el
      //    contador valida la caja del admin). Sumamos los egresos
      //    cuyo `created_at` cae en el periodo. CRITERIO INTENCIONAL:
      //    fecha de validación, no de cobro — por eso este número
      //    puede ser mayor que "Cobrado en el periodo" si se validan
      //    cobros de meses anteriores.
      admin
        .from('admin_cash_register')
        .select('amount')
        .eq('operation_type', 'egreso')
        .eq('source', 'validado_contador')
        .gte('created_at', startIso)
        .lt('created_at', endIso),
      // 6. Gasto en materiales del periodo — suma de
      //    inventory_movements WHERE movement_type='entrada' AND
      //    unit_cost IS NOT NULL AND created_at ∈ rango.
      //    Sumamos quantity * unit_cost en JS porque PostgREST no
      //    expresa multiplicaciones server-side. unit_cost null lo
      //    descartamos en el WHERE para evitar traer rows que no
      //    contribuyen.
      admin
        .from('inventory_movements')
        .select('quantity, unit_cost')
        .eq('movement_type', 'entrada')
        .not('unit_cost', 'is', null)
        .gte('created_at', startIso)
        .lt('created_at', endIso),
      // 7. Chart por canal (últimos 7 días — independiente)
      admin
        .from('leads')
        .select('channel')
        .gte('sale_date', sevenDaysAgo)
        .is('deleted_at', null),
      // 8. Recent leads (5 más recientes — independiente)
      admin
        .from('leads')
        .select(
          `id, client_name, channel, total_amount, delivery_status, payment_status,
           sellers ( name )`,
        )
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(5),
      // 9. Profile del usuario para el greeting (best-effort)
      user
        ? admin
            .from('profiles')
            .select('full_name')
            .eq('id', user.id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      // 10. Caja personal del admin: DELTA NETO del periodo en
      //     `admin_cash_register`. SUM(ingresos) − SUM(egresos+
      //     validacion) del usuario actual con `created_at` en el
      //     periodo. NO es el saldo disponible histórico — para eso
      //     está la card "Mi efectivo disponible" en /admin/mi-caja.
      //     Si la tabla no existe (migración pendiente), error no
      //     fatal → $0 en la card.
      user
        ? admin
            .from('admin_cash_register')
            .select('amount, operation_type')
            .eq('admin_id', user.id)
            .gte('created_at', startIso)
            .lt('created_at', endIso)
        : Promise.resolve({ data: [], error: null }),
      // 11. Hojas vendidas del periodo — Σ lead_colors.quantity unida
      //     con leads del periodo con has_hojas=true. PostgREST no
      //     soporta SUM en queries con join filtradas (necesitaríamos
      //     una vista), así que traemos las filas y sumamos en memoria.
      //     Cota: 1 fila por color por lead — varios cientos en el
      //     peor caso. Aceptable.
      (() => {
        let q = admin
          .from('lead_colors')
          .select('quantity, leads!inner(sale_date, deleted_at, has_hojas, sale_type)')
          .eq('leads.has_hojas', true)
          .is('leads.deleted_at', null)
          .gte('leads.sale_date', startDate)
          .lte('leads.sale_date', endDate);
        if (saleType) q = q.eq('leads.sale_type', saleType);
        return q;
      })(),
      // 12. Cubrecantos del periodo — conteo de leads con
      //     has_cubrecanto=true y suma de edgebanding_manual_cost para
      //     la métrica "monto facturado". Una sola query: count exact
      //     + select de los montos para sumar JS-side.
      (() => {
        let q = admin
          .from('leads')
          .select('edgebanding_manual_cost', { count: 'exact' })
          .eq('has_cubrecanto', true)
          .is('deleted_at', null)
          .gte('sale_date', startDate)
          .lte('sale_date', endDate);
        if (saleType) q = q.eq('sale_type', saleType);
        return q;
      })(),
      // 13. Metros de cubrecanto vendidos — Σ
      //     lead_edgebanding_colors.quantity unidos con leads del
      //     periodo. Si la tabla no existe todavía (migración pendiente
      //     para algunos entornos) trata como 0.
      (() => {
        let q = admin
          .from('lead_edgebanding_colors')
          .select('quantity, leads!inner(sale_date, deleted_at, sale_type)')
          .is('leads.deleted_at', null)
          .gte('leads.sale_date', startDate)
          .lte('leads.sale_date', endDate);
        if (saleType) q = q.eq('leads.sale_type', saleType);
        return q;
      })(),
      // 14. Resumen por vendedor del periodo. PostgREST no soporta
      //     GROUP BY ni SUM directos; traemos los leads del periodo
      //     (seller_id + métricas) y agrupamos JS-side. Cota: ~cientos
      //     de leads por mes en el caso típico — aceptable.
      (() => {
        let q = admin
          .from('leads')
          .select('seller_id, sheets_count, total_amount')
          .is('deleted_at', null)
          .gte('sale_date', startDate)
          .lte('sale_date', endDate);
        if (saleType) q = q.eq('sale_type', saleType);
        return q;
      })(),
      // 15. Desglose por tipo de compra (domicilio / fábrica). Mismo
      //     patrón que seller summary: traemos `purchase_type` +
      //     `total_amount` por lead del periodo y agrupamos JS-side
      //     para emitir count y monto vendido por bucket. Respeta el
      //     filtro sale_type para mantener consistencia con el resto
      //     de las métricas.
      (() => {
        let q = admin
          .from('leads')
          .select('purchase_type, total_amount')
          .is('deleted_at', null)
          .gte('sale_date', startDate)
          .lte('sale_date', endDate);
        if (saleType) q = q.eq('sale_type', saleType);
        return q;
      })(),
      // 16. Cobros en efectivo del periodo (pago_efectivo ingresos
      //     creados en la ventana). Por sí solos no alimentan ninguna
      //     card directamente — necesitamos un lookup posterior para
      //     saber cuáles ya fueron recibidos (recibido_contador o
      //     recibido_directo_admin) y así replicar EXACTAMENTE el
      //     cálculo del tab "Recibidos" de /contador. Criterio: la
      //     ventana se aplica a la fecha del COBRO original, no a la
      //     de la recepción (la recepción puede ocurrir días después
      //     y no debe sacar al cobro del bucket del mes en que se
      //     hizo).
      admin
        .from('admin_cash_register')
        .select('payment_id, amount')
        .eq('operation_type', 'ingreso')
        .eq('source', 'pago_efectivo')
        .gte('created_at', startIso)
        .lt('created_at', endIso),
    ]);

    if (leadsMonthResult.error) {
      return <ErrorState message={`Error leyendo leads del periodo: ${leadsMonthResult.error.message}`} />;
    }
    if (paymentsMonthResult.error) {
      return <ErrorState message={`Error leyendo pagos del periodo: ${paymentsMonthResult.error.message}`} />;
    }
    if (deliveriesPendingResult.error) {
      return <ErrorState message={`Error leyendo entregas: ${deliveriesPendingResult.error.message}`} />;
    }
    if (stockResult.error) {
      return <ErrorState message={`Error leyendo inventario: ${stockResult.error.message}`} />;
    }
    // cashValidated: no fatal — si la tabla no existe o falla, mostramos $0.
    if (cashValidatedResult.error) {
      console.error(
        '[DashboardPage] cash validated (admin_cash_register) select falló (no fatal):',
        cashValidatedResult.error,
      );
    }
    // materialsSpend: no fatal igual — si falla, métrica cae a $0.
    if (materialsSpendResult.error) {
      console.error(
        '[DashboardPage] materials spend select falló (no fatal):',
        materialsSpendResult.error,
      );
    }
    if (channelChartResult.error) {
      return <ErrorState message={`Error leyendo chart: ${channelChartResult.error.message}`} />;
    }
    if (recentLeadsResult.error) {
      return <ErrorState message={`Error leyendo recientes: ${recentLeadsResult.error.message}`} />;
    }

    const leadsPeriod = leadsMonthResult.count ?? 0;
    const paidPeriod = (paymentsMonthResult.data ?? []).reduce(
      (s, p) => s + Number(p.amount ?? 0),
      0,
    );
    // Desglose por método: una pasada sobre el mismo array que produjo
    // `paidPeriod` para garantizar que efectivo + transferencia + clip
    // = paidPeriod (cualquier `payment_method` desconocido queda
    // fuera de los tres y NO inflará una categoría incorrecta).
    type MethodBreakdown = { efectivo: number; transferencia: number; clip: number };
    const methodBreakdown: MethodBreakdown = (
      paymentsMonthResult.data ?? []
    ).reduce<MethodBreakdown>(
      (acc, p) => {
        const amt = Number(p.amount ?? 0);
        const m = (p as { payment_method?: string | null }).payment_method;
        if (m === 'efectivo') acc.efectivo += amt;
        else if (m === 'transferencia') acc.transferencia += amt;
        else if (m === 'clip') acc.clip += amt;
        return acc;
      },
      { efectivo: 0, transferencia: 0, clip: 0 },
    );
    const deliveriesPending = deliveriesPendingResult.count ?? 0;
    const lowStock = (stockResult.data ?? []).reduce((c, r) => {
      const total = Number(r.stock_total ?? 0);
      const committed = Number(r.stock_committed ?? 0);
      const minimum = Number(r.stock_minimum ?? 0);
      const available = Math.max(0, total - committed);
      return available <= minimum ? c + 1 : c;
    }, 0);
    const cashValidatedPeriod = (cashValidatedResult.data ?? []).reduce(
      (s, t) => s + Number(t.amount ?? 0),
      0,
    );
    // Σ (quantity * unit_cost) — entradas con costo registrado en el periodo.
    // Si unit_cost es null la query ya lo filtró; igual usamos `?? 0` por
    // defensa.
    const materialsSpendPeriod = (materialsSpendResult.data ?? []).reduce(
      (s, m) => s + Number(m.quantity ?? 0) * Number(m.unit_cost ?? 0),
      0,
    );

    // Hojas vendidas (Σ quantity de lead_colors del periodo con has_hojas).
    // Si la query falla, mostramos 0 (no fatal — métrica informativa).
    if (hojasSoldResult.error) {
      console.error(
        '[DashboardPage] hojas sold select falló (no fatal):',
        hojasSoldResult.error,
      );
    }
    const totalHojas = (hojasSoldResult.data ?? []).reduce(
      (s, r) => s + Number(r.quantity ?? 0),
      0,
    );

    // Cubrecantos del periodo: cuántos leads + monto facturado.
    if (cubrecantoLeadsResult.error) {
      console.error(
        '[DashboardPage] cubrecanto leads select falló (no fatal):',
        cubrecantoLeadsResult.error,
      );
    }
    const totalCubrecantoLeads = cubrecantoLeadsResult.count ?? 0;
    const totalCubrecantoMonto = (cubrecantoLeadsResult.data ?? []).reduce(
      (s, r) => s + Number(r.edgebanding_manual_cost ?? 0),
      0,
    );

    // Metros vendidos de cubrecanto (más preciso: usa lead_edgebanding_colors).
    if (cubrecantoMetersResult.error) {
      console.error(
        '[DashboardPage] cubrecanto meters select falló (no fatal):',
        cubrecantoMetersResult.error,
      );
    }
    const totalMetrosCubrecanto = (cubrecantoMetersResult.data ?? []).reduce(
      (s, r) => s + Number(r.quantity ?? 0),
      0,
    );

    // Saldo de la caja personal del admin en el periodo:
    // SUM(ingresos) - SUM(egresos). 'validacion' contribuye igual que
    // 'egreso' (movimiento de salida hacia el contador).
    if (adminCashResult.error) {
      console.error(
        '[DashboardPage] admin_cash_register select falló (no fatal):',
        adminCashResult.error,
      );
    }
    // Tres operation_types válidos en admin_cash_register: 'ingreso',
    // 'egreso' y 'validacion'. Antes el reduce trataba "todo lo que no
    // sea ingreso" como egreso — riesgo si llega un valor nuevo o NULL.
    // Whitelist explícita: desconocidos cuentan como 0 para no inflar
    // la métrica con basura silenciosa.
    const adminCashPeriod = (adminCashResult.data ?? []).reduce((s, r) => {
      const amt = Number(r.amount ?? 0);
      if (r.operation_type === 'ingreso') return s + amt;
      if (r.operation_type === 'egreso' || r.operation_type === 'validacion') {
        return s - amt;
      }
      return s;
    }, 0);

    // Chart por canal
    const channelCount = new Map<string, number>();
    for (const row of channelChartResult.data ?? []) {
      const ch = (row.channel as string) ?? '';
      if (!ch) continue;
      channelCount.set(ch, (channelCount.get(ch) ?? 0) + 1);
    }
    const channelChart: ChannelBar[] = Object.entries(CHANNEL_BAR_META).map(
      ([key, meta]) => ({
        label: meta.label,
        color: meta.color,
        value: channelCount.get(key) ?? 0,
      }),
    );
    const maxBar = Math.max(1, ...channelChart.map((c) => c.value));
    const totalChartLeads = channelChart.reduce((s, c) => s + c.value, 0);

    // Recent leads
    type RawRecent = {
      id: string;
      client_name: string;
      channel: string | null;
      total_amount: number | string | null;
      delivery_status: string | null;
      payment_status: string | null;
      sellers: { name: string } | { name: string }[] | null;
    };
    const recentLeads: RecentLead[] = ((recentLeadsResult.data ?? []) as RawRecent[]).map(
      (l) => {
        const sellerObj = Array.isArray(l.sellers) ? l.sellers[0] : l.sellers;
        return {
          id: l.id,
          client_name: l.client_name,
          channel: ((l.channel as string) ?? '').toUpperCase() as Channel,
          seller_name: sellerObj?.name ?? '—',
          total_amount: Number(l.total_amount ?? 0),
          delivery_status:
            (l.delivery_status as RecentLead['delivery_status']) ?? 'pendiente',
          payment_status:
            (l.payment_status as RecentLead['payment_status']) ?? 'pendiente',
        };
      },
    );

    const fullName =
      profileResult.data?.full_name ?? user?.email ?? 'Bienvenido';
    const firstName = fullName.split(' ')[0];

    // Resumen por vendedor — agrupamos los leads del periodo en memoria
    // (PostgREST no soporta GROUP BY) y enriquecemos con el nombre del
    // vendedor en un solo SELECT bulk. Best-effort: si la query falla,
    // la sección se omite del UI (queda como `null`) en lugar de tirar
    // el dashboard entero.
    if (sellerSummaryResult.error) {
      console.error(
        '[DashboardPage] seller summary select falló (no fatal):',
        sellerSummaryResult.error,
      );
    }
    type SellerSummaryRow = {
      seller_id: string | null;
      seller_name: string;
      total_leads: number;
      total_hojas: number;
      total_monto: number;
    };
    const sellerAgg = new Map<
      string,
      { total_leads: number; total_hojas: number; total_monto: number }
    >();
    for (const row of sellerSummaryResult.data ?? []) {
      const key = (row.seller_id as string | null) ?? '__none__';
      const prev = sellerAgg.get(key) ?? {
        total_leads: 0,
        total_hojas: 0,
        total_monto: 0,
      };
      prev.total_leads += 1;
      prev.total_hojas += Number(row.sheets_count ?? 0);
      prev.total_monto += Number(row.total_amount ?? 0);
      sellerAgg.set(key, prev);
    }
    const sellerIdsNeedingName = Array.from(sellerAgg.keys()).filter(
      (k) => k !== '__none__',
    );
    const sellerNameById = new Map<string, string>();
    if (sellerIdsNeedingName.length > 0) {
      try {
        const { data: sellerNamesData, error: sellerNamesErr } = await admin
          .from('sellers')
          .select('id, name')
          .in('id', sellerIdsNeedingName);
        if (sellerNamesErr) {
          console.error(
            '[DashboardPage] seller names lookup falló (no fatal):',
            sellerNamesErr,
          );
        } else {
          for (const s of sellerNamesData ?? []) {
            sellerNameById.set(String(s.id), (s.name as string) ?? '—');
          }
        }
      } catch (e) {
        console.error('[DashboardPage] seller names excepción (no fatal):', e);
      }
    }
    const sellerSummary: SellerSummaryRow[] = Array.from(sellerAgg.entries())
      .map(([key, v]) => ({
        seller_id: key === '__none__' ? null : key,
        seller_name:
          key === '__none__'
            ? 'Sin vendedor'
            : sellerNameById.get(key) ?? '—',
        total_leads: v.total_leads,
        total_hojas: v.total_hojas,
        total_monto: v.total_monto,
      }))
      .sort((a, b) => b.total_monto - a.total_monto);
    const sellerSummaryTotals = sellerSummary.reduce(
      (acc, r) => ({
        leads: acc.leads + r.total_leads,
        hojas: acc.hojas + r.total_hojas,
        monto: acc.monto + r.total_monto,
      }),
      { leads: 0, hojas: 0, monto: 0 },
    );

    // Desglose por tipo de compra (domicilio / fábrica). Agrupamos
    // JS-side desde las filas que ya trajo la query 15. Best-effort:
    // si la query falló, ambos buckets quedan en 0 y las cards
    // muestran ese estado en lugar de tirar la página.
    if (purchaseTypeResult.error) {
      console.error(
        '[DashboardPage] purchase type select falló (no fatal):',
        purchaseTypeResult.error,
      );
    }
    const purchaseBucket = (target: 'domicilio' | 'fabrica') => {
      let count = 0;
      let monto = 0;
      for (const r of purchaseTypeResult.data ?? []) {
        if ((r.purchase_type as string | null) === target) {
          count += 1;
          monto += Number(r.total_amount ?? 0);
        }
      }
      return { count, monto };
    };
    const domicilioStats = purchaseBucket('domicilio');
    const fabricaStats = purchaseBucket('fabrica');

    // Card "Recibidos" del desglose — debe coincidir EXACTAMENTE con
    // el total del tab "Recibidos" en /contador. Replicamos su lógica:
    //   1. Cobros pago_efectivo del periodo (ya cargados en query #16).
    //   2. Lookup IN(payment_ids) para encontrar cuáles tienen un
    //      ingreso recibido_contador o recibido_directo_admin
    //      (cualquier fecha — la recepción puede ser posterior al mes
    //      del cobro y el bucket sigue siendo del mes del cobro).
    //   3. SUM(amount) de los cobros cuyo payment_id aparece en el
    //      conjunto recibido.
    // No filtramos por admin_id porque el tab de contador es global
    // (cualquier admin que haya recibido cuenta).
    if (cashPaymentsPeriodResult.error) {
      console.error(
        '[DashboardPage] cash payments period select falló (no fatal):',
        cashPaymentsPeriodResult.error,
      );
    }
    const cashPaymentsRows = cashPaymentsPeriodResult.data ?? [];
    const cashPaymentIds = Array.from(
      new Set(
        cashPaymentsRows
          .map((r) => (r as { payment_id?: string | null }).payment_id)
          .filter((x): x is string => !!x),
      ),
    );
    const receivedPaymentIdSet = new Set<string>();
    if (cashPaymentIds.length > 0) {
      try {
        const { data: receivedRows, error: receivedErr } = await admin
          .from('admin_cash_register')
          .select('payment_id')
          .eq('operation_type', 'ingreso')
          .in('source', ['recibido_contador', 'recibido_directo_admin'])
          .in('payment_id', cashPaymentIds);
        if (receivedErr) {
          console.error(
            '[DashboardPage] received payments lookup falló (no fatal):',
            receivedErr,
          );
        } else {
          for (const r of receivedRows ?? []) {
            const pid = (r as { payment_id?: string | null }).payment_id;
            if (pid) receivedPaymentIdSet.add(pid);
          }
        }
      } catch (e) {
        console.error(
          '[DashboardPage] received payments lookup excepción (no fatal):',
          e,
        );
      }
    }
    const cashReceivedTotal = cashPaymentsRows.reduce((s, r) => {
      const pid = (r as { payment_id?: string | null }).payment_id;
      if (pid && receivedPaymentIdSet.has(pid)) {
        return s + Number(r.amount ?? 0);
      }
      return s;
    }, 0);

    // Sufijo del subtitle cuando hay tipo de venta activo
    //   "Métricas de Mayo 2026 — Recompras"
    const saleTypeSuffix = saleType ? ` — ${SALE_TYPE_SUBTITLE[saleType] ?? ''}` : '';
    // Los hrefs de drill-down incluyen sale_type cuando está activo
    // para que /leads abra ya filtrado.
    const periodParams = saleType
      ? `periodo=${periodo}&fecha=${fecha}&sale_type=${saleType}`
      : `periodo=${periodo}&fecha=${fecha}`;
    // /admin/mi-caja usa mes/anio (no periodo/fecha). Derivamos del
    // startDate: válido también para 'dia' y 'semana' porque mi-caja
    // muestra el mes que contiene el rango — aproximación suficiente
    // para drill-down. El periodo mensual coincide exactamente.
    const [startYearStr, startMonthStr] = startDate.split('-');
    const miCajaParams = `mes=${Number(startMonthStr)}&anio=${Number(startYearStr)}`;

    return (
      <div className="flex flex-col gap-6">
        {/* Title + filter */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1
              className="text-2xl font-bold tracking-tight"
              style={{ color: 'var(--text-primary)' }}
            >
              Buen día, {firstName} 👋
            </h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {window.subtitleLabel}
              {saleTypeSuffix}
            </p>
          </div>
          <div id="dashboard-filter">
            <PeriodFilter periodo={periodo} fecha={fecha} saleType={saleType} />
          </div>
        </div>

        {/* Metric cards — todas clickeables. Cada href incluye periodo+fecha
            para que el drill-down respete el filtro del dashboard, EXCEPTO
            "Stock bajo" que va a /warehouse sin params (el stock es estado
            actual, no tiene rango). */}
        <div id="dashboard-metrics" className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
          <MetricCard
            icon={<ClipboardList size={20} />}
            iconBg="#DBEAFE"
            iconColor="#1E40AF"
            label="Leads del periodo"
            value={leadsPeriod.toString()}
            unit={leadsPeriod === 1 ? 'lead registrado' : 'leads registrados'}
            href={`/leads?${periodParams}`}
          />
          <MetricCard
            icon={<DollarSign size={20} />}
            iconBg="#DCFCE7"
            iconColor="#15803D"
            label="Cobrado en el periodo"
            value={formatMXN(paidPeriod)}
            unit="pagos exitosos del periodo"
            href={`/payments?${periodParams}`}
          />
          <MetricCard
            icon={<Wallet size={20} />}
            iconBg="#E0E7FF"
            iconColor="#1E3A8A"
            label="Efectivo validado"
            value={formatMXN(cashValidatedPeriod)}
            unit="validado por contador en este periodo"
            href={`/admin/caja?tab=validados&${periodParams}`}
          />
          <MetricCard
            icon={<PackagePlus size={20} />}
            iconBg="#FFEDD5"
            iconColor="#C2410C"
            label="Gasto en materiales"
            value={formatMXN(materialsSpendPeriod)}
            unit="invertido en entradas del periodo"
            href={`/warehouse/movements?type=entrada&${periodParams}`}
          />
          <MetricCard
            icon={<Truck size={20} />}
            iconBg="#FEF3C7"
            iconColor="#92400E"
            label="Entregas pendientes"
            value={deliveriesPending.toString()}
            unit="por entregar o en tránsito (actual)"
            href={`/leads?delivery=pendiente&${periodParams}`}
          />
          <MetricCard
            icon={<TriangleAlert size={20} />}
            iconBg="#FEE2E2"
            iconColor="#B91C1C"
            label="Stock bajo"
            value={lowStock.toString()}
            unit="materiales bajo mínimo (actual)"
            href="/warehouse"
          />
          <MetricCard
            icon={<Banknote size={20} />}
            iconBg="#DCFCE7"
            iconColor="#14532D"
            label="Mi efectivo (neto del periodo)"
            value={formatMXN(adminCashPeriod)}
            unit="ingresos − egresos del periodo · saldo en /admin/mi-caja"
            href={`/admin/mi-caja?${miCajaParams}`}
          />
          <MetricCard
            icon={<Layers size={20} />}
            iconBg="#DBEAFE"
            iconColor="#1D4ED8"
            label="Hojas vendidas"
            value={totalHojas.toString()}
            unit="hojas en pedidos del periodo"
            href={`/leads?${periodParams}&color_filter=azul`}
          />
          <MetricCard
            icon={<Ruler size={20} />}
            iconBg="#CCFBF1"
            iconColor="#0F766E"
            label="Cubrecantos"
            value={totalCubrecantoLeads.toString()}
            unit={
              totalMetrosCubrecanto > 0
                ? `${totalMetrosCubrecanto.toLocaleString('es-MX')} m · ${formatMXN(totalCubrecantoMonto)}`
                : 'pedidos con cubrecanto del periodo'
            }
            href={`/leads?${periodParams}`}
          />
          {/* Desglose por tipo de compra. Usa el filtro `purchase_type`
              que `/leads` ya entiende para que el drill-down vea solo
              los leads del bucket clickeado. Truck ya lo usa "Entregas
              pendientes" pero su semántica (domicilio = se entrega) es
              tan literal que vale la pena duplicar. */}
          <MetricCard
            icon={<Home size={20} />}
            iconBg="#DBEAFE"
            iconColor="#1E40AF"
            label="A domicilio"
            value={domicilioStats.count.toString()}
            unit={`${formatMXN(domicilioStats.monto)} vendido`}
            href={`/leads?${periodParams}&purchase_type=domicilio`}
          />
          <MetricCard
            icon={<Factory size={20} />}
            iconBg="#F3F4F6"
            iconColor="#57534E"
            label="En fábrica"
            value={fabricaStats.count.toString()}
            unit={`${formatMXN(fabricaStats.monto)} vendido`}
            href={`/leads?${periodParams}&purchase_type=fabrica`}
          />
        </div>

        {/* Desglose de dinero — 5 cards alineadas: lo recibido por el
            admin actual + total + 3 métodos. Las 3 cards de método se
            alimentan de la MISMA query que `paidPeriod` (query #2), así
            que efectivo + transferencia + clip = total. `periodParams`
            arrastra el filtro sale_type cuando está activo, lo que
            mantiene coherencia con el resto del dashboard. */}
        <div id="dashboard-money-breakdown" className="flex flex-col gap-3">
          <div>
            <h3 className="font-semibold text-base">
              💰 Desglose de dinero — {window.subtitleLabel}
              {saleTypeSuffix}
            </h3>
            <p
              className="text-xs"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Cómo entró el efectivo del periodo + lo recibido por ti
              del contador.
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
            <MetricCard
              icon={<ShieldCheck size={20} />}
              iconBg="#DCFCE7"
              iconColor="#14532D"
              label="Recibidos"
              value={formatMXN(cashReceivedTotal)}
              unit="cobros del periodo ya recibidos"
              href={`/contador?tab=recibidos&${miCajaParams}`}
            />
            <MetricCard
              icon={<Wallet size={20} />}
              iconBg="#DBEAFE"
              iconColor="#1E40AF"
              label="Dinero total"
              value={formatMXN(paidPeriod)}
              unit="todos los métodos del periodo"
              href={`/payments?${periodParams}`}
            />
            <MetricCard
              icon={<Banknote size={20} />}
              iconBg="#DCFCE7"
              iconColor="#15803D"
              label="En efectivo"
              value={formatMXN(methodBreakdown.efectivo)}
              unit="cobrado en efectivo del periodo"
              href={`/payments?${periodParams}&method=efectivo`}
            />
            <MetricCard
              icon={<ArrowLeftRight size={20} />}
              iconBg="#DBEAFE"
              iconColor="#1D4ED8"
              label="En transferencia"
              value={formatMXN(methodBreakdown.transferencia)}
              unit="cobrado por transferencia"
              href={`/payments?${periodParams}&method=transferencia`}
            />
            <MetricCard
              icon={<CreditCard size={20} />}
              iconBg="#EDE9FE"
              iconColor="#6D28D9"
              label="En Clip"
              value={formatMXN(methodBreakdown.clip)}
              unit="cobrado vía Clip"
              href={`/payments?${periodParams}&method=clip`}
            />
          </div>
        </div>

        {/* Resumen de ventas por vendedor en el periodo. Ordenado por
            total vendido desc; primera fila se destaca con fondo. Si no
            hay leads en el rango, la sección no se muestra. */}
        {sellerSummary.length > 0 && (
          <div id="dashboard-seller-summary" className="card overflow-hidden">
            <div
              className="px-6 py-4 border-b"
              style={{ borderColor: 'var(--border)' }}
            >
              <h3 className="font-semibold">Ventas por vendedor</h3>
              <p
                className="text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Resumen del período seleccionado
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Vendedor</th>
                    <th className="text-center">Leads</th>
                    <th className="text-center">Hojas vendidas</th>
                    <th className="text-right">Total vendido</th>
                  </tr>
                </thead>
                <tbody>
                  {sellerSummary.map((row, idx) => (
                    <tr
                      key={row.seller_id ?? '__none__'}
                      style={
                        idx === 0
                          ? { background: '#ECFDF5' }
                          : undefined
                      }
                    >
                      <td className="font-medium">{row.seller_name}</td>
                      <td className="text-center">{row.total_leads}</td>
                      <td className="text-center">
                        {row.total_hojas.toLocaleString('es-MX')}
                      </td>
                      <td className="text-right font-semibold">
                        {formatMXN(row.total_monto)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr
                    style={{
                      background: 'var(--bg-subtle)',
                      fontWeight: 600,
                    }}
                  >
                    <td>Total</td>
                    <td className="text-center">{sellerSummaryTotals.leads}</td>
                    <td className="text-center">
                      {sellerSummaryTotals.hojas.toLocaleString('es-MX')}
                    </td>
                    <td className="text-right">
                      {formatMXN(sellerSummaryTotals.monto)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* Chart de canales (últimos 7 días) */}
        <div id="dashboard-chart" className="card p-6">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="font-semibold">Leads por canal</h3>
              <p
                className="text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Últimos 7 días · {totalChartLeads} en total
              </p>
            </div>
            {totalChartLeads > 0 && (
              <span className="badge badge-success flex items-center gap-1">
                <TrendingUp size={12} /> {totalChartLeads}
              </span>
            )}
          </div>
          <div
            className="grid grid-cols-4 gap-6 items-end"
            style={{ height: 220 }}
          >
            {channelChart.map((c) => (
              <div
                key={c.label}
                className="flex flex-col items-center justify-end h-full gap-2"
              >
                <div
                  className="text-sm font-semibold"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {c.value}
                </div>
                <div
                  style={{
                    width: '70%',
                    maxWidth: 64,
                    height: `${(c.value / maxBar) * 170}px`,
                    minHeight: c.value > 0 ? 4 : 0,
                    background: c.color,
                    borderRadius: '8px 8px 0 0',
                    transition: 'height 300ms ease',
                  }}
                />
                <div
                  className="text-xs font-medium"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {c.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent leads */}
        <div className="card overflow-hidden">
          <div
            className="flex items-center justify-between px-6 py-4 border-b"
            style={{ borderColor: 'var(--border)' }}
          >
            <div>
              <h3 className="font-semibold">Últimos leads</h3>
              <p
                className="text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {recentLeads.length === 0
                  ? 'Sin leads registrados'
                  : `${recentLeads.length} más recientes`}
              </p>
            </div>
            <Link
              href="/leads"
              className="btn btn-outline"
              style={{ padding: '6px 14px' }}
            >
              Ver todos
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Canal</th>
                  <th>Vendedor</th>
                  <th>Total</th>
                  <th>Entrega</th>
                  <th>Pago</th>
                </tr>
              </thead>
              <tbody>
                {recentLeads.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="text-center py-8 text-sm"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      Sin leads todavía. Crea el primero en{' '}
                      <Link
                        href="/leads/new"
                        style={{
                          color: 'var(--brand-primary)',
                          textDecoration: 'underline',
                        }}
                      >
                        /leads/new
                      </Link>
                      .
                    </td>
                  </tr>
                ) : (
                  recentLeads.map((l) => (
                    <tr key={l.id}>
                      <td className="font-medium">{l.client_name}</td>
                      <td>
                        <ChannelBadge channel={l.channel} />
                      </td>
                      <td>{l.seller_name}</td>
                      <td className="font-semibold">
                        {formatMXN(l.total_amount)}
                      </td>
                      <td>
                        <DeliveryBadge status={l.delivery_status} />
                      </td>
                      <td>
                        <PaymentBadge status={l.payment_status} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al cargar dashboard';
    console.error('[DashboardPage] excepción no controlada:', err);
    return <ErrorState message={message} />;
  }
}

function MetricCard({
  icon,
  iconBg,
  iconColor,
  label,
  value,
  unit,
  href,
}: {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  label: string;
  value: string;
  unit: string;
  /** Si se provee, todo el card se vuelve clickeable y wrapeado en
   *  `<Link>`. El `:hover` ya está en el CSS de `.stat-card` (sube la
   *  shadow). Sólo agregamos cursor pointer aquí para señalar
   *  affordance.
   */
  href?: string;
}) {
  const card = (
    <div className="stat-card" style={href ? { cursor: 'pointer' } : undefined}>
      <div className="flex items-center justify-between">
        <div
          className="flex items-center justify-center"
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: iconBg,
            color: iconColor,
          }}
        >
          {icon}
        </div>
      </div>
      <div className="mt-3">
        <div className="text-2xl font-bold tracking-tight">{value}</div>
        <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </div>
        <div
          className="text-[11px] mt-1"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {unit}
        </div>
      </div>
    </div>
  );
  if (!href) return card;
  return (
    <Link
      href={href}
      // Reset del color heredado del <a> default (purple/blue) para que
      // los textos del card sigan en su variable original.
      style={{
        display: 'block',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      {card}
    </Link>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar el dashboard</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </div>
  );
}
