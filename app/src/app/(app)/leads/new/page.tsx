'use client';

import Link from 'next/link';
import { useState, useMemo } from 'react';
import {
  ArrowLeft,
  Plus,
  X,
  Calendar,
  MessageCircle,
  Phone,
  Globe,
  Store,
} from 'lucide-react';
import {
  COLORS_LIST,
  COST_PER_SHEET_OPTIONS,
  formatMXN,
  mockSellers,
  mockUsers,
} from '@/data/mock';

interface ColorRow {
  id: number;
  qty: number;
  color: string;
}

const CHANNEL_OPTIONS = [
  { value: 'WHATSAPP', label: 'WhatsApp', icon: <MessageCircle size={14} /> },
  { value: 'TIKTOK',   label: 'TikTok',   icon: <Phone size={14} /> },
  { value: 'GOOGLE',   label: 'Google',   icon: <Globe size={14} /> },
  { value: 'TIENDA',   label: 'Tienda',   icon: <Store size={14} /> },
];

export default function NewLeadPage() {
  const [costPerSheet, setCostPerSheet] = useState<number>(750);
  const [colors, setColors] = useState<ColorRow[]>([
    { id: 1, qty: 5, color: 'Negra' },
    { id: 2, qty: 3, color: 'Gris' },
  ]);

  const totalSheets = useMemo(
    () => colors.reduce((s, c) => s + (Number(c.qty) || 0), 0),
    [colors],
  );
  const total = totalSheets * costPerSheet;

  const addRow = () =>
    setColors((prev) => [
      ...prev,
      { id: Date.now(), qty: 1, color: COLORS_LIST[0] },
    ]);
  const removeRow = (id: number) =>
    setColors((prev) => prev.filter((c) => c.id !== id));
  const updateRow = (id: number, patch: Partial<ColorRow>) =>
    setColors((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    );

  const sellers = mockUsers
    .filter((u) => u.role === 'seller' && u.active)
    .map((u) => u.name)
    .concat(mockSellers.filter((s) => s.active && !s.linked_user).map((s) => s.name));

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href="/leads"
          className="btn btn-ghost"
          style={{ padding: '8px' }}
          aria-label="Regresar"
        >
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Nuevo Lead</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Registra un nuevo cliente y los detalles de su pedido.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Form */}
        <div className="xl:col-span-2 flex flex-col gap-6">
          {/* Origen */}
          <Section title="Origen del Lead" subtitle="¿Cómo llegó este cliente?">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="label">Canal</label>
                <select className="select" defaultValue="WHATSAPP">
                  {CHANNEL_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Vendedor(a)</label>
                <select className="select" defaultValue="Ana López">
                  {sellers.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Tipo de venta</label>
                <select className="select" defaultValue="Primer Contacto">
                  <option>Primer Contacto</option>
                  <option>Recompra</option>
                  <option>Seguimiento</option>
                  <option>Venta Empleado</option>
                </select>
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
            </div>
          </Section>

          {/* Cliente */}
          <Section title="Datos del Cliente" subtitle="Contacto y dirección de entrega.">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="label">Nombre completo</label>
                <input className="input" placeholder="Ej. Juan Pérez García" />
              </div>
              <div>
                <label className="label">Teléfono</label>
                <input className="input" placeholder="55 1234 5678" />
              </div>
              <div className="md:col-span-2">
                <label className="label">Dirección</label>
                <textarea className="textarea" rows={2} placeholder="Calle, número, colonia, alcaldía…" />
              </div>
              <div className="md:col-span-2">
                <label className="label">URL Google Maps</label>
                <input className="input" placeholder="https://maps.google.com/…" />
              </div>
            </div>
          </Section>

          {/* Pedido */}
          <Section title="Detalle del Pedido" subtitle="Materiales, costo y modalidad de venta.">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="label">Número de hojas</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={totalSheets}
                  readOnly
                  style={{ background: 'var(--bg-muted)' }}
                />
                <div className="text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                  Suma automática de las hojas por color
                </div>
              </div>
              <div>
                <label className="label">Costo por hoja</label>
                <select
                  className="select"
                  value={costPerSheet}
                  onChange={(e) => setCostPerSheet(Number(e.target.value))}
                >
                  {COST_PER_SHEET_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {formatMXN(c)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Colores table */}
            <div className="mt-4">
              <label className="label">Colores</label>
              <div
                className="rounded-lg border"
                style={{ borderColor: 'var(--border)' }}
              >
                <div
                  className="grid grid-cols-12 px-4 py-2 text-xs font-semibold uppercase tracking-wide"
                  style={{
                    background: 'var(--bg-subtle)',
                    color: 'var(--text-secondary)',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <div className="col-span-3">Cantidad</div>
                  <div className="col-span-7">Color</div>
                  <div className="col-span-2 text-right">Acción</div>
                </div>
                {colors.map((row) => (
                  <div
                    key={row.id}
                    className="grid grid-cols-12 items-center gap-3 px-4 py-2 border-t"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    <div className="col-span-3">
                      <input
                        type="number"
                        min={1}
                        className="input"
                        value={row.qty}
                        onChange={(e) =>
                          updateRow(row.id, { qty: Number(e.target.value) })
                        }
                      />
                    </div>
                    <div className="col-span-7">
                      <select
                        className="select"
                        value={row.color}
                        onChange={(e) => updateRow(row.id, { color: e.target.value })}
                      >
                        {COLORS_LIST.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => removeRow(row.id)}
                        className="btn btn-danger-outline"
                        style={{ padding: '6px 10px' }}
                        aria-label="Eliminar"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                ))}
                <div
                  className="px-4 py-3 border-t"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <button
                    type="button"
                    onClick={addRow}
                    className="btn btn-outline"
                    style={{ padding: '6px 12px' }}
                  >
                    <Plus size={14} /> Agregar color
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
              <div>
                <label className="label">Cubrecanto</label>
                <input className="input" placeholder="Ej. 4 m linosa 19 mm" />
              </div>
              <div>
                <label className="label">Tipo de producto</label>
                <select className="select" defaultValue="Con Corte">
                  <option>Con Corte</option>
                  <option>Sin Corte</option>
                </select>
              </div>
              <div>
                <label className="label">Tipo de compra</label>
                <select className="select" defaultValue="A Domicilio">
                  <option>A Domicilio</option>
                  <option>En Fábrica</option>
                </select>
              </div>
              <div>
                <label className="label">Lugar de venta</label>
                <select className="select" defaultValue="Online">
                  <option>Online</option>
                  <option>En Fábrica</option>
                </select>
              </div>
            </div>
          </Section>
        </div>

        {/* Resumen sticky */}
        <div className="xl:sticky xl:top-24 self-start">
          <div className="card p-6">
            <h3 className="font-semibold mb-4">Resumen del pedido</h3>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>Hojas totales</span>
                <span className="font-semibold">{totalSheets}</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>Costo por hoja</span>
                <span className="font-semibold">{formatMXN(costPerSheet)}</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>Colores</span>
                <span className="font-semibold">{colors.length}</span>
              </div>
              <div
                className="border-t pt-3 mt-2"
                style={{ borderColor: 'var(--border)' }}
              >
                <div
                  className="text-xs uppercase tracking-wide"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Total a cobrar
                </div>
                <div
                  className="text-3xl font-bold mt-1"
                  style={{ color: 'var(--brand-primary)' }}
                >
                  {formatMXN(total)}
                </div>
              </div>
            </div>

            <div className="flex gap-2 mt-6">
              <Link href="/leads" className="btn btn-outline flex-1">
                Cancelar
              </Link>
              <button className="btn btn-primary flex-1">Guardar Lead</button>
            </div>

            <div
              className="mt-4 p-3 rounded-lg text-xs flex items-start gap-2"
              style={{ background: '#FEF3C7', color: '#92400E' }}
            >
              <span style={{ fontWeight: 700 }}>⚠</span>
              <span>
                Demo: este formulario es solo visual y no guarda datos reales.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card p-6">
      <div className="mb-5">
        <h3 className="font-semibold">{title}</h3>
        {subtitle && (
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {subtitle}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}
