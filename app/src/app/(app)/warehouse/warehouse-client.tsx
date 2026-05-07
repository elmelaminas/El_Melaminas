'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import {
  Plus,
  Package,
  Lock,
  TriangleAlert,
  X,
  Calendar,
  ArrowDown,
  ArrowUp,
  ArrowLeftRight,
  Settings2,
  Loader,
} from 'lucide-react';
import { StockBadge } from '@/components/ui/Badges';
import { supabaseClient } from '@/lib/supabase/client';
import { registerEntryAction } from './actions';
import type { MovementType } from './schema';

export type StockRow = {
  inventory_id: string;
  color_id: string;
  color_name: string;
  is_active: boolean;
  stock_total: number;
  stock_committed: number;
  stock_available: number;
  stock_minimum: number;
};

export type MovementRow = {
  id: string;
  movement_type: MovementType;
  movement_type_label: string;
  quantity: number;
  reference: string | null;
  color_name: string;
  created_at: string | null;
  registered_by: string | null;
  registered_by_name: string;
};

export type ColorOption = {
  id: string;
  name: string;
};

const TYPE_BADGE: Record<MovementType, string> = {
  entrada: 'badge badge-success',
  salida: 'badge badge-info',
  compromiso: 'badge badge-warning',
  liberacion: 'badge badge-purple',
  ajuste: 'badge badge-neutral',
};

const TYPE_ICON: Record<MovementType, React.ReactNode> = {
  entrada: <ArrowDown size={12} />,
  salida: <ArrowUp size={12} />,
  compromiso: <Lock size={12} />,
  liberacion: <ArrowLeftRight size={12} />,
  ajuste: <Settings2 size={12} />,
};

/**
 * UI principal del almacén.
 *
 * Realtime: el `useEffect` se suscribe a `postgres_changes` en la tabla
 * `inventory`. Cualquier UPDATE/INSERT/DELETE dispara `router.refresh()`,
 * que re-corre el Server Component y trae datos frescos. Esto cubre
 * cambios desde otra pestaña (tab del mismo usuario), desde otro user
 * (otro almacenista), y desde Server Actions (commit del lead nuevo).
 *
 * Si la tabla NO tiene Realtime habilitado en Supabase Dashboard, la
 * subscription se monta sin error y nunca recibe eventos — el almacén
 * sigue funcionando, sólo que para ver cambios hay que refrescar
 * manualmente. No es un blocker.
 */
