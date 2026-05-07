'use client';

import { useState } from 'react';
import {
  MapPin,
  Box,
  CircleCheckBig,
  Camera,
  ChevronDown,
  ChevronUp,
  Layers,
} from 'lucide-react';
import {
  formatMXN,
  mockDeliveries,
  mockLeads,
  mockUsers,
} from '@/data/mock';
import { DeliveryBadge } from '@/components/ui/Badges';
import { useDemo } from '@/context/DemoContext';

export default function DriverPage() {
  const { user } = useDemo();
  const [historyOpen, setHistoryOpen] = useState(false);

  const driverName =
    user.role === 'driver' ? user.name : 'Carlos Ramírez';

  const admins = mockUsers
    .filter((u) => u.role === 'admin' || u.role === 'supervisor')
    .map((u) => u.name);

  const completed = mockLeads.filter((l) => l.delivery_status === 'entregado');

  return (
    <div
      className="mx-auto"
      style={{ maxWidth: 420, width: '100%' }}
    >
      {/* Mobile-style header card */}
      <div
        className="rounded-2xl mb-5 p-4 flex items-center gap-3"
        style={{
          background: 'linear-gradient(135deg, #1B3A5C 0%, #2E74B5 100%)',
          color: '#fff',
        }}
      >
        <div
          className="flex items-center justify-center"
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: 'var(--brand-accent)',
            color: '#1F2937',
          }}
        >
          <Layers size={22} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="text-xs" style={{ opacity: 0.75 }}>
            Buen día,
          </div>
          <div className="font-semibold truncate">{driverName}</div>
        </div>
        <div className="text-right">
          <div className="text-xs" style={{ opacity: 0.75 }}>
            Hoy
          </div>
          <div className="font-bold">{mockDeliveries.length} entregas</div>
        </div>
      </div>

      {/* Active deliveries */}
      <div className="flex flex-col gap-4">
        <div className="px-1 text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
          Entregas activas
        </div>
        {mockDeliveries.map((d) => (
          <DeliveryCard key={d.id} delivery={d} admins={admins} />
        ))}
      </div>

      {/* History */}
      <div className="mt-6">
        <button
          onClick={() => setHistoryOpen((v) => !v)}
          className="w-full card flex items-center justify-between p-4"
          style={{ background: 'var(--bg-subtle)' }}
        >
          <div className="text-left">
            <div className="font-semibold">Historial de entregas</div>
            <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {completed.length} completadas hoy
            </div>
          </div>
          {historyOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
        {historyOpen && (
          <div className="mt-3 flex flex-col gap-2">
            {completed.map((l) => (
              <div
                key={l.id}
                className="card p-3 flex items-center justify-between"
              >
                <div>
                  <div className="text-sm font-medium">{l.client_name}</div>
                  <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {l.id} · {formatMXN(l.total_amount)}
                  </div>
                </div>
                <DeliveryBadge status={l.delivery_status} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DeliveryCard({
  delivery,
  admins,
}: {
  delivery: (typeof mockDeliveries)[number];
  admins: string[];
}) {
  const [admin, setAdmin] = useState(admins[0] ?? 'Sergio Granados');
  const owes = delivery.adeudo > 0;

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <div className="text-xs font-mono" style={{ color: 'var(--text-tertiary)' }}>
            {delivery.id}
          </div>
          <div
            className="font-bold leading-tight mt-1"
            style={{ fontSize: '1.25rem' }}
          >
            {delivery.client_name}
          </div>
        </div>
        <DeliveryBadge status={delivery.delivery_status} />
      </div>

      {/* Address */}
      <div className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
        {delivery.address}
      </div>
      <a
        href={delivery.maps_url}
        className="btn w-full mb-4"
        style={{
          background: '#16A34A',
          color: '#fff',
          height: 44,
        }}
      >
        <MapPin size={16} /> Ver en mapa
      </a>

      {/* Materials */}
      <div className="mb-4">
        <div
          className="text-xs uppercase tracking-wide mb-2"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Materiales
        </div>
        <div className="flex flex-col gap-2">
          {delivery.colors.map((c) => (
            <div
              key={c.color}
              className="flex items-center gap-3 p-2 rounded-lg"
              style={{ background: 'var(--bg-subtle)' }}
            >
              <div
                className="flex items-center justify-center"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: '#FEF3C7',
                  color: '#92400E',
                }}
              >
                <Box size={16} />
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium">{c.color}</div>
              </div>
              <div className="font-bold text-sm">×{c.qty}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Total + adeudo */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            Total
          </div>
          <div className="font-semibold">{formatMXN(delivery.total_amount)}</div>
        </div>
        <div className="text-right">
          {owes ? (
            <>
              <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                Adeudo
              </div>
              <div
                className="text-2xl font-bold"
                style={{ color: 'var(--danger)' }}
              >
                {formatMXN(delivery.adeudo)}
              </div>
            </>
          ) : (
            <div
              className="font-bold flex items-center gap-1"
              style={{ color: 'var(--success)' }}
            >
              <CircleCheckBig size={18} /> Pagado
            </div>
          )}
        </div>
      </div>

      <hr style={{ border: 0, borderTop: '1px solid var(--border)' }} />

      <div className="mt-4">
        <div className="font-semibold mb-3">Confirmar entrega</div>

        {owes && (
          <div className="dropzone mb-3">
            <Camera size={22} style={{ color: 'var(--text-tertiary)' }} className="mx-auto mb-1" />
            <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Sube foto del cobro
            </div>
            <div className="text-[11px]">
              Comprobante de transferencia, ticket o efectivo
            </div>
          </div>
        )}

        <div className="mb-3">
          <label className="label">Entregar efectivo a</label>
          <select
            className="select"
            value={admin}
            onChange={(e) => setAdmin(e.target.value)}
          >
            {admins.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>

        <button
          className="btn btn-primary w-full"
          style={{ height: 56, fontSize: '1rem', fontWeight: 600 }}
        >
          <CircleCheckBig size={20} /> Entregado a {admin.split(' ')[0]}
        </button>
      </div>
    </div>
  );
}
