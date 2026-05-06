'use client';

import Link from 'next/link';
import { useState, useMemo } from 'react';
import {
  ArrowLeft,
  Search,
  Plus,
  X,
  Camera,
  Upload,
} from 'lucide-react';
import {
  formatMXN,
  mockLeads,
  mockPayments,
  mockUsers,
  PAYMENT_METHODS,
  PAYMENT_TYPES,
} from '@/data/mock';
import { MethodBadge, TypeBadge } from '@/components/ui/Badges';

interface DedRow {
  id: number;
  concept: string;
  amount: number;
}

export default function NewPaymentPage() {
  const [query, setQuery] = useState('');
  const [selectedLeadId, setSelectedLeadId] = useState('L001');
  const [amount, setAmount] = useState<number>(4875);
  const [deductibles, setDeductibles] = useState<DedRow[]>([
    { id: 1, concept: 'Gasolina', amount: 180 },
  ]);

  const lead = mockLeads.find((l) => l.id === selectedLeadId) ?? mockLeads[0];

  const totalDed = useMemo(
    () => deductibles.reduce((s, d) => s + (Number(d.amount) || 0), 0),
    [deductibles],
  );
  const net = Math.max(amount - totalDed, 0);

  const previousPayments = mockPayments.filter((p) => p.lead_id === lead.id);

  const drivers = mockUsers
    .filter((u) => u.role === 'driver' || u.role === 'admin')
    .map((u) => u.name);

  const filteredLeads = query
    ? mockLeads.filter(
        (l) =>
          l.client_name.toLowerCase().includes(query.toLowerCase()) ||
          l.id.toLowerCase().includes(query.toLowerCase()) ||
          l.phone.includes(query),
      )
    : mockLeads.slice(0, 5);

  const addDed = () =>
    setDeductibles((prev) => [
      ...prev,
      { id: Date.now(), concept: '', amount: 0 },
    ]);
  const removeDed = (id: number) =>
    setDeductibles((prev) => prev.filter((d) => d.id !== id));
  const updateDed = (id: number, patch: Partial<DedRow>) =>
    setDeductibles((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    );

  return (
    <div className="flex flex-col gap-6 max-w-6xl">
      <div className="flex items-center gap-3">
        <Link href="/payments" className="btn btn-ghost" style={{ padding: '8px' }}>
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Registrar Pago</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Captura cobros, deducibles y entrega de efectivo al admin.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left col */}
        <div className="xl:col-span-2 flex flex-col gap-6">
          {/* Lead search */}
          <div className="card p-6">
            <h3 className="font-semibold mb-4">Lead asociado</h3>
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--text-tertiary)' }}
              />
              <input
                placeholder="Busca por cliente, teléfono o ID…"
                className="input"
                style={{ paddingLeft: 36 }}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {/* results */}
            <div
              className="mt-3 rounded-lg border max-h-56 overflow-y-auto"
              style={{ borderColor: 'var(--border)' }}
            >
              {filteredLeads.length === 0 && (
                <div
                  className="p-4 text-sm"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Sin resultados.
                </div>
              )}
              {filteredLeads.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setSelectedLeadId(l.id)}
                  className="w-full text-left px-4 py-3 flex items-center justify-between border-b last:border-b-0 hover:bg-[var(--bg-muted)]"
                  style={{
                    borderColor: 'var(--border)',
                    background:
                      l.id === lead.id ? '#EFF6FF' : 'transparent',
                  }}
                >
                  <div>
                    <div className="text-sm font-medium">{l.client_name}</div>
                    <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {l.id} · {l.phone}
                    </div>
                  </div>
                  <div className="text-sm font-semibold">
                    {formatMXN(l.total_amount)}
                  </div>
                </button>
              ))}
            </div>

            {/* Selected lead readonly */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-5">
              <div>
                <label className="label">Cliente</label>
                <input className="input" value={lead.client_name} readOnly />
              </div>
              <div>
                <label className="label">Total compra</label>
                <input className="input" value={formatMXN(lead.total_amount)} readOnly />
              </div>
              <div>
                <label className="label">Adeudo pendiente</label>
                <input
                  className="input"
                  value={formatMXN(lead.adeudo)}
                  readOnly
                  style={
                    lead.adeudo > 0
                      ? { background: '#FEE2E2', color: '#B91C1C', fontWeight: 600 }
                      : { background: 'var(--bg-muted)' }
                  }
                />
              </div>
            </div>
          </div>

          {/* Cobro */}
          <div className="card p-6">
            <h3 className="font-semibold mb-4">Datos del cobro</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="label">Monto que paga</label>
                <input
                  type="number"
                  className="input"
                  value={amount}
                  onChange={(e) => setAmount(Number(e.target.value))}
                />
              </div>
              <div>
                <label className="label">Método de pago</label>
                <select className="select" defaultValue="Transferencia">
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Tipo de pago</label>
                <select className="select" defaultValue="Anticipo">
                  {PAYMENT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Chofer asignado</label>
                <select className="select" defaultValue="Carlos Ramírez">
                  {drivers.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Deducibles */}
            <div className="mt-6">
              <div className="flex items-center justify-between mb-2">
                <label className="label" style={{ marginBottom: 0 }}>
                  Deducibles
                </label>
                <button
                  type="button"
                  onClick={addDed}
                  className="btn btn-outline"
                  style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                >
                  <Plus size={12} /> Agregar deducible
                </button>
              </div>
              {deductibles.length === 0 && (
                <div
                  className="rounded-lg border-dashed border p-4 text-center text-sm"
                  style={{
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-tertiary)',
                  }}
                >
                  Sin deducibles registrados.
                </div>
              )}
              <div className="flex flex-col gap-2">
                {deductibles.map((d) => (
                  <div
                    key={d.id}
                    className="grid grid-cols-12 gap-2 items-center"
                  >
                    <input
                      className="input col-span-7"
                      placeholder="Concepto (ej. Gasolina, Comisión Clip)"
                      value={d.concept}
                      onChange={(e) =>
                        updateDed(d.id, { concept: e.target.value })
                      }
                    />
                    <input
                      type="number"
                      className="input col-span-3"
                      placeholder="0"
                      value={d.amount}
                      onChange={(e) =>
                        updateDed(d.id, { amount: Number(e.target.value) })
                      }
                    />
                    <button
                      type="button"
                      onClick={() => removeDed(d.id)}
                      className="btn btn-danger-outline col-span-2"
                      style={{ padding: '6px' }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Evidencia */}
            <div className="mt-6">
              <label className="label">Evidencia del pago</label>
              <div className="dropzone flex flex-col items-center gap-2">
                <Camera size={28} style={{ color: 'var(--text-tertiary)' }} />
                <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                  Arrastra una foto o haz clic para subir
                </div>
                <div className="text-xs">PNG, JPG hasta 5 MB</div>
                <button
                  type="button"
                  className="btn btn-outline mt-1"
                  style={{ padding: '6px 12px' }}
                >
                  <Upload size={14} /> Seleccionar archivo
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right col — sticky summary */}
        <div className="xl:sticky xl:top-24 self-start">
          <div className="card p-6">
            <h3 className="font-semibold mb-4">Resumen del cobro</h3>
            <div className="space-y-3 text-sm">
              <Row label="Monto bruto" value={formatMXN(amount)} />
              <Row
                label="Deducibles"
                value={`- ${formatMXN(totalDed)}`}
                color={totalDed > 0 ? 'var(--danger)' : undefined}
              />
              <div
                className="border-t pt-3"
                style={{ borderColor: 'var(--border)' }}
              >
                <div
                  className="text-xs uppercase tracking-wide"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Ingreso neto
                </div>
                <div
                  className="text-3xl font-bold mt-1"
                  style={{ color: 'var(--success)' }}
                >
                  {formatMXN(net)}
                </div>
              </div>
            </div>
            <button className="btn btn-primary w-full mt-5" style={{ height: 44 }}>
              Registrar Pago
            </button>
          </div>

          {/* Historial */}
          <div className="card p-5 mt-5">
            <h3 className="font-semibold mb-3 text-sm">
              Pagos previos · {lead.client_name}
            </h3>
            {previousPayments.length === 0 ? (
              <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                Sin pagos previos.
              </div>
            ) : (
              <div className="space-y-2">
                {previousPayments.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between text-xs p-2 rounded"
                    style={{ background: 'var(--bg-subtle)' }}
                  >
                    <div className="flex items-center gap-2">
                      <MethodBadge method={p.method} />
                      <TypeBadge type={p.type} />
                    </div>
                    <div className="text-right">
                      <div className="font-semibold text-sm">
                        {formatMXN(p.amount)}
                      </div>
                      <div style={{ color: 'var(--text-tertiary)' }}>
                        {p.date}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="flex justify-between">
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ color, fontWeight: 600 }}>{value}</span>
    </div>
  );
}