export function WarehouseClient({
  initialStock,
  initialMovements,
  activeColors,
}: {
  initialStock: StockRow[];
  initialMovements: MovementRow[];
  activeColors: ColorOption[];
}) {
  const router = useRouter();
  const [showEntry, setShowEntry] = useState(false);

  useEffect(() => {
    const supabase = supabaseClient();
    const channel = supabase
      .channel('warehouse-inventory-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'inventory' },
        () => {
          // Throttle implícito: si llegan muchos eventos en ráfaga, Next
          // colapsa los refresh sucesivos. No usamos debounce explícito
          // para no perder el último estado por silencio.
          router.refresh();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [router]);

  const totalStock = initialStock.reduce((s, r) => s + r.stock_total, 0);
  const totalCommitted = initialStock.reduce((s, r) => s + r.stock_committed, 0);
  const lowStock = initialStock.filter(
    (r) => r.stock_available <= r.stock_minimum,
  ).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Almacén</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Stock por color, alertas de mínimos y bitácora de movimientos.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/warehouse/movements"
            className="btn btn-outline"
          >
            <ArrowLeftRight size={16} /> Ver movimientos
          </Link>
          <button
            onClick={() => setShowEntry(true)}
            className="btn btn-primary"
            disabled={activeColors.length === 0}
            title={
              activeColors.length === 0
                ? 'No hay colores activos en el catálogo'
                : undefined
            }
          >
            <Plus size={16} /> Registrar Entrada
          </button>
        </div>
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
        <div
          className="px-6 py-4 border-b flex items-center justify-between"
          style={{ borderColor: 'var(--border)' }}
        >
          <h3 className="font-semibold">Stock por color</h3>
          <span
            className="text-xs"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {initialStock.length}{' '}
            {initialStock.length === 1 ? 'material' : 'materiales'}
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
              {initialStock.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Sin inventario. Crea colores desde /admin/catalogs.
                  </td>
                </tr>
              ) : (
                initialStock.map((r) => {
                  const status: 'ok' | 'warning' | 'danger' =
                    r.stock_available <= 0
                      ? 'danger'
                      : r.stock_available <= r.stock_minimum
                      ? 'warning'
                      : 'ok';
                  return (
                    <tr
                      key={r.inventory_id}
                      className={
                        status === 'danger'
                          ? 'row-danger'
                          : status === 'warning'
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
                              background: colorToHex(r.color_name),
                              border: '1px solid var(--border-strong)',
                            }}
                          />
                          {r.color_name}
                          {!r.is_active && (
                            <span
                              className="text-xs"
                              style={{
                                color: 'var(--text-tertiary)',
                                fontStyle: 'italic',
                                marginLeft: 4,
                              }}
                              title="Color desactivado en el catálogo"
                            >
                              (inactivo)
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="text-center font-semibold">{r.stock_total}</td>
                      <td className="text-center">
                        <span
                          className="font-bold"
                          style={{
                            color:
                              status === 'danger'
                                ? 'var(--danger)'
                                : status === 'warning'
                                ? 'var(--warning)'
                                : 'var(--success)',
                          }}
                        >
                          {r.stock_available}
                        </span>
                      </td>
                      <td className="text-center">{r.stock_committed}</td>
                      <td
                        className="text-center"
                        style={{ color: 'var(--text-tertiary)' }}
                      >
                        {r.stock_minimum}
                      </td>
                      <td>
                        <StockBadge status={status} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Movements (últimos N) */}
      <div className="tbl-wrap">
        <div
          className="px-6 py-4 border-b flex items-center justify-between"
          style={{ borderColor: 'var(--border)' }}
        >
          <h3 className="font-semibold">Últimos movimientos</h3>
          <Link
            href="/warehouse/movements"
            className="text-xs hover:underline"
            style={{ color: 'var(--brand-secondary)' }}
          >
            Ver todos →
          </Link>
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
              {initialMovements.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Sin movimientos registrados.
                  </td>
                </tr>
              ) : (
                initialMovements.map((m) => (
                  <tr key={m.id}>
                    <td
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {formatDateTime(m.created_at)}
                    </td>
                    <td>
                      <span
                        className={`${TYPE_BADGE[m.movement_type]} flex items-center gap-1`}
                      >
                        {TYPE_ICON[m.movement_type]} {m.movement_type_label}
                      </span>
                    </td>
                    <td>{m.color_name}</td>
                    <td
                      className="text-center font-semibold"
                      style={{
                        color:
                          m.movement_type === 'entrada'
                            ? 'var(--success)'
                            : m.movement_type === 'salida'
                            ? 'var(--danger)'
                            : undefined,
                      }}
                    >
                      {m.movement_type === 'entrada' ? '+' : ''}
                      {m.movement_type === 'salida' ? '-' : ''}
                      {Math.abs(m.quantity)}
                    </td>
                    <td className="text-sm">{m.reference ?? '—'}</td>
                    <td
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {m.registered_by_name}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showEntry && (
        <EntryDrawer
          colors={activeColors}
          onClose={() => setShowEntry(false)}
        />
      )}
    </div>
  );
}

function EntryDrawer({
  colors,
  onClose,
}: {
  colors: ColorOption[];
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [colorId, setColorId] = useState<string>(colors[0]?.id ?? '');
  const [quantity, setQuantity] = useState<number>(1);
  const [reference, setReference] = useState<string>('');
  const [unitCost, setUnitCost] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!colorId) {
      setError('Selecciona un material.');
      return;
    }
    if (!Number.isFinite(quantity) || quantity < 1) {
      setError('La cantidad debe ser ≥ 1.');
      return;
    }

    const fd = new FormData();
    fd.set('color_id', colorId);
    fd.set('quantity', String(quantity));
    fd.set('reference', reference);
    if (unitCost.trim().length > 0) fd.set('unit_cost', unitCost);

    startTransition(async () => {
      try {
        const result = await registerEntryAction({ status: 'idle' }, fd);
        if (result.status === 'success') {
          onClose();
          return;
        }
        if (result.status === 'error') {
          let combined = result.message;
          if (result.fieldErrors) {
            const lines = Object.entries(result.fieldErrors)
              .filter(([, msgs]) => msgs && msgs[0])
              .map(([path, msgs]) => `· ${path}: ${msgs?.[0]}`);
            if (lines.length > 0) combined = `${result.message}\n${lines.join('\n')}`;
          }
          setError(combined);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error de red';
        console.error('[EntryDrawer] excepción:', err);
        setError(message);
      }
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex"
      style={{ background: 'rgba(15,23,42,0.45)' }}
    >
      <div
        className="flex-1"
        onClick={() => {
          if (!pending) onClose();
        }}
      />
      <form
        onSubmit={handleSubmit}
        noValidate
        className="bg-white h-full overflow-y-auto p-6 animate-fade flex flex-col"
        style={{
          width: 'min(440px, 100%)',
          boxShadow: '-8px 0 24px rgba(0,0,0,0.12)',
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-lg">Registrar entrada</h3>
            <p
              className="text-xs"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Ingreso de mercancía al almacén
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ padding: '6px' }}
            onClick={onClose}
            disabled={pending}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4 flex-1">
          <div>
            <label className="label">Material</label>
            <select
              className="select"
              value={colorId}
              onChange={(e) => setColorId(e.target.value)}
              disabled={pending}
            >
              {colors.length === 0 && (
                <option value="">— sin colores activos —</option>
              )}
              {colors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Cantidad de hojas</label>
            <input
              className="input"
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
              disabled={pending}
            />
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
                style={{ paddingLeft: 36, background: 'var(--bg-muted)' }}
                defaultValue={new Date().toISOString().slice(0, 10)}
                readOnly
                title="La fecha la setea el server con created_at NOW()"
              />
            </div>
            <div
              className="text-[11px] mt-1"
              style={{ color: 'var(--text-tertiary)' }}
            >
              La fecha real la registra el servidor.
            </div>
          </div>
          <div>
            <label className="label">Referencia (orden de compra, opcional)</label>
            <input
              className="input"
              placeholder="OC-2026-083"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              disabled={pending}
            />
          </div>
          <div>
            <label className="label">Costo unitario (opcional)</label>
            <input
              className="input"
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              disabled={pending}
            />
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="text-sm mt-4"
            style={{
              color: 'var(--danger, #dc2626)',
              background: 'var(--danger-bg, rgba(220,38,38,0.08))',
              border: '1px solid rgba(220,38,38,0.25)',
              padding: '8px 12px',
              borderRadius: 6,
              whiteSpace: 'pre-wrap',
            }}
          >
            {error}
          </div>
        )}

        <div className="flex gap-2 mt-6">
          <button
            type="button"
            className="btn btn-outline flex-1"
            onClick={onClose}
            disabled={pending}
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="btn btn-primary flex-1"
            disabled={pending}
            aria-busy={pending}
          >
            {pending ? (
              <>
                <Loader size={16} className="animate-spin" />
                <span style={{ marginLeft: 6 }}>Guardando…</span>
              </>
            ) : (
              'Guardar entrada'
            )}
          </button>
        </div>
      </form>
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

function colorToHex(name: string): string {
  const n = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  if (n.includes('negr')) return '#1F2937';
  if (n.includes('blanc')) return '#F8FAFC';
  if (n.includes('gris')) return '#94A3B8';
  if (n.includes('parot')) return '#A16207';
  if (n.includes('nogal')) return '#7C2D12';
  if (n.includes('wengu')) return '#3F1F0F';
  return '#CBD5E1';
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
