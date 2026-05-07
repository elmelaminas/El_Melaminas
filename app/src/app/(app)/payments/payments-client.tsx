'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  Loader,
  Search,
} from 'lucide-react';
import { MethodBadge, TypeBadge } from '@/components/ui/Badges';
import {
  formatMXN,
  type PaymentMethod,
  type PaymentType,
} from '@/data/mock';

export type PaymentRow = {
  id: string;
  client_name: string;
  amount: number;
  net_amount: number;
  method: 'efectivo' | 'transferencia' | 'clip';
  payment_type: 'anticipo' | 'liquidacion';
  status: 'exitoso' | 'pendiente' | 'rechazado';
  paid_at: string | null;
  // Nota: la columna "chofer" se eliminó del listado. El chofer asignado
  // ahora vive en `leads.driver_id` (asignado al crear el lead). Para
  // mostrarlo aquí habría que JOIN payments → leads → profiles.
  deductibles: { concept: string; amount: number }[];
};

type FiltersState = {
  q: string;
  method: '' | 'efectivo' | 'transferencia' | 'clip';
  type: '' | 'anticipo' | 'liquidacion';
};

type Totals = {
  gross: number;
  deductibles: number;
  net: number;
};

const METHOD_OPTS: { value: FiltersState['method']; label: string }[] = [
  { value: '', label: 'Todos los métodos' },
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'transferencia', label: 'Transferencia' },
  { value: 'clip', label: 'Clip' },
];

const TYPE_OPTS: { value: FiltersState['type']; label: string }[] = [
  { value: '', label: 'Todos los tipos' },
  { value: 'anticipo', label: 'Anticipo' },
  { value: 'liquidacion', label: 'Liquidación' },
];

const DEBOUNCE_MS = 300;

/**
 * Mapeo entre los enums DB (lowercase del módulo) y los valores que
 * `<MethodBadge>`/`<TypeBadge>` esperan del mock (Title Case).
 * Razón: cambiar el tipo de mock rompería pages que aún usan
 * mockPayments con valores Title Case. Mapeamos al render.
 */
const METHOD_TO_BADGE: Record<PaymentRow['method'], PaymentMethod> = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  clip: 'Clip',
};
const TYPE_TO_BADGE: Record<PaymentRow['payment_type'], PaymentType> = {
  anticipo: 'Anticipo',
  liquidacion: 'Liquidación',
};

export function PaymentsClient({
  payments,
  total,
  page,
  pageSize,
  totalPages,
  filters,
  totals,
}: {
  payments: PaymentRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  filters: FiltersState;
  totals: Totals;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  const [qInput, setQInput] = useState<string>(filters.q);

  useEffect(() => {
    setQInput(filters.q);
  }, [filters.q]);

  useEffect(() => {
    if (qInput === filters.q) return;
    const t = setTimeout(() => {
      pushFilters({ q: qInput, page: 1 });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput, filters.q]);

  function pushFilters(
    next: Partial<{ q: string; method: string; type: string; page: number }>,
  ) {
    const merged = {
      q: next.q ?? filters.q,
      method: next.method ?? filters.method,
      type: next.type ?? filters.type,
      page: next.page ?? page,
    };
    const params = new URLSearchParams();
    if (merged.q) params.set('q', merged.q);
    if (merged.method) params.set('method', merged.method);
    if (merged.type) params.set('type', merged.type);
    if (merged.page > 1) params.set('page', String(merged.page));
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  const hasFilters = useMemo(
    () => Boolean(filters.q || filters.method || filters.type),
    [filters],
  );

  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

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

      {/* Totals globales */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryCard label="Cobrado bruto" value={formatMXN(totals.gross)} accent="#1E40AF" />
        <SummaryCard
          label="Deducibles"
          value={`- ${formatMXN(totals.deductibles)}`}
          accent="#B91C1C"
        />
        <SummaryCard label="Ingreso neto" value={formatMXN(totals.net)} accent="#15803D" />
      </div>

      {/* Filtros */}
      <div className="card p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="relative">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--text-tertiary)' }}
            />
            <input
              placeholder="Buscar por cliente…"
              className="input"
              style={{ paddingLeft: 36 }}
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              aria-label="Buscar pagos"
            />
          </div>
          <select
            className="select"
            value={filters.method}
            onChange={(e) => pushFilters({ method: e.target.value, page: 1 })}
            aria-label="Filtrar por método"
          >
            {METHOD_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            className="select"
            value={filters.type}
            onChange={(e) => pushFilters({ type: e.target.value, page: 1 })}
            aria-label="Filtrar por tipo"
          >
            {TYPE_OPTS.map((o) => (
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
              onClick={() => {
                setQInput('');
                pushFilters({ q: '', method: '', type: '', page: 1 });
              }}
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
                <th>Monto cobrado</th>
                <th>Deducibles</th>
                <th>Neto</th>
                <th>Método</th>
                <th>Tipo</th>
                <th>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {payments.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {hasFilters
                      ? 'Ningún pago coincide con los filtros actuales.'
                      : 'Sin pagos registrados.'}
                  </td>
                </tr>
              ) : (
                payments.map((p) => {
                  const ded = p.deductibles.reduce((a, d) => a + d.amount, 0);
                  return (
                    <tr key={p.id}>
                      <td>
                        <div className="font-medium">{p.client_name}</div>
                        <div
                          className="text-xs font-mono"
                          style={{ color: 'var(--text-tertiary)' }}
                        >
                          #{p.id.slice(0, 8)}
                        </div>
                      </td>
                      <td className="font-semibold">{formatMXN(p.amount)}</td>
                      <td>
                        {ded === 0 ? (
                          <span
                            className="text-xs"
                            style={{ color: 'var(--text-tertiary)' }}
                          >
                            —
                          </span>
                        ) : (
                          <div>
                            <div style={{ color: 'var(--danger)', fontWeight: 600 }}>
                              -{formatMXN(ded)}
                            </div>
                            <div
                              className="text-xs"
                              style={{ color: 'var(--text-tertiary)' }}
                            >
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
                      <td>
                        <MethodBadge method={METHOD_TO_BADGE[p.method]} />
                      </td>
                      <td>
                        <TypeBadge type={TYPE_TO_BADGE[p.payment_type]} />
                      </td>
                      <td
                        className="text-sm"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {formatDate(p.paid_at)}
                      </td>
                    </tr>
                  );
                })
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
              {total === 1 ? 'pago' : 'pagos'}
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
      <div
        className="text-xs uppercase tracking-wide"
        style={{ color: 'var(--text-tertiary)' }}
      >
        {label}
      </div>
      <div className="text-2xl font-bold mt-1" style={{ color: accent }}>
        {value}
      </div>
    </div>
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
