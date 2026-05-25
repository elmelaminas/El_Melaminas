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
import { formatDateTimeCDMX } from '@/lib/format-date';

export type MovementsRow = {
  id: string;
  movement_type: MovementType;
  movement_type_label: string;
  quantity: number;
  reference: string | null;
  unit_cost: number | null;
  color_name: string;
  /** Nombre del cliente del lead asociado (vía lead_id). null si el
   *  movimiento no tiene lead_id (entrada manual de stock o ajuste). */
  client_name: string | null;
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

/** Mes corto para el chip — mismo patrón que /leads y /payments. */
const MES_SHORT: Readonly<Record<number, string>> = {
  1: 'ene', 2: 'feb', 3: 'mar', 4: 'abr', 5: 'may', 6: 'jun',
  7: 'jul', 8: 'ago', 9: 'sep', 10: 'oct', 11: 'nov', 12: 'dic',
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
  filters: {
    type: MovementType | '';
    color: string;
    /** Mes 1-12; 0 = sin filtro. Pareja inseparable con `anio`. */
    mes: number;
    /** Año 4-dígitos; 0 = sin filtro. */
    anio: number;
  };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  function pushFilters(
    next: Partial<{
      type: string;
      color: string;
      page: number;
      mes: number;
      anio: number;
    }>,
  ) {
    const merged = {
      type: next.type ?? filters.type,
      color: next.color ?? filters.color,
      page: next.page ?? page,
      // mes/anio se preservan al cambiar otros filtros (mismo patrón
      // que /leads y /payments). Solo "Limpiar filtros" los resetea.
      mes: next.mes ?? filters.mes,
      anio: next.anio ?? filters.anio,
    };
    const params = new URLSearchParams();
    if (merged.type) params.set('type', merged.type);
    if (merged.color) params.set('color', merged.color);
    if (merged.mes > 0 && merged.anio > 0) {
      params.set('mes', String(merged.mes));
      params.set('anio', String(merged.anio));
    }
    if (merged.page > 1) params.set('page', String(merged.page));
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  const hasFilters = Boolean(
    filters.type ||
      filters.color ||
      (filters.mes > 0 && filters.anio > 0),
  );
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
              onClick={() =>
                pushFilters({
                  type: '',
                  color: '',
                  mes: 0,
                  anio: 0,
                  page: 1,
                })
              }
              className="btn btn-ghost"
              style={{ fontSize: '0.875rem' }}
            >
              Limpiar filtros
            </button>
          )}
        </div>
        {filters.mes > 0 && filters.anio > 0 && (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span
              className="text-xs"
              style={{
                background: 'var(--bg-muted)',
                color: 'var(--text-secondary)',
                padding: '4px 10px',
                borderRadius: 9999,
                fontWeight: 500,
              }}
            >
              Mes: {MES_SHORT[filters.mes] ?? filters.mes}/{filters.anio}
            </span>
          </div>
        )}
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
                <th>Cliente</th>
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
                    colSpan={8}
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
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {m.client_name ?? '—'}
                    </td>
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

const formatDateTime = formatDateTimeCDMX;
