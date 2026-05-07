import Link from 'next/link';
import {
  ClipboardList,
  DollarSign,
  Truck,
  TriangleAlert,
  TrendingUp,
} from 'lucide-react';
import {
  ChannelBadge,
  DeliveryBadge,
  PaymentBadge,
} from '@/components/ui/Badges';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { formatMXN, type Channel } from '@/data/mock';

/**
 * Dashboard /dashboard.
 *
 * 100% Server Component — sin Client Component intermedio porque no hay
 * interactividad. Todo el rendering es estático tras hacer las queries.
 *
 * Las 4 métricas clave + chart de canales + recent leads se cargan en
 * paralelo con `Promise.all`. Cualquier error en una query rompe la
 * página entera (try/catch envolvente → ErrorState con el message
 * exacto). Aceptable porque las 4 son críticas para que el dashboard
 * sea útil.
 *
 * Ventana "hoy" se calcula en UTC en el server: `[startOfDay, endOfDay)`
 * en TZ del usuario produciría off-by-one para usuarios en otra zona,
 * pero como El Melaminas opera en es-MX uniformemente y el Vercel runtime
 * está en UTC, la diferencia genera <24h de drift en casos extremos.
 * Si quieres precisión exacta zona horaria de México, parametriza la TZ.
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

export default async function DashboardPage() {
  try {
    const userClient = await supabaseServer();
    const {
      data: { user },
    } = await userClient.auth.getUser();

    const admin = supabaseAdmin();

    // Ventana de hoy en UTC. sale_date es DATE (no timestamp), lo
    // comparamos como string YYYY-MM-DD.
    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const startOfDay = new Date(`${todayIso}T00:00:00.000Z`).toISOString();
    const startOfTomorrow = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        0,
        0,
        0,
      ),
    ).toISOString();

    // Ventana de últimos 7 días para el chart.
    const sevenDaysAgo = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - 6,
        0,
        0,
        0,
        0,
      ),
    )
      .toISOString()
      .slice(0, 10);

    // 6 queries en paralelo: 4 métricas + chart + recent leads + (perfil
    // del usuario para el greeting si pudimos auth-earlo).
    const [
      leadsTodayResult,
      paymentsTodayResult,
      deliveriesPendingResult,
      stockResult,
      channelChartResult,
      recentLeadsResult,
      profileResult,
    ] = await Promise.all([
      // 1. Leads hoy (sale_date = todayIso)
      admin
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('sale_date', todayIso)
        .is('deleted_at', null),
      // 2. Pagos exitosos en la ventana [startOfDay, startOfTomorrow)
      admin
        .from('payments')
        .select('amount')
        .eq('status', 'exitoso')
        .gte('paid_at', startOfDay)
        .lt('paid_at', startOfTomorrow),
      // 3. Entregas pendientes
      admin
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .in('delivery_status', ['pendiente', 'en_transito'])
        .is('deleted_at', null),
      // 4. Inventory para detectar stock bajo (filtrar en JS porque
      //    PostgREST no soporta `(stock_total - stock_committed) <= min`).
      admin
        .from('inventory')
        .select('stock_total, stock_committed, stock_minimum'),
      // 5. Chart por canal de los últimos 7 días
      admin
        .from('leads')
        .select('channel')
        .gte('sale_date', sevenDaysAgo)
        .is('deleted_at', null),
      // 6. Recent leads (5 más recientes)
      admin
        .from('leads')
        .select(
          `id, client_name, channel, total_amount, delivery_status, payment_status,
           sellers ( name )`,
        )
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(5),
      // 7. Profile del usuario para el greeting (best-effort)
      user
        ? admin
            .from('profiles')
            .select('full_name')
            .eq('id', user.id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (leadsTodayResult.error) {
      return <ErrorState message={`Error leyendo leads hoy: ${leadsTodayResult.error.message}`} />;
    }
    if (paymentsTodayResult.error) {
      return <ErrorState message={`Error leyendo pagos hoy: ${paymentsTodayResult.error.message}`} />;
    }
    if (deliveriesPendingResult.error) {
      return <ErrorState message={`Error leyendo entregas: ${deliveriesPendingResult.error.message}`} />;
    }
    if (stockResult.error) {
      return <ErrorState message={`Error leyendo inventario: ${stockResult.error.message}`} />;
    }
    if (channelChartResult.error) {
      return <ErrorState message={`Error leyendo chart: ${channelChartResult.error.message}`} />;
    }
    if (recentLeadsResult.error) {
      return <ErrorState message={`Error leyendo recientes: ${recentLeadsResult.error.message}`} />;
    }

    const leadsToday = leadsTodayResult.count ?? 0;
    const paidToday = (paymentsTodayResult.data ?? []).reduce(
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

    // Aggregar el chart de canales — count por channel.
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
          // Mismo mapeo que /leads: DB lowercase → Channel uppercase.
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

    return (
      <div className="flex flex-col gap-6">
        {/* Title */}
        <div>
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ color: 'var(--text-primary)' }}
          >
            Buen día, {firstName} 👋
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Resumen operativo del día —{' '}
            {now.toLocaleDateString('es-MX', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </p>
        </div>

        {/* Metric cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <MetricCard
            icon={<ClipboardList size={20} />}
            iconBg="#DBEAFE"
            iconColor="#1E40AF"
            label="Leads hoy"
            value={leadsToday.toString()}
            unit={leadsToday === 1 ? 'lead registrado' : 'leads registrados'}
          />
          <MetricCard
            icon={<DollarSign size={20} />}
            iconBg="#DCFCE7"
            iconColor="#15803D"
            label="Cobrado hoy"
            value={formatMXN(paidToday)}
            unit="pagos exitosos del día"
          />
          <MetricCard
            icon={<Truck size={20} />}
            iconBg="#FEF3C7"
            iconColor="#92400E"
            label="Entregas pendientes"
            value={deliveriesPending.toString()}
            unit="por entregar o en tránsito"
          />
          <MetricCard
            icon={<TriangleAlert size={20} />}
            iconBg="#FEE2E2"
            iconColor="#B91C1C"
            label="Stock bajo"
            value={lowStock.toString()}
            unit="materiales por debajo del mínimo"
          />
        </div>

        {/* Chart de canales (últimos 7 días) */}
        <div className="card p-6">
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
}: {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <div className="stat-card">
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
