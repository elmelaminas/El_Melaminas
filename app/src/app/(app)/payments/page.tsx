'use client';

import Link from 'next/link';
import { Plus, Eye, Calendar } from 'lucide-react';
import { mockPayments, formatMXN } from '@/data/mock';
import { MethodBadge, TypeBadge } from '@/components/ui/Badges';

export default function PaymentsPage() {
  const totalGross = mockPayments.reduce((s, p) => s + p.amount, 0);
  const totalDeduct = mockPayments.reduce(
    (s, p) => s + p.deductibles.reduce((a, d) => a + d.amount, 0),
    0,
  );
  const totalNet = mockPayments.reduce((s, p) => s + p.net_amount, 0);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Pagos</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Historial de cobros, deducciones y conciliación con choferes.
          </p>
        </div>
        <Link href="/payments/new" className="btn btn-primary">
          <Plus size={16} /> Registrar Pago
        </Link>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryCard label="Cobrado bruto" value={formatMXN(totalGross)} accent="#1E40AF" />
        <SummaryCard label="Deducibles"     value={`- ${formatMXN(totalDeduct)}`} accent="#B91C1C" />
        <SummaryCard label="Ingreso neto"   value={formatMXN(totalNet)} accent="#15803D" />
      </div>

      {/* Filters */}
      <div className="card p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <select className="select" defaultValue="">
            <option value="">Método</option>
            <option>Efectivo</option>
            <option>Transferencia</option>
            <option>Clip</option>
          </select>
          <select className="select" defaultValue="">
            <option value="">Tipo</option>
            <option>Anticipo</option>
            <option>Liquidación</option>
          </select>
          <div className="relative">
            <Calendar
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'var(--text-tertiary)' }}
            />
            <input type="date" className="input" style={{ paddingLeft: 36 }} />
          </div>
          <select className="select" defaultValue="">
            <option value="">Chofer</option>
            <option>Carlos Ramírez</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="tbl-wrap">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>ID</th>
                <th>Cliente</th>
                <th>Monto cobrado</th>
                <th>Deducibles</th>
                <th>Neto</th>
                <th>Método</th>
                <th>Tipo</th>
                <th>Chofer</th>
                <th>Fecha</th>
                <th className="text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {mockPayments.map((p) => {
                const ded = p.deductibles.reduce((a, d) => a + d.amount, 0);
                return (
                  <tr key={p.id}>
                    <td className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {p.id}
                    </td>
                    <td>
                      <div className="font-medium">{p.client_name}</div>
                      <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {p.lead_id}
                      </div>
                    </td>
                    <td className="font-semibold">{formatMXN(p.amount)}</td>
                    <td>
                      {ded === 0 ? (
                        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          —
                        </span>
                      ) : (
                        <div>
                          <div style={{ color: 'var(--danger)', fontWeight: 600 }}>
                            -{formatMXN(ded)}
                          </div>
                          <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {p.deductibles.map((d) => d.concept).join(', ')}
                          </div>
                        </div>
                      )}
                    </td>
                    <td
                      className="font-semibold"
                      style={{ color: 'var(--success)' }}
                    >
                      {formatMXN(p.net_amount)}
                    </td>
                    <td><MethodBadge method={p.method} /></td>
                    <td><TypeBadge type={p.type} /></td>
                    <td>{p.driver}</td>
                    <td className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                      {p.date}
                    </td>
                    <td>
                      <div className="flex justify-end">
                        <button
                          className="btn btn-ghost"
                          style={{ padding: '6px' }}
                          aria-label="Ver"
                        >
                          <Eye size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="card p-5">
      <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </div>
      <div
        className="text-2xl font-bold mt-1"
        style={{ color: accent }}
      >
        {value}
      </div>
    </div>
  );
}
