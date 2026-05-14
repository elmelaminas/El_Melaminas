'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  Loader,
  Pencil,
  FileText,
} from 'lucide-react';
import {
  ChannelBadge,
  DeliveryBadge,
  PaymentBadge,
} from '@/components/ui/Badges';
import {
  formatMXN,
  type Channel,
  type DeliveryStatus,
  type PaymentStatus,
} from '@/data/mock';
import {
  getLeadRowStyle,
  LeadRowLegend,
  RowColorPickerCell,
  LEAD_ROW_COLORS,
  LEAD_ROW_BORDERS,
} from '@/components/ui/lead-row-color';
import { updateLeadColorAction } from './actions';

export type LeadRow = {
  id: string;
  client_name: string;
  phone: string;
  channel: Channel;
  seller_name: string | null;
  sheets_count: number;
  total_amount: number;
  sale_date: string | null;
  created_at: string | null;
  delivery_status: DeliveryStatus;
  payment_status: PaymentStatus;
  /** Tipo de venta del enum DB (lowercase). Usado por las reglas de
   *  color: `'venta_empleado'` → fila rosa. */
  sale_type: string | null;
  /** Tipo de producto del enum DB. `'con_corte'` → fila azul. */
  product_type: string | null;
  /** Override manual de color de fila (admin lo asigna desde el
   *  selector inline). Valor del CHECK constraint en DB: 'rosa',
   *  'naranja', 'amarillo', 'azul', 'verde', 'morado', 'sin_color'.
   *  null o 'sin_color' → cae a reglas automáticas. */
  row_color: string | null;
  /** URL del PDF adjunto al lead (Grupo 3). null si no hay documento.
   *  Se muestra como ícono FileText clicable en la columna Cliente. */
  document_url: string | null;
};

/**
 * Adaptador de la Server Action al shape que pide RowColorPickerCell.
 * `updateLeadColorAction` recibe `(_prev, formData)` como cualquier
 * action de useActionState; el wrapper del picker solo manda
 * `formData`, así que aplicamos `idle` como prev y devolvemos el
 * resultado que el wrapper espera.
 */
async function colorActionAdapter(formData: FormData) {
  return updateLeadColorAction({ status: 'idle' }, formData);
}

/** Valores del tab de color. '' = sin filtro (tab "Todos"). */
export type ColorFilterValue =
  | ''
  | 'azul'
  | 'rosa'
  | 'naranja'
  | 'amarillo'
  | 'verde'
  | 'morado';

export type FiltersState = {
  q: string;
  channel: '' | 'whatsapp' | 'tiktok' | 'google' | 'tienda';
  // `en_transito` salió del UI: el valor `pendiente` cubre ambos
  // estados ("no entregado") porque ése es el drill-down típico desde
  // el dashboard. El server traduce `pendiente` a IN(pendiente,
  // en_transito) automáticamente.
  delivery: '' | 'pendiente' | 'entregado' | 'cancelado';
  payment: '' | 'pendiente' | 'parcial' | 'pagado' | 'cancelado';
  /** Mes 1-12; 0 = sin filtro de mes. Pareja inseparable con `anio`. */
  mes: number;
  /** Año 4-dígitos; 0 = sin filtro. */
  anio: number;
  /** Tab activo de color de fila ('' = "Todos"). Combina las reglas
   *  automáticas + el override manual `row_color`. */
  color_filter: ColorFilterValue;
};

const CHANNEL_OPTS: { value: FiltersState['channel']; label: string }[] = [
  { value: '', label: 'Todos los canales' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'google', label: 'Google' },
  { value: 'tienda', label: 'Tienda' },
];

const DELIVERY_OPTS: { value: FiltersState['delivery']; label: string }[] = [
  { value: '', label: 'Todas las entregas' },
  // "Pendiente" en el UI engloba pendiente + en tránsito (semántica
  // de negocio). El server hace la traducción a IN(...).
  { value: 'pendiente', label: 'Pendientes (incluye en tránsito)' },
  { value: 'entregado', label: 'Entregado' },
  { value: 'cancelado', label: 'Cancelado' },
];

const PAYMENT_OPTS: { value: FiltersState['payment']; label: string }[] = [
  { value: '', label: 'Todos los pagos' },
  { value: 'pendiente', label: 'Pendiente' },
  { value: 'parcial', label: 'Parcial' },
  { value: 'pagado', label: 'Pagado' },
  { value: 'cancelado', label: 'Cancelado' },
];

