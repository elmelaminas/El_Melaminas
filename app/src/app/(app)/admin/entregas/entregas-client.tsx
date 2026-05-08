'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import {
  Loader,
  MapPin,
  Pencil,
  TriangleAlert,
  X,
  CircleCheckBig,
} from 'lucide-react';
import {
  DeliveryBadge,
  PaymentBadge,
} from '@/components/ui/Badges';
import {
  formatMXN,
  type DeliveryStatus,
  type PaymentStatus,
} from '@/data/mock';
import { resolveIssueAction } from './actions';

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

/**
 * Issue (faltante o detalle) reportado por un chofer en una entrega.
 * Solo se cargan los `resolved=false` para mostrar el badge en la
 * tabla; los resueltos no afectan al admin a primer vistazo.
 */
export type IssueRow = {
  id: string;
  issue_type: 'faltante' | 'detalle';
  description: string;
  photo_url: string | null;
  resolved: boolean;
  created_at: string | null;
};

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
  issuesByLead,
}: {
  rows: EntregaRow[];
  drivers: DriverOption[];
  filters: FiltersState;
  /** Issues no resueltos por lead_id. Si un lead no tiene entrada o el
   *  array está vacío, no aparece el badge en su fila. */
  issuesByLead: Record<string, IssueRow[]>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  // Lead actualmente abierto en el modal de issues. null = modal cerrado.
  const [openIssuesLead, setOpenIssuesLead] = useState<EntregaRow | null>(null);

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

      {/* Modal de issues — montado fuera de la tabla para overlay
          fullscreen sin restricciones de overflow del tbl-wrap. */}
      {openIssuesLead && (
        <IssuesModal
          entrega={openIssuesLead}
          issues={issuesByLead[openIssuesLead.id] ?? []}
          onClose={() => setOpenIssuesLead(null)}
        />
      )}

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
                <th className="text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={10}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {hasFilters
                      ? 'Ninguna entrega coincide con los filtros actuales.'
                      : 'Sin entregas registradas.'}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <Row
                    key={r.id}
                    entrega={r}
                    issues={issuesByLead[r.id] ?? []}
                    onOpenIssues={() => setOpenIssuesLead(r)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Row({
  entrega: r,
  issues,
  onOpenIssues,
}: {
  entrega: EntregaRow;
  issues: IssueRow[];
  onOpenIssues: () => void;
}) {
  const colorsLabel =
    r.colors.length === 0
      ? '—'
      : r.colors.map((c) => `${c.quantity}× ${c.color_name}`).join(', ');
  const issueCount = issues.length;

  return (
    <tr>
      <td>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="font-medium">{r.client_name}</div>
          {issueCount > 0 && (
            <button
              type="button"
              onClick={onOpenIssues}
              className="badge badge-danger flex items-center gap-1"
              style={{
                cursor: 'pointer',
                border: 'none',
                fontSize: '0.6875rem',
              }}
              title={`Ver ${issueCount} ${issueCount === 1 ? 'reporte' : 'reportes'} sin resolver`}
            >
              <TriangleAlert size={11} />{' '}
              {issueCount}{' '}
              {issueCount === 1 ? 'reporte' : 'reportes'}
            </button>
          )}
        </div>
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
      <td>
        <div className="flex justify-end">
          <Link
            href={`/leads/${r.id}/edit`}
            className="btn btn-ghost"
            style={{ padding: '6px' }}
            aria-label={`Editar entrega de ${r.client_name}`}
            title="Editar fecha y chofer"
          >
            <Pencil size={16} />
          </Link>
        </div>
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

/**
 * Modal con la lista de issues (sin resolver) de un lead. El admin
 * puede marcar cada uno como resuelto con un botón. La acción usa
 * `resolveIssueAction` que actualiza la DB y `router.refresh()`
 * recarga la página para reflejar el cambio.
 *
 * Cada issue tiene su propio state pending/error porque el admin
 * podría querer marcar uno mientras lee otro.
 */
function IssuesModal({
  entrega,
  issues,
  onClose,
}: {
  entrega: EntregaRow;
  issues: IssueRow[];
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.45)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="issues-modal-title"
    >
      <div
        className="card w-full max-w-2xl p-6 animate-fade max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3
              id="issues-modal-title"
              className="font-semibold text-lg flex items-center gap-2"
              style={{ color: '#92400E' }}
            >
              <TriangleAlert size={18} /> Reportes de la entrega
            </h3>
            <p
              className="text-sm mt-1"
              style={{ color: 'var(--text-secondary)' }}
            >
              {entrega.client_name} ·{' '}
              <span style={{ color: 'var(--text-tertiary)' }}>
                #{entrega.id.slice(0, 8)}
              </span>
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ padding: '6px' }}
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        {issues.length === 0 ? (
          <div
            className="text-sm text-center py-6"
            style={{ color: 'var(--text-tertiary)' }}
          >
            No hay reportes sin resolver.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {issues.map((i) => (
              <IssueCard key={i.id} issue={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function IssueCard({ issue }: { issue: IssueRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function handleResolve() {
    setError(null);
    const fd = new FormData();
    fd.set('issue_id', issue.id);

    startTransition(async () => {
      try {
        const r = await resolveIssueAction({ status: 'idle' }, fd);
        if (r.status === 'success') {
          setDone(true);
          router.refresh();
        } else if (r.status === 'error') {
          setError(r.message);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error de red';
        setError(message);
      }
    });
  }

  const typeLabel =
    issue.issue_type === 'faltante' ? 'Faltante' : 'Detalle';
  const typeBadge =
    issue.issue_type === 'faltante' ? 'badge-danger' : 'badge-warning';

  return (
    <div
      className="card p-4"
      style={{
        background: 'var(--bg-subtle)',
        border: '1px solid var(--border)',
        opacity: done ? 0.4 : 1,
        transition: 'opacity 200ms ease',
      }}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`badge ${typeBadge}`}>{typeLabel}</span>
          <span
            className="text-xs"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {formatDateTime(issue.created_at)}
          </span>
        </div>
      </div>
      <p
        className="text-sm"
        style={{
          color: 'var(--text-primary)',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.5,
        }}
      >
        {issue.description}
      </p>
      {issue.photo_url && (
        <a
          href={issue.photo_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs hover:underline inline-flex items-center gap-1 mt-2"
          style={{ color: 'var(--brand-secondary)' }}
        >
          📷 Ver foto del reporte
        </a>
      )}

      {error && (
        <div
          role="alert"
          className="text-xs mt-2"
          style={{ color: 'var(--danger)' }}
        >
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={handleResolve}
        className="btn btn-primary w-full mt-3"
        disabled={pending || done}
        aria-busy={pending}
      >
        {pending ? (
          <>
            <Loader size={14} className="animate-spin" />
            <span style={{ marginLeft: 6 }}>Resolviendo…</span>
          </>
        ) : done ? (
          <>
            <CircleCheckBig size={14} /> Resuelto
          </>
        ) : (
          <>
            <CircleCheckBig size={14} /> Marcar como resuelto
          </>
        )}
      </button>
    </div>
  );
}
