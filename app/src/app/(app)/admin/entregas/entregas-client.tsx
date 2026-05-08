'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useMemo, useTransition } from 'react';
import { Loader, MapPin } from 'lucide-react';
import {
  DeliveryBadge,
  PaymentBadge,
} from '@/components/ui/Badges';
import {
  formatMXN,
  type DeliveryStatus,
  type PaymentStatus,
} from '@/data/mock';

export type EntregaRow = {
  id: string;
  client_name: string;
  address: string;
  maps_url: string;
  total_amount: number;
  /** Calculado en page.tsx: max(0, total - sum(payments exitosos)). */
  adeudo: number;
  delivery_status: DeliveryStatus;
  payment_status: PaymentStatus;
  sale_date: string | null;
  created_at: string | null;
  driver_id: string | null;
  driver_name: string | null;
  colors: { color_name: string; quantity: number }[];
};

export type DriverOption = { id: string; name: string };

type FiltersState = {
  driver: string;
  status: '' | 'pendiente' | 'entregado' | 'cancelado';
};

const STATUS_OPTS: { value: FiltersState['status']; label: string }[] = [
  { value: '', label: 'Todos los estados' },
  { value: 'pendiente', label: 'Pendientes (incluye en tránsito)' },
  { value: 'entregado', label: 'Entregadas' },
  { value: 'cancelado', label: 'Canceladas' },
];

/**
 * Cliente del listado de entregas.
 *
 * Filtros 100% URL-driven (bookmarkables). El Server Component lee los
 * searchParams y este cliente solo dispara `router.push` con los nuevos.
 * `useTransition` atenúa la tabla durante el re-fetch para señalar
 * actividad sin layout shift.
 */
export function EntregasClient({
  rows,
  drivers,
  filters,
}: {
  rows: EntregaRow[];
  drivers: DriverOption[];
  filters: FiltersState;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  function pushFilters(next: Partial<FiltersState>) {
    const merged = {
      driver: next.driver ?? filters.driver,
      status: next.status ?? filters.status,
    };
    const params = new URLSearchParams();
    if (merged.driver) params.set('driver', merged.driver);
    if (merged.status) params.set('status', merged.status);
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  const hasFilters = useMemo(
    () => Boolean(filters.driver || filters.status),
    [filters],
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Entregas</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Todas las entregas con su chofer asignado y estado actual.
        </p>
      </div>

      {/* Filtros */}
      <div className="card p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <select
            className="select"
            value={filters.driver}
            onChange={(e) => pushFilters({ driver: e.target.value })}
            aria-label="Filtrar por chofer"
          >
            <option value="">Todos los choferes</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select
            className="select"
            value={filters.status}
            onChange={(e) =>
              pushFilters({
                status: e.target.value as FiltersState['status'],
              })
            }
            aria-label="Filtrar por estado de entrega"
          >
            {STATUS_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {hasFilters && (
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => pushFilters({ driver: '', status: '' })}
              className="btn btn-ghost"
              style={{ padding: '4px 10px', fontSize: '0.75rem' }}
            >
              Limpiar filtros
            </button>
            {pending && (
              <span
                className="text-xs flex items-center gap-1"
                style={{ color: 'var(--text-tertiary)' }}
              >
                <Loader size={12} className="animate-spin" /> Actualizando…
              </span>
            )}
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
                <th>Cliente</th>
                <th>Chofer</th>
                <th>Materiales</th>
                <th>Dirección</th>
                <th className="text-right">Total</th>
                <th className="text-right">Adeudo</th>
                <th>Entrega</th>
                <th>Pago</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {hasFilters
                      ? 'Ninguna entrega coincide con los filtros actuales.'
                      : 'Sin entregas registradas.'}
                  </td>
                </tr>
              ) : (
                rows.map((r) => <Row key={r.id} entrega={r} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Row({ entrega: r }: { entrega: EntregaRow }) {
  const colorsLabel =
    r.colors.length === 0
      ? '—'
      : r.colors.map((c) => `${c.quantity}× ${c.color_name}`).join(', ');

  return (
    <tr>
      <td>
        <div className="font-medium">{r.client_name}</div>
        <div
          className="text-xs font-mono"
          style={{ color: 'var(--text-tertiary)' }}
        >
          #{r.id.slice(0, 8)}
        </div>
      </td>
      <td>
        {r.driver_name ? (
          <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {r.driver_name}
          </span>
        ) : (
          <span
            className="text-sm"
            style={{
              color: '#B91C1C',
              background: '#FEE2E2',
              padding: '2px 8px',
              borderRadius: 4,
              fontWeight: 500,
            }}
          >
            Sin asignar
          </span>
        )}
      </td>
      <td className="text-sm" style={{ color: 'var(--text-secondary)', maxWidth: 220 }}>
        <div className="truncate" title={colorsLabel}>
          {colorsLabel}
        </div>
      </td>
      <td className="text-sm" style={{ color: 'var(--text-secondary)', maxWidth: 240 }}>
        <div className="truncate" title={r.address}>
          {r.address || '—'}
        </div>
        {r.maps_url && (
          <a
            href={r.maps_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs inline-flex items-center gap-1 mt-1 hover:underline"
            style={{ color: 'var(--brand-secondary)' }}
          >
            <MapPin size={11} /> Ver en mapa
          </a>
        )}
      </td>
      <td className="text-right font-semibold">{formatMXN(r.total_amount)}</td>
      <td
        className="text-right font-bold"
        style={{
          color: r.adeudo > 0 ? 'var(--danger)' : 'var(--success)',
        }}
      >
        {formatMXN(r.adeudo)}
      </td>
      <td>
        <DeliveryBadge status={r.delivery_status} />
      </td>
      <td>
        <PaymentBadge status={r.payment_status} />
      </td>
      <td className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {formatDate(r.sale_date)}
      </td>
    </tr>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
