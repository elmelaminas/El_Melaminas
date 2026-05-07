'use client';

import { useState } from 'react';
import {
  Plus,
  Package,
  Lock,
  TriangleAlert,
  X,
  Calendar,
  ArrowDown,
  ArrowUp,
  Settings2,
} from 'lucide-react';
import {
  COLORS_LIST,
  mockInventory,
  mockMovements,
} from '@/data/mock';
import { StockBadge } from '@/components/ui/Badges';

const TYPE_BADGE: Record<string, string> = {
  Entrada: 'badge badge-success',
  Salida: 'badge badge-info',
  Ajuste: 'badge badge-warning',
};

const TYPE_ICON: Record<string, React.ReactNode> = {
  Entrada: <ArrowDown size={12} />,
  Salida: <ArrowUp size={12} />,
  Ajuste: <Settings2 size={12} />,
};

export default function WarehousePage() {
  const [showEntry, setShowEntry] = useState(false);

  const totalStock = mockInventory.reduce((s, m) => s + m.stock_total, 0);
  const totalCommitted = mockInventory.reduce((s, m) => s + m.stock_committed, 0);
  const lowStock = mockInventory.filter((m) => m.status !== 'ok').length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Almacén</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Stock por color, alertas de mínimos y bitácora de movimientos.
          </p>
        </div>
        <button
          onClick={() => setShowEntry(true)}
          className="btn btn-primary"
        >
          <Plus size={16} /> Registrar Entrada
        </button>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Metric
          label="Total en stock"
          value={totalStock.toString()}
          icon={<Package size={20} />}
          bg="#DBEAFE"
          color="#1E40AF"
          unit="hojas"
        />
        <Metric
          label="Comprometidos"
          value={totalCommitted.toString()}
          icon={<Lock size={20} />}
          bg="#FEF3C7"
          color="#92400E"
          unit="hojas reservadas"
        />
        <Metric
          label="Alertas de stock"
          value={lowStock.toString()}
          icon={<TriangleAlert size={20} />}
          bg="#FEE2E2"
          color="#B91C1C"
          unit="materiales por debajo del mínimo"
        />
      </div>

      {/* Stock table */}
      <div className="tbl-wrap">
        <div className="px-6 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
          <h3 className="font-semibold">Stock por color</h3>
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {mockInventory.length} materiales
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Material</th>
                <th className="text-center">Stock total</th>
                <th className="text-center">Disponible</th>
                <th className="text-center">Comprometido</th>
                <th className="text-center">Mínimo</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {mockInventory.map((m) => (
                <tr
                  key={m.color}
                  className={
                    m.status === 'danger'
                      ? 'row-danger'
                      : m.status === 'warning'
                      ? 'row-warning'
                      : ''
                  }
                >
                  <td>
                    <div className="flex items-center gap-2 font-medium">
                      <span
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 4,
                          background: colorToHex(m.color),
                          border: '1px solid var(--border-strong)',
                        }}
                      />
                      {m.color}
                    </div>
                  </td>
                  <td className="text-center font-semibold">{m.stock_total}</td>
                  <td className="text-center">
                    <span
                      className="font-bold"
                      style={{
                        color:
                          m.status === 'danger'
                            ? 'var(--danger)'
                            : m.status === 'warning'
                            ? 'var(--warning)'
                            : 'var(--success)',
                      }}
                    >
                      {m.stock_available}
                    </span>
                  </td>
                  <td className="text-center">{m.stock_committed}</td>
                  <td className="text-center" style={{ color: 'var(--text-tertiary)' }}>
                    {m.stock_minimum}
                  </td>
                  <td><StockBadge status={m.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Movements */}
      <div className="tbl-wrap">
        <div className="px-6 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
          <h3 className="font-semibold">Últimos movimientos</h3>
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            últimos {mockMovements.length}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Material</th>
                <th className="text-center">Cantidad</th>
                <th>Referencia</th>
                <th>Usuario</th>
              </tr>
            </thead>
            <tbody>
              {mockMovements.map((m) => (
                <tr key={m.id}>
                  <td className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {m.date}
                  </td>
                  <td>
                    <span className={`${TYPE_BADGE[m.type]} flex items-center gap-1`}>
                      {TYPE_ICON[m.type]} {m.type}
                    </span>
                  </td>
                  <td>{m.material}</td>
                  <td
                    className="text-center font-semibold"
                    style={{ color: m.quantity > 0 ? 'var(--success)' : 'var(--danger)' }}
                  >
                    {m.quantity > 0 ? '+' : ''}
                    {m.quantity}
                  </td>
                  <td className="text-sm">{m.reference}</td>
                  <td className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {m.user}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Entry side panel */}
      {showEntry && (
        <EntryDrawer onClose={() => setShowEntry(false)} />
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  icon,
  bg,
  color,
  unit,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  bg: string;
  color: string;
  unit: string;
}) {
  return (
    <div className="stat-card">
      <div className="flex items-center justify-between">
        <div
          className="flex items-center justify-center"
          style={{ width: 40, height: 40, borderRadius: 10, background: bg, color }}
        >
          {icon}
        </div>
      </div>
      <div className="mt-3">
        <div className="text-2xl font-bold tracking-tight">{value}</div>
        <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </div>
        <div className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
          {unit}
        </div>
      </div>
    </div>
  );
}

function EntryDrawer({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex"
      style={{ background: 'rgba(15,23,42,0.45)' }}
    >
      <div className="flex-1" onClick={onClose} />
      <div
        className="bg-white h-full overflow-y-auto p-6 animate-fade"
        style={{ width: 'min(440px, 100%)', boxShadow: '-8px 0 24px rgba(0,0,0,0.12)' }}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-lg">Registrar entrada</h3>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              Ingreso de mercancía al almacén
            </p>
          </div>
          <button
            className="btn btn-ghost"
            style={{ padding: '6px' }}
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <label className="label">Material</label>
            <select className="select">
              {COLORS_LIST.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Cantidad de hojas</label>
            <input className="input" type="number" min={1} placeholder="0" />
          </div>
          <div>
            <label className="label">Fecha</label>
            <div className="relative">
              <Calendar
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: 'var(--text-tertiary)' }}
              />
              <input
                type="date"
                className="input"
                style={{ paddingLeft: 36 }}
                defaultValue={new Date().toISOString().slice(0, 10)}
              />
            </div>
          </div>
          <div>
            <label className="label">Referencia (orden de compra)</label>
            <input className="input" placeholder="OC-2026-083" />
          </div>
          <div>
            <label className="label">Notas</label>
            <textarea className="textarea" rows={3} placeholder="Observaciones…" />
          </div>
        </div>

        <div className="flex gap-2 mt-6">
          <button className="btn btn-outline flex-1" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary flex-1">Guardar entrada</button>
        </div>
      </div>
    </div>
  );
}

function colorToHex(name: string): string {
  switch (name) {
    case 'Negra': return '#1F2937';
    case 'Blanca': return '#F8FAFC';
    case 'Gris': return '#94A3B8';
    case 'Parota': return '#A16207';
    case 'Nogal': return '#7C2D12';
    case 'Wengue': return '#3F1F0F';
    default: return '#CBD5E1';
  }
}
