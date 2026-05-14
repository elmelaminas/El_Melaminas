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
} from 'lucide-react';
import {
  ChannelBadge,
  DeliveryBadge,
  PaymentBadge,
} from '@/components/ui/Badges';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { formatMXN, type Channel } from '@/data/mock';
import { MonthYearFilter } from './dashboard-client';
import { MES_LABEL } from './constants';

/**
 * Dashboard /dashboard.
 *
 * Server Component con un Client Component pequeño embebido (el
 * `<MonthYearFilter>`) para los selectores de mes/año. Todas las queries
 * pesadas se ejecutan server-side; el cliente solo construye URLs nuevas
 * cuando el usuario cambia el filtro.
 *
 * Filtros vía searchParams (bookmarkable):
 *   - `mes`  (1-12, default = mes actual UTC)
 *   - `anio` (año de 4 dígitos, default = año actual UTC)
 *
 * Métricas que respetan el rango de mes seleccionado:
 *   - Leads del mes              (`leads.sale_date` ∈ [start, nextStart))
 *   - Cobrado en el mes          (`payments.paid_at` ∈ [start, nextStart))
 *   - Efectivo validado del mes  (`cash_transfers.admin_validated_at`)
 *
 * Métricas que NO respetan el rango (siempre estado actual):
 *   - Entregas pendientes (operativo: lo que hay AHORA por entregar)
 *   - Stock bajo          (operativo: lo que hay AHORA bajo el mínimo)
 *
 * Chart de canales: últimos 7 días (independiente del filtro mensual,
 * intencionalmente — es una vista de tendencia corta, no histórica).
 *
 * Política de errores: try/catch envolvente + ErrorState con el mensaje
 * preciso, mismo patrón que el resto del proyecto.
 *
 * Ventanas en UTC. Para precisión exacta TZ MX -06:00, parametriza la
 * zona horaria al construir las fechas.
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
  mes?: string | string[];
  anio?: string | string[];
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

    // Validación + defaults para mes/anio. Si el usuario manipula la URL
    // a `?mes=99&anio=abc`, caemos al actual silenciosamente.
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

    // Rango UTC del mes seleccionado: [start, startNextMonth).
    // Date.UTC con month=12 normaliza correctamente a Enero del año + 1.
    const startOfMonthIso = new Date(Date.UTC(anio, mes - 1, 1)).toISOString();
    const startOfNextMonthIso = new Date(Date.UTC(anio, mes, 1)).toISOString();
    // Para columnas DATE (sale_date), comparamos como YYYY-MM-DD.
    const startOfMonthDate = startOfMonthIso.slice(0, 10);
    const startOfNextMonthDate = startOfNextMonthIso.slice(0, 10);

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
    ] = await Promise.all([
      // 1. Leads del mes (sale_date ∈ [start, nextStart))
      admin
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .gte('sale_date', startOfMonthDate)
        .lt('sale_date', startOfNextMonthDate)
        .is('deleted_at', null),
      // 2. Pagos exitosos del mes (paid_at ∈ [start, nextStart))
      admin
        .from('payments')
        .select('amount')
        .eq('status', 'exitoso')
        .gte('paid_at', startOfMonthIso)
        .lt('paid_at', startOfNextMonthIso),
      // 3. Entregas pendientes (NO filtra por mes — operativo actual)
      admin
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .in('delivery_status', ['pendiente', 'en_transito'])
        .is('deleted_at', null),
      // 4. Inventory para stock bajo (NO filtra por mes)
      admin
        .from('inventory')
        .select('stock_total, stock_committed, stock_minimum'),
      // 5. Efectivo validado del mes (cash_transfers.admin_validated_at ∈ rango)
      admin
        .from('cash_transfers')
        .select('amount')
        .eq('status', 'validado')
        .gte('admin_validated_at', startOfMonthIso)
        .lt('admin_validated_at', startOfNextMonthIso),
      // 6. Gasto en materiales del mes — suma de
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
        .gte('created_at', startOfMonthIso)
        .lt('created_at', startOfNextMonthIso),
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
      // 10. Caja personal del admin: saldo del mes en
      //     `admin_cash_register`. SUM(ingresos) - SUM(egresos) del
      //     usuario actual filtrado por mes. Si la tabla no existe
      //     todavía (migración pendiente), tratamos como error
      //     non-fatal y mostramos $0 en la card.
      user
        ? admin
            .from('admin_cash_register')
            .select('amount, operation_type')
            .eq('admin_id', user.id)
            .gte('created_at', startOfMonthIso)
            .lt('created_at', startOfNextMonthIso)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (leadsMonthResult.error) {
      return <ErrorState message={`Error leyendo leads del mes: ${leadsMonthResult.error.message}`} />;
    }
    if (paymentsMonthResult.error) {
      return <ErrorState message={`Error leyendo pagos del mes: ${paymentsMonthResult.error.message}`} />;
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
        '[DashboardPage] cash_transfers select falló (no fatal):',
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

    const leadsMonth = leadsMonthResult.count ?? 0;
    const paidMonth = (paymentsMonthResult.data ?? []).reduce(
      (s, p) => s + Number(p.amount ?? 0),
      0,
    );
    const deliveriesPending = deliveriesPendingResult.count ?? 0;
    const lowStock = (stockResult.data ?? []).reduce((c, r) => {
      const total = Number(r.stock_total ?? 0);
      const committed = Number(r.stock_committed ?? 0);
      const minimum = Number(r.stock_minimum ?? 0);
      const available = Math.max(0, total - committed);
      return available <= minimum ? c + 1 : c;
    }, 0);
    const cashValidatedMonth = (cashValidatedResult.data ?? []).reduce(
      (s, t) => s + Number(t.amount ?? 0),
      0,
    );
    // Σ (quantity * unit_cost) — entradas con costo registrado en el mes.
    // Si unit_cost es null la query ya lo filtró; igual usamos `?? 0` por
    // defensa.
    const materialsSpendMonth = (materialsSpendResult.data ?? []).reduce(
      (s, m) => s + Number(m.quantity ?? 0) * Number(m.unit_cost ?? 0),
      0,
    );

    // Saldo de la caja personal del admin en el mes:
    // SUM(ingresos) - SUM(egresos). 'validacion' contribuye igual que
    // 'egreso' (movimiento de salida hacia el contador).
    if (adminCashResult.error) {
      console.error(
        '[DashboardPage] admin_cash_register select falló (no fatal):',
        adminCashResult.error,
      );
    }
    const adminCashMonth = (adminCashResult.data ?? []).reduce((s, r) => {
      const amt = Number(r.amount ?? 0);
      return r.operation_type === 'ingreso' ? s + amt : s - amt;
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

    const monthLabel = MES_LABEL[mes] ?? '—';

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
              Métricas de {monthLabel} {anio}
            </p>
          </div>
          <div id="dashboard-filter">
            <MonthYearFilter mes={mes} anio={anio} />
          </div>
        </div>

        {/* Metric cards (6) — todas clickeables. Cada href incluye los
            mismos `mes`/`anio` activos para que el drill-down respete el
            filtro del dashboard, EXCEPTO "Stock bajo" que va a /warehouse
            sin params (el stock es estado actual, no tiene rango de mes). */}
        <div id="dashboard-metrics" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          <MetricCard
            icon={<ClipboardList size={20} />}
            iconBg="#DBEAFE"
            iconColor="#1E40AF"
            label="Leads del mes"
            value={leadsMonth.toString()}
            unit={leadsMonth === 1 ? 'lead registrado' : 'leads registrados'}
            href={`/leads?mes=${mes}&anio=${anio}`}
          />
          <MetricCard
            icon={<DollarSign size={20} />}
            iconBg="#DCFCE7"
            iconColor="#15803D"
            label="Cobrado en el mes"
            value={formatMXN(paidMonth)}
            unit="pagos exitosos del mes"
            href={`/payments?mes=${mes}&anio=${anio}`}
          />
          <MetricCard
            icon={<Wallet size={20} />}
            iconBg="#E0E7FF"
            iconColor="#1E3A8A"
            label="Efectivo validado"
            value={formatMXN(cashValidatedMonth)}
            unit="entregado y conciliado en el mes"
            href={`/admin/caja?tab=validados&mes=${mes}&anio=${anio}`}
          />
          <MetricCard
            icon={<PackagePlus size={20} />}
            iconBg="#FFEDD5"
            iconColor="#C2410C"
            label="Gasto en materiales"
            value={formatMXN(materialsSpendMonth)}
            unit="invertido en entradas del mes"
            href={`/warehouse/movements?type=entrada&mes=${mes}&anio=${anio}`}
          />
          <MetricCard
            icon={<Truck size={20} />}
            iconBg="#FEF3C7"
            iconColor="#92400E"
            label="Entregas pendientes"
            value={deliveriesPending.toString()}
            unit="por entregar o en tránsito (actual)"
            href={`/leads?delivery=pendiente&mes=${mes}&anio=${anio}`}
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
            label="Mi efectivo (mes)"
            value={formatMXN(adminCashMonth)}
            unit="cobrado en efectivo directo"
          />
        </div>

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
