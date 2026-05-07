'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useTransition } from 'react';
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ArrowLeftRight,
  Lock,
  Settings2,
  ChevronLeft,
  ChevronRight,
  Loader,
} from 'lucide-react';
import {
  MOVEMENT_TYPE_VALUES,
  MOVEMENT_TYPE_LABEL,
  type MovementType,
} from '../schema';

export type MovementsRow = {
  id: string;
  movement_type: MovementType;
  movement_type_label: string;
  quantity: number;
  reference: string | null;
  unit_cost: number | null;
  color_name: string;
  created_at: string | null;
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

export function MovementsClient({
  movements,
  total,
  page,
  pageSize,
  totalPages,
  colors,
  filters,
}: {
  movements: MovementsRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  colors: ColorOption[];
  filters: { type: MovementType | ''; color: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  function pushFilters(
    next: Partial<{ type: string; color: string; page: number }>,
  ) {
    const merged = {
      type: next.type ?? filters.type,
      color: next.color ?? filters.color,
      page: next.page ?? page,
    };
    const params = new URLSearchParams();
    if (merged.type) params.set('type', merged.type);
    if (merged.color) params.set('color', merged.color);
    if (merged.page > 1) params.set('page', String(merged.page));
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  const hasFilters = Boolean(filters.type || filters.color);
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Link
          href="/warehouse"
          className="btn btn-ghost"
          style={{ padding: '8px' }}
          aria-label="Regresar"
        >
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Movimientos</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Bitácora completa de entradas, salidas, compromisos y ajustes.
          </p>
        </div>
      </div>

      {/* Filtros */}
      <div className="card p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <select
            className="select"
            value={filters.type}
            onChange={(e) => pushFilters({ type: e.target.value, page: 1 })}
            aria-label="Filtrar por tipo"
          >
            <option value="">Todos los tipos</option>
            {MOVEMENT_TYPE_VALUES.map((t) => (
              <option key={t} value={t}>
                {MOVEMENT_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <select
            className="select"
            value={filters.color}
            onChange={(e) => pushFilters({ color: e.target.value, page: 1 })}
            aria-label="Filtrar por color"
          >
            <option value="">Todos los colores</option>
            {colors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {hasFilters && (
            <button
              type="button"
              onClick={() => pushFilters({ type: '', color: '', page: 1 })}
              className="btn btn-ghost"
              style={{ fontSize: '0.875rem' }}
            >
              Limpiar filtros
            </button>
          )}
        </div>
        {pending && (
          <div
            className="mt-3 text-xs flex items-center gap-1"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <Loader size={12} className="animate-spin" /> Actualizando…
          </div>
        )}
      </div>

      {/* Tabla */}
      <div
        className="tbl-wrap"
        style={{
          opacity: pending ? 0.6 : 1,
          transition: 'opacity 150ms ease',
        }}
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Material</th>
                <th className="text-center">Cantidad</th>
                <th className="text-right">Costo unit.</th>
                <th>Referencia</th>
                <th>Usuario</th>
              </tr>
            </thead>
            <tbody>
              {movements.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {hasFilters
                      ? 'Ningún movimiento coincide con los filtros.'
                      : 'Sin movimientos registrados.'}
                  </td>
                </tr>
              ) : (
                movements.map((m) => (
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
                    <td
                      className="text-right text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {m.unit_cost != null
                        ? new Intl.NumberFormat('es-MX', {
                            style: 'currency',
                            currency: 'MXN',
                            minimumFractionDigits: 0,
                          }).format(m.unit_cost)
                        : '—'}
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

        {total > 0 && (
          <div
            className="flex items-center justify-between px-6 py-3 border-t"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--bg-subtle)',
            }}
          >
            <div
              className="text-xs"
              style={{ color: 'var(--text-secondary)' }}
            >
              Mostrando <strong>{start}-{end}</strong> de{' '}
              <strong>{total}</strong>{' '}
              {total === 1 ? 'movimiento' : 'movimientos'}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="btn btn-ghost"
                style={{ padding: '6px 10px' }}
                disabled={page <= 1 || pending}
                onClick={() => pushFilters({ page: page - 1 })}
                aria-label="Página anterior"
              >
                <ChevronLeft size={14} />
              </button>
              <span
                className="text-xs px-2"
                style={{ color: 'var(--text-secondary)' }}
              >
                Página {page} de {totalPages}
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ padding: '6px 10px' }}
                disabled={page >= totalPages || pending}
                onClick={() => pushFilters({ page: page + 1 })}
                aria-label="Página siguiente"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