const DEBOUNCE_MS = 300;

/**
 * Mapa mes-número → label corto para el chip "Mes: ene/2026" cuando hay
 * filtro de rango activo. Los valores largos viven en
 * `dashboard/constants.ts` pero acá usamos formas cortas para que el
 * chip no rompa en mobile.
 */
const MES_SHORT: Readonly<Record<number, string>> = {
  1: 'ene',
  2: 'feb',
  3: 'mar',
  4: 'abr',
  5: 'may',
  6: 'jun',
  7: 'jul',
  8: 'ago',
  9: 'sep',
  10: 'oct',
  11: 'nov',
  12: 'dic',
};

/**
 * Cliente del listado de leads.
 *
 * Estado importante: TODO el filtro vive en la URL (`?q=…&channel=…`),
 * el Server Component lee searchParams y manda `leads` ya filtrados.
 * Este componente sólo:
 *  - mantiene `qInput` local para el campo de búsqueda (para que cada
 *    keystroke no dispare un round-trip — debounce 300ms).
 *  - construye nuevas URLs y navega con `router.push`.
 *  - usa `useTransition` para atenuar la tabla mientras llega la nueva data.
 *
 * `qInput` se sincroniza con `filters.q` cuando éste cambia (ej. el
 * usuario apretó "back" o usó un link externo) — sin esto, el input
 * pintaría stale-text después de una navegación externa.
 */
