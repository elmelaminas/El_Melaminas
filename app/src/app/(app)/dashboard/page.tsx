'use client';

import Link from 'next/link';
import {
  ClipboardList,
  DollarSign,
  Truck,
  AlertTriangle,
  TrendingUp,
  Eye,
  Pencil,
} from 'lucide-react';
import {
  formatMXN,
  mockLeads,
  mockNotifications,
} from '@/data/mock';
import {
  ChannelBadge,
  DeliveryBadge,
  PaymentBadge,
} from '@/components/ui/Badges';
import { useDemo } from '@/context/DemoContext';

const channelChart = [
  { label: 'TikTok',   value: 8,  color: '#7C3AED' },
  { label: 'WhatsApp', value: 15, color: '#16A34A' },
  { label: 'Google',   value: 6,  color: '#2E74B5' },
  { label: 'Tienda',   value: 4,  color: '#EA580C' },
];

const NOTIF_DOT: Record<string, string> = {
  info: 'bg-[#2E74B5]',
  success: 'bg-[#16A34A]',
  warning: 'bg-[#D97706]',
  danger: 'bg-[#DC2626]',
};

export default function DashboardPage() {
  const { user } = useDemo();
  const recent = mockLeads.slice(0, 5);
  const maxBar = Math.max(...channelChart.map((c) => c.value));

  return (
    <div className="flex flex-col gap-6">
      {/* Title */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--text-primary)' }}>
          Buen día, {user.name.split(' ')[0]} 👋
        </h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Resumen operativo del día — {new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard
          icon={<ClipboardList size={20} />}
          iconBg="#DBEAFE"
          iconColor="#1E40AF"
          label="Leads hoy"
          value="3"
          delta="+12% vs ayer"
          deltaPositive
        />
        <MetricCard
          icon={<DollarSign size={20} />}
          iconBg="#DCFCE7"
          iconColor="#15803D"
          label="Cobrado hoy"
          value={formatMXN(19700)}
          delta="+8% vs ayer"
          deltaPositive
        />
        <MetricCard
          icon={<Truck size={20} />}
          iconBg="#FEF3C7"
          iconColor="#92400E"
          label="Entregas pendientes"
          value="2"
          delta="1 en tránsito"
        />
        <MetricCard
          icon={<AlertTriangle size={20} />}
          iconBg="#FEE2E2"
          iconColor="#B91C1C"
          label="Stock bajo"
          value="3"
          delta="materiales por reponer"
        />
      </div>

      {/* Chart + notifications */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Bars */}
        <div className="card p-6 xl:col-span-2">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="font-semibold">Leads por canal</h3>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                Esta semana
              </p>
            </div>
            <span className="badge badge-success flex items-center gap-1">
              <TrendingUp size={12} /> +18%
            </span>
          </div>
          <div className="grid grid-cols-4 gap-6 items-end" style={{ height: 220 }}>
            {channelChart.map((c) => (
              <div key={c.label} className="flex flex-col items-center justify-end h-full gap-2">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {c.value}
                </div>
                <div
                  style={{
                    width: '70%',
                    maxWidth: 64,
                    height: `${(c.value / maxBar) * 170}px`,
                    background: c.color,
                    borderRadius: '8px 8px 0 0',
                    transition: 'height 300ms ease',
                  }}
                />
                <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {c.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Notifications */}
        <div className="card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Notificaciones</h3>
            <span className="badge badge-danger">{mockNotifications.length}</span>
          </div>
          <div className="flex flex-col gap-3">
            {mockNotifications.slice(0, 4).map((n) => (
              <div
                key={n.id}
                className="flex gap-3 p-3 rounded-lg"
                style={{ background: 'var(--bg-subtle)' }}
              >
                <span
                  className={`mt-1.5 inline-block rounded-full ${NOTIF_DOT[n.type]}`}
                  style={{ width: 8, height: 8, flexShrink: 0 }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="text-sm font-medium truncate">{n.title}</div>
                  <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {n.message}
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                    {n.time}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recent leads */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div>
            <h3 className="font-semibold">Últimos leads</h3>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              5 más recientes
            </p>
          </div>
          <Link href="/leads" className="btn btn-outline" style={{ padding: '6px 14px' }}>
            Ver todos
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Canal</th>
                <th>Vendedora</th>
                <th>Total</th>
                <th>Entrega</th>
                <th>Pago</th>
                <th className="text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((l) => (
                <tr key={l.id}>
                  <td className="font-medium">{l.client_name}</td>
                  <td><ChannelBadge channel={l.channel} /></td>
                  <td>{l.seller}</td>
                  <td className="font-semibold">{formatMXN(l.total_amount)}</td>
                  <td><DeliveryBadge status={l.delivery_status} /></td>
                  <td><PaymentBadge status={l.payment_status} /></td>
                  <td>
                    <div className="flex justify-end gap-1">
                      <button className="btn btn-ghost" style={{ padding: '6px' }} aria-label="Ver"><Eye size={16} /></button>
                      <button className="btn btn-ghost" style={{ padding: '6px' }} aria-label="Editar"><Pencil size={16} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  iconBg,
  iconColor,
  label,
  value,
  delta,
  deltaPositive,
}: {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  label: string;
  value: string;
  delta?: string;
  deltaPositive?: boolean;
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
        {delta && deltaPositive && (
          <span className="badge badge-success flex items-center gap-1">
            <TrendingUp size={10} /> {delta.replace('+', '').split(' ')[0]}
          </span>
        )}
      </div>
      <div className="mt-3">
        <div className="text-2xl font-bold tracking-tight">{value}</div>
        <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </div>
        {delta && !deltaPositive && (
          <div className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
            {delta}
          </div>
        )}
      </div>
    </div>
  );
}