export function LeadsClient({
  leads,
  total,
  page,
  pageSize,
  totalPages,
  filters,
  contraEntregaLeadIds,
}: {
  leads: LeadRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  filters: FiltersState;
  /** lead_ids que tienen al menos un pago contra_entrega — pintan
   *  la fila naranja. Pasado como array; lo convertimos a Set para
   *  lookup O(1) por fila. */
  contraEntregaLeadIds: string[];
}) {
  const contraEntregaSet = useMemo(
    () => new Set(contraEntregaLeadIds),
    [contraEntregaLeadIds],
  );
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  const [qInput, setQInput] = useState<string>(filters.q);

  // Sync: si filters.q cambia desde fuera (back, link externo), refleja
  // en el input local. Importante hacerlo ANTES del effect de debounce
  // para que ese effect vea qInput === filters.q y no dispare un push.
  useEffect(() => {
    setQInput(filters.q);
  }, [filters.q]);

  // Debounce: 300ms después del último keystroke en `qInput`, navegamos.
  // Si filters.q ya coincide con qInput (sync de arriba acaba de correr),
  // no hacemos nada.
  useEffect(() => {
    if (qInput === filters.q) return;
    const t = setTimeout(() => {
      pushFilters({ q: qInput, page: 1 });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput, filters.q]);

  function pushFilters(
    next: Partial<{
      q: string;
      channel: string;
      delivery: string;
      payment: string;
      page: number;
      mes: number;
      anio: number;
      color_filter: string;
    }>,
  ) {
    const merged = {
      q: next.q ?? filters.q,
      channel: next.channel ?? filters.channel,
      delivery: next.delivery ?? filters.delivery,
      payment: next.payment ?? filters.payment,
      page: next.page ?? page,
      // `mes`/`anio` se preservan al navegar entre filtros — un usuario
      // que entró desde dashboard?mes=4&anio=2026 puede cambiar el
      // canal sin perder el rango de mes. Para limpiar el rango se
      // usa el botón "Limpiar filtros".
      mes: next.mes ?? filters.mes,
      anio: next.anio ?? filters.anio,
      // Tab de color: se preserva igual que el resto al cambiar otros
      // filtros. Solo el botón "Limpiar filtros" lo regresa a "Todos".
      color_filter: next.color_filter ?? filters.color_filter,
    };
    const params = new URLSearchParams();
    if (merged.q) params.set('q', merged.q);
    if (merged.channel) params.set('channel', merged.channel);
    if (merged.delivery) params.set('delivery', merged.delivery);
    if (merged.payment) params.set('payment', merged.payment);
    if (merged.mes > 0 && merged.anio > 0) {
      params.set('mes', String(merged.mes));
      params.set('anio', String(merged.anio));
    }
    if (merged.color_filter) params.set('color_filter', merged.color_filter);
    if (merged.page > 1) params.set('page', String(merged.page));
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  const hasFilters = useMemo(
    () =>
      Boolean(
        filters.q ||
          filters.channel ||
          filters.delivery ||
          filters.payment ||
          (filters.mes > 0 && filters.anio > 0) ||
          filters.color_filter,
      ),
    [filters],
  );

  // Definición de los tabs de color. Cada uno con su label, valor de
  // searchParam y color asociado para el resaltado visual del tab
  // activo.
  const COLOR_TABS: {
    value: ColorFilterValue;
    label: string;
    bg?: string;
    border?: string;
  }[] = [
    { value: '', label: 'Todos' },
    {
      value: 'azul',
      label: '🔵 Con corte',
      bg: LEAD_ROW_COLORS.azul,
      border: LEAD_ROW_BORDERS.azul,
    },
    {
      value: 'rosa',
      label: '🌸 Venta empleado',
      bg: LEAD_ROW_COLORS.rosa,
      border: LEAD_ROW_BORDERS.rosa,
    },
    {
      value: 'naranja',
      label: '🟠 Contra entrega',
      bg: LEAD_ROW_COLORS.naranja,
      border: LEAD_ROW_BORDERS.naranja,
    },
    {
      value: 'amarillo',
      label: '🟡 Pagado sin entregar',
      bg: LEAD_ROW_COLORS.amarillo,
      border: LEAD_ROW_BORDERS.amarillo,
    },
    {
      value: 'verde',
      label: '🟢 Verde',
      bg: LEAD_ROW_COLORS.verde,
      border: LEAD_ROW_BORDERS.verde,
    },
    {
      value: 'morado',
      label: '🟣 Morado',
      bg: LEAD_ROW_COLORS.morado,
      border: LEAD_ROW_BORDERS.morado,
    },
  ];

  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Leads</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {total} {total === 1 ? 'lead registrado' : 'leads registrados'} —
            gestiona pedidos, entregas y pagos.
          </p>
        </div>
        <Link href="/leads/new" className="btn btn-primary">
          <Plus size={16} /> Nuevo Lead
        </Link>
      </div>

      {/* Filtros */}
      <div className="card p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="lg:col-span-1 relative">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--text-tertiary)' }}
            />
            <input
              id="leads-search"
              placeholder="Buscar por nombre o teléfono…"
              className="input"
              style={{ paddingLeft: 36 }}
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              aria-label="Buscar leads"
            />
          </div>
          <select
            id="leads-filter-channel"
            className="select"
            value={filters.channel}
            onChange={(e) =>
              pushFilters({ channel: e.target.value, page: 1 })
            }
            aria-label="Filtrar por canal"
          >
            {CHANNEL_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            id="leads-filter-delivery"
            className="select"
            value={filters.delivery}
            onChange={(e) =>
              pushFilters({ delivery: e.target.value, page: 1 })
            }
            aria-label="Filtrar por estado de entrega"
          >
            {DELIVERY_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            id="leads-filter-payment"
            className="select"
            value={filters.payment}
            onChange={(e) =>
              pushFilters({ payment: e.target.value, page: 1 })
            }
            aria-label="Filtrar por estado de pago"
          >
            {PAYMENT_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {hasFilters && (
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            {filters.mes > 0 && filters.anio > 0 && (
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
            )}
            <button
              type="button"
              onClick={() => {
                setQInput('');
                pushFilters({
                  q: '',
                  channel: '',
                  delivery: '',
                  payment: '',
                  mes: 0,
                  anio: 0,
                  color_filter: '',
                  page: 1,
                });
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

        {/* Leyenda discreta de los códigos de color de fila. */}
        <div id="leads-legend" className="mt-3">
          <LeadRowLegend />
        </div>
      </div>

      {/* Tabs de filtro por color (debajo de la leyenda, encima de la
          tabla). Cada tab combina la regla automática del color con
          su override manual. Click → push searchParam `color_filter`. */}
      <div
        role="tablist"
        aria-label="Filtrar por color de fila"
        className="flex items-center gap-2 flex-wrap"
      >
        {COLOR_TABS.map((tab) => {
          const isActive = filters.color_filter === tab.value;
          return (
            <button
              key={tab.value || 'all'}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => pushFilters({ color_filter: tab.value, page: 1 })}
              disabled={pending}
              className="btn"
              style={{
                padding: '6px 12px',
                fontSize: '0.8125rem',
                fontWeight: 500,
                // Activo: fondo del color del tab + borde sólido del
                // mismo tono. Inactivo: fondo neutro + borde gris.
                background: isActive
                  ? tab.bg ?? 'var(--brand-primary)'
                  : 'var(--bg-subtle)',
                color: isActive ? '#1F2937' : 'var(--text-secondary)',
                border: isActive
                  ? `2px solid ${tab.border ?? 'var(--brand-primary)'}`
                  : '2px solid transparent',
                borderRadius: 9999,
                cursor: pending ? 'not-allowed' : 'pointer',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tabla */}
      <div
        id="leads-table"
        className="tbl-wrap"
        style={{ opacity: pending ? 0.6 : 1, transition: 'opacity 150ms ease' }}
      >
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Canal</th>
                <th>Vendedor</th>
                <th className="text-center">Hojas</th>
                <th>Total</th>
                <th>Fecha</th>
                <th>Entrega</th>
                <th>Pago</th>
                <th className="text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {leads.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {hasFilters
                      ? 'Ningún lead coincide con los filtros actuales.'
                      : 'Sin leads todavía. Crea el primero con el botón "+ Nuevo Lead".'}
                  </td>
                </tr>
              ) : (
                leads.map((l) => (
                  <tr
                    key={l.id}
                    // background semitransparente + borde izquierdo
                    // sólido (acento). undefined cuando ninguna regla
                    // aplica → React deja el <tr> con estilo neutro.
                    style={getLeadRowStyle(l, contraEntregaSet)}
                  >
                    <td>
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="font-medium">{l.client_name}</div>
                        {l.document_url && (
                          <a
                            href={l.document_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded"
                            style={{
                              background: '#FEE2E2',
                              color: '#B91C1C',
                              fontSize: '0.6875rem',
                              fontWeight: 600,
                              textDecoration: 'none',
                            }}
                            title="Ver documento adjunto (PDF)"
                            aria-label={`Ver PDF adjunto de ${l.client_name}`}
                          >
                            <FileText size={11} /> PDF
                          </a>
                        )}
                      </div>
                      <div
                        className="text-xs"
                        style={{ color: 'var(--text-tertiary)' }}
                      >
                        {l.phone || '—'}
                      </div>
                    </td>
                    <td>
                      <ChannelBadge channel={l.channel} />
                    </td>
                    <td
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {l.seller_name ?? '—'}
                    </td>
                    <td className="text-center">{l.sheets_count}</td>
                    <td className="font-semibold">
                      {formatMXN(l.total_amount)}
                    </td>
                    <td
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {formatDate(l.sale_date)}
                    </td>
                    <td>
                      <DeliveryBadge status={l.delivery_status} />
                    </td>
                    <td>
                      <PaymentBadge status={l.payment_status} />
                    </td>
                    <td>
                      <div className="flex justify-end items-center gap-1">
                        <RowColorPickerCell
                          leadId={l.id}
                          value={l.row_color}
                          action={colorActionAdapter}
                        />
                        {l.document_url && (
                          <button
                            type="button"
                            onClick={() =>
                              // window.open en lugar de <a target="_blank">
                              // por petición explícita del usuario;
                              // ambos producen el mismo efecto de
                              // abrir en nueva pestaña (rel="noopener"
                              // ya es default en navegadores modernos).
                              window.open(l.document_url!, '_blank')
                            }
                            className="btn btn-ghost"
                            style={{
                              padding: '6px',
                              color: 'var(--brand-secondary)',
                            }}
                            aria-label={`Ver PDF adjunto de ${l.client_name}`}
                            title="Ver PDF adjunto"
                          >
                            <FileText size={16} />
                          </button>
                        )}
                        <Link
                          href={`/leads/${l.id}/edit`}
                          className="btn btn-ghost"
                          style={{ padding: '6px' }}
                          aria-label={`Editar lead de ${l.client_name}`}
                          title="Editar fecha y chofer (admin)"
                        >
                          <Pencil size={16} />
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Paginación */}
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
              <strong>{total}</strong> {total === 1 ? 'resultado' : 'resultados'}
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

/**
 * Formatea una fecha ISO (`YYYY-MM-DD` o ISO timestamp) a texto corto
 * en es-MX. Devuelve `—` si la fecha es null/undefined o inválida.
 */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso; // muestra raw si no parsea
  return d.toLocaleDateString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
