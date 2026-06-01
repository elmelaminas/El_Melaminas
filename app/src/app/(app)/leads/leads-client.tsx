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
  Trash2,
  FileText,
  Image as ImageIcon,
  Paperclip,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  Factory,
  X,
} from 'lucide-react';
import { isPdfUrl } from './new/schema';
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
import {
  updateLeadColorAction,
  markFabricaDeliveredAction,
  deleteLeadAction,
} from './actions';
import { formatDateCDMX } from '@/lib/format-date';

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
  /** 'domicilio' | 'fabrica'. Cuando es 'fabrica' la fila muestra un
   *  badge "🏭 En fábrica" junto al nombre y la entrega ya viene como
   *  `entregado` desde el INSERT (el cliente recoge en el acto). */
  purchase_type: string | null;
  /** Override manual de color de fila (admin lo asigna desde el
   *  selector inline). Valor del CHECK constraint en DB: 'rosa',
   *  'naranja', 'amarillo', 'azul', 'verde', 'morado', 'sin_color'.
   *  null o 'sin_color' → cae a reglas automáticas. */
  row_color: string | null;
  /** URL del documento legacy (`leads.document_url`). null si no hay
   *  documento. Se mantiene por compat con leads pre-multifile. La
   *  UI moderna usa `document_urls` (array). */
  document_url: string | null;
  /** Array de URLs de archivos adjuntos (PDFs + imágenes mezclados).
   *  Origen: `leads.document_urls` con fallback a `[document_url]`
   *  cuando solo existe el campo legacy (resuelto en page.tsx). */
  document_urls: string[];
  /** Tipos del pedido (CAMBIO 1). Un lead puede tener 1, 2 o 3
   *  simultáneamente. Cada uno se muestra como badge pequeño en la
   *  columna Cliente. */
  has_hojas: boolean;
  has_cubrecanto: boolean;
  has_catalogo: boolean;
  /** Cantidad de costos extras del lead (filtrados a description+amount
   *  no vacíos en el server). > 0 → mostrar badge "💰 +extras" junto al
   *  nombre. El total del lead YA incluye el monto de estos cargos. */
  extra_costs_count: number;
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
  /** Tipo de venta del lead. '' = todos. */
  sale_type:
    | ''
    | 'primer_contacto'
    | 'recompra'
    | 'seguimiento'
    | 'venta_empleado';
  /** UUID del vendedor, o 'sin_asignar' (= seller_id IS NULL), o '' (sin filtro). */
  seller_id: string;
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

const SALE_TYPE_OPTS: { value: FiltersState['sale_type']; label: string }[] = [
  { value: '', label: 'Todos los tipos' },
  { value: 'primer_contacto', label: 'Primer contacto' },
  { value: 'recompra', label: 'Recompra' },
  { value: 'seguimiento', label: 'Seguimiento' },
  { value: 'venta_empleado', label: 'Venta empleado' },
];


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
 *  - mantiene `qInput` local para el campo de búsqueda. Un debounce
 *    de 300ms dispara `router.push` automáticamente al dejar de
 *    escribir; el botón "Buscar" y Enter siguen disponibles como
 *    triggers explícitos que cortan la espera (útil para no esperar
 *    el debounce cuando el usuario sabe que quiere buscar YA).
 *  - construye nuevas URLs y navega con `router.push`.
 *  - usa `useTransition` para atenuar la tabla mientras llega la nueva data.
 *
 * `qInput` se sincroniza con `filters.q` cuando éste cambia desde fuera
 * (back, link externo) — sin esto, el input pintaría stale-text después
 * de una navegación externa.
 */
const SEARCH_DEBOUNCE_MS = 300;
export function LeadsClient({
  leads,
  total,
  page,
  pageSize,
  totalPages,
  filters,
  contraEntregaLeadIds,
  currentUserRole,
  sellers,
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
  /** Rol del usuario logueado. Se usa para gatear el botón "Eliminar
   *  lead" (solo admin/admin2). Vacío = no autenticado o lookup falló. */
  currentUserRole: string;
  /** Lista de vendedores activos para el dropdown del filtro. Sin
   *  esta lista el filtro queda con sólo "Todos" + "Sin vendedor". */
  sellers: { id: string; name: string }[];
}) {
  const canDeleteLead =
    currentUserRole === 'admin' || currentUserRole === 'admin2';
  const contraEntregaSet = useMemo(
    () => new Set(contraEntregaLeadIds),
    [contraEntregaLeadIds],
  );
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  const [qInput, setQInput] = useState<string>(filters.q);
  // `filtersOpen` controla la visibilidad de los selects en mobile.
  // En desktop los selects siempre se muestran (CSS md:flex ignora
  // este state). Auto-abierto si hay filtros activos para que el
  // usuario vea lo que viene aplicado al cargar la página.
  const [filtersOpen, setFiltersOpen] = useState<boolean>(
    Boolean(
      filters.channel ||
        filters.delivery ||
        filters.payment ||
        filters.sale_type ||
        filters.seller_id ||
        (filters.mes > 0 && filters.anio > 0),
    ),
  );

  // Sync: si filters.q cambia desde fuera (back, link externo), refleja
  // en el input local para no mostrar texto stale.
  useEffect(() => {
    setQInput(filters.q);
  }, [filters.q]);

  // Debounce automático: 300ms después del último keystroke, push a la
  // URL. Si `qInput` ya coincide con `filters.q` (sync de arriba) no
  // dispara — evita doble round-trip al volver a la página.
  useEffect(() => {
    if (qInput === filters.q) return;
    const t = setTimeout(() => {
      pushFilters({ q: qInput, page: 1 });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput, filters.q]);

  // Búsqueda explícita: Enter, botón "Buscar" o botón "X". Atajo que
  // cancela la espera del debounce cuando el usuario sabe ya quiere
  // buscar (mejor UX que esperar 300ms tras un Enter).
  function commitSearch(nextQ: string) {
    pushFilters({ q: nextQ, page: 1 });
  }

  function pushFilters(
    next: Partial<{
      q: string;
      channel: string;
      delivery: string;
      payment: string;
      sale_type: string;
      seller_id: string;
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
      sale_type: next.sale_type ?? filters.sale_type,
      seller_id: next.seller_id ?? filters.seller_id,
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
    if (merged.sale_type) params.set('sale_type', merged.sale_type);
    if (merged.seller_id) params.set('seller_id', merged.seller_id);
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
          filters.sale_type ||
          filters.seller_id ||
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
      label: '🟡 Pagado pero no entregado',
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

      {/* Filtros. Layout móvil: buscador siempre visible + botón
          "Filtros" que despliega los 3 selects. Desktop (≥768px): los
          selects siempre se muestran. */}
      <div className="card p-4">
        <div className="flex flex-col gap-3">
          <div className="flex gap-2 items-stretch">
            {/* Input + botón Buscar pegados como un input-group. El
                wrapper relativo soporta el ícono de lupa y la X de
                limpiar; el botón "Buscar" pertenece al mismo flex item
                para que la búsqueda quede visualmente atómica. */}
            <div className="flex items-stretch" style={{ flex: 1, minWidth: 0 }}>
              <div className="relative" style={{ flex: 1, minWidth: 0 }}>
                <Search
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--text-tertiary)' }}
                />
                <input
                  id="leads-search"
                  placeholder="Buscar por nombre o teléfono…"
                  className="input"
                  style={{
                    paddingLeft: 36,
                    paddingRight: qInput ? 36 : undefined,
                    borderTopRightRadius: 0,
                    borderBottomRightRadius: 0,
                  }}
                  value={qInput}
                  onChange={(e) => setQInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitSearch(qInput);
                    }
                  }}
                  aria-label="Buscar leads"
                />
                {qInput && (
                  <button
                    type="button"
                    className="absolute top-1/2 -translate-y-1/2"
                    style={{
                      right: 8,
                      background: 'transparent',
                      border: 'none',
                      padding: 4,
                      cursor: 'pointer',
                      color: 'var(--text-tertiary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    onClick={() => {
                      setQInput('');
                      commitSearch('');
                    }}
                    aria-label="Limpiar búsqueda"
                    title="Limpiar búsqueda"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <button
                type="button"
                className="btn"
                onClick={() => commitSearch(qInput)}
                style={{
                  flexShrink: 0,
                  padding: '0 14px',
                  gap: 6,
                  background: 'var(--brand-primary, #1B3A5C)',
                  color: '#fff',
                  borderTopLeftRadius: 0,
                  borderBottomLeftRadius: 0,
                  fontWeight: 600,
                }}
                aria-label="Buscar"
              >
                <Search size={16} />
                <span className="hidden sm:inline">Buscar</span>
              </button>
            </div>
            {/* Toggle solo visible en móvil. md:hidden lo oculta en
                desktop donde los selects siempre se ven. */}
            <button
              type="button"
              className="btn btn-outline md:hidden"
              onClick={() => setFiltersOpen((v) => !v)}
              aria-expanded={filtersOpen}
              aria-controls="leads-filters-collapsible"
              style={{ padding: '0 14px', gap: 6, flexShrink: 0 }}
            >
              <SlidersHorizontal size={16} />
              <span>Filtros</span>
              {filtersOpen ? (
                <ChevronUp size={14} />
              ) : (
                <ChevronDown size={14} />
              )}
            </button>
          </div>
          <div
            id="leads-filters-collapsible"
            className={`${filtersOpen ? 'grid' : 'hidden'} md:grid grid-cols-1 md:grid-cols-3 gap-3`}
          >
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
            <select
              id="leads-filter-sale-type"
              className="select"
              value={filters.sale_type}
              onChange={(e) =>
                pushFilters({ sale_type: e.target.value, page: 1 })
              }
              aria-label="Filtrar por tipo de venta"
            >
              {SALE_TYPE_OPTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              id="leads-filter-seller"
              className="select"
              value={filters.seller_id}
              onChange={(e) =>
                pushFilters({ seller_id: e.target.value, page: 1 })
              }
              aria-label="Filtrar por vendedor"
            >
              <option value="">Todos los vendedores</option>
              <option value="sin_asignar">Sin vendedor</option>
              {sellers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
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
                  sale_type: '',
                  seller_id: '',
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
          su override manual. Click → push searchParam `color_filter`.
          El id `color-filter-tabs` lo usa el tour contextual. */}
      <div
        id="color-filter-tabs"
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

      {/* Tabla — en móvil se transforma en cards via .table-to-cards
          (ver globals.css). Cada <td> declara data-label con el nombre
          de su columna para que se vea como pares "Label: valor". */}
      <div
        id="leads-table"
        className="tbl-wrap"
        style={{ opacity: pending ? 0.6 : 1, transition: 'opacity 150ms ease' }}
      >
        <div className="overflow-x-auto">
          <table className="tbl table-to-cards">
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
                    <td data-label="Cliente">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="font-medium">{l.client_name}</div>
                        {l.purchase_type === 'fabrica' && (
                          <span
                            className="badge"
                            style={{
                              fontSize: '0.6875rem',
                              background: '#FFEDD5',
                              color: '#7C2D12',
                            }}
                            title="Compra en fábrica — el cliente recoge"
                          >
                            🏭 En fábrica
                          </span>
                        )}
                        {l.document_urls.length > 0 && (
                          <AttachmentsBadge
                            urls={l.document_urls}
                            clientName={l.client_name}
                          />
                        )}
                      </div>
                      {(l.has_hojas || l.has_cubrecanto || l.has_catalogo) && (
                        <div className="flex items-center gap-1 flex-wrap mt-1">
                          {l.has_hojas && (
                            <span
                              className="badge"
                              style={{
                                fontSize: '0.6875rem',
                                background: '#DBEAFE',
                                color: '#1E40AF',
                              }}
                              title="Incluye hojas/materiales"
                            >
                              📋 Hojas
                            </span>
                          )}
                          {l.has_cubrecanto && (
                            <span
                              className="badge"
                              style={{
                                fontSize: '0.6875rem',
                                background: '#FEF3C7',
                                color: '#92400E',
                              }}
                              title="Incluye cubrecanto adicional"
                            >
                              📏 Cubrecanto
                            </span>
                          )}
                          {l.has_catalogo && (
                            <span
                              className="badge"
                              style={{
                                fontSize: '0.6875rem',
                                background: '#EDE9FE',
                                color: '#6D28D9',
                              }}
                              title="Incluye catálogo"
                            >
                              📚 Catálogo
                            </span>
                          )}
                          {l.extra_costs_count > 0 && (
                            <span
                              className="badge"
                              style={{
                                fontSize: '0.6875rem',
                                background: '#FEF3C7',
                                color: '#92400E',
                              }}
                              title={`${l.extra_costs_count} ${l.extra_costs_count === 1 ? 'cargo extra' : 'cargos extras'} (ya incluido en el total)`}
                            >
                              💰 +extras
                            </span>
                          )}
                        </div>
                      )}
                      <div
                        className="text-xs mt-1"
                        style={{ color: 'var(--text-tertiary)' }}
                      >
                        {l.phone || '—'}
                      </div>
                    </td>
                    <td data-label="Canal">
                      <ChannelBadge channel={l.channel} />
                    </td>
                    <td
                      data-label="Vendedor"
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {l.seller_name ?? '—'}
                    </td>
                    <td data-label="Hojas" className="text-center">
                      {l.sheets_count}
                    </td>
                    <td data-label="Total" className="font-semibold">
                      {formatMXN(l.total_amount)}
                    </td>
                    <td
                      data-label="Fecha"
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {formatDate(l.sale_date)}
                    </td>
                    <td data-label="Entrega">
                      <DeliveryBadge status={l.delivery_status} />
                    </td>
                    <td data-label="Pago">
                      <PaymentBadge status={l.payment_status} />
                    </td>
                    <td data-label="Acciones">
                      <div className="flex justify-end items-center gap-1 flex-wrap">
                        {l.purchase_type === 'fabrica' &&
                          l.delivery_status !== 'entregado' &&
                          l.delivery_status !== 'cancelado' && (
                            <FabricaDeliverButton
                              leadId={l.id}
                              clientName={l.client_name}
                            />
                          )}
                        <RowColorPickerCell
                          leadId={l.id}
                          value={l.row_color}
                          action={colorActionAdapter}
                        />
                        <Link
                          href={`/leads/${l.id}/edit`}
                          className="btn btn-ghost"
                          style={{ padding: '6px' }}
                          aria-label={`Editar lead de ${l.client_name}`}
                          title="Editar fecha y chofer (admin)"
                        >
                          <Pencil size={16} />
                        </Link>
                        {canDeleteLead && (
                          <DeleteLeadButton
                            leadId={l.id}
                            clientName={l.client_name}
                          />
                        )}
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

// Helper local renombrado al shared `formatDateCDMX` (timezone México
// + soporte de fecha-pura YYYY-MM-DD sin shifts).
const formatDate = formatDateCDMX;

/**
 * Badge "clip + N" que abre un popover con la lista de archivos
 * adjuntos al lead. Cada archivo es un link clickeable que abre en
 * nueva pestaña. PDFs e imágenes se diferencian visualmente con
 * ícono y color.
 *
 * Si solo hay 1 archivo, el badge sigue funcionando — el usuario lo
 * abre con un click, ve el popover con 1 link, lo clickea. Simple
 * y consistente.
 */
function AttachmentsBadge({
  urls,
  clientName,
}: {
  urls: string[];
  clientName: string;
}) {
  const [open, setOpen] = useState(false);
  const count = urls.length;
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded"
        style={{
          background: '#DBEAFE',
          color: '#1E40AF',
          fontSize: '0.6875rem',
          fontWeight: 600,
          border: 'none',
          cursor: 'pointer',
        }}
        aria-label={`Ver ${count} archivo${count === 1 ? '' : 's'} adjunto${count === 1 ? '' : 's'} de ${clientName}`}
        title={`${count} archivo${count === 1 ? '' : 's'} adjunto${count === 1 ? '' : 's'}`}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Paperclip size={11} />
        {count}
      </button>
      {open && (
        <>
          {/* Backdrop transparente — al clickear afuera cierra. */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
            aria-hidden="true"
          />
          <div
            role="menu"
            aria-label="Archivos adjuntos"
            className="card"
            style={{
              position: 'absolute',
              top: '110%',
              left: 0,
              zIndex: 41,
              padding: 6,
              minWidth: 220,
              maxWidth: 320,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {urls.map((u, i) => {
              const pdf = isPdfUrl(u);
              const name = u.split('/').pop() ?? `Archivo ${i + 1}`;
              const cleanName = /^\d+_\d+_[a-z0-9]+\./i.test(name)
                ? `Archivo ${i + 1}.${name.split('.').pop() ?? ''}`
                : name;
              return (
                <a
                  key={u}
                  href={u}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-2 px-2 py-1.5 rounded"
                  style={{
                    color: 'var(--text-primary)',
                    textDecoration: 'none',
                    fontSize: '0.8125rem',
                  }}
                  role="menuitem"
                >
                  {pdf ? (
                    <FileText
                      size={14}
                      style={{ color: '#B91C1C', flexShrink: 0 }}
                    />
                  ) : (
                    <ImageIcon
                      size={14}
                      style={{ color: '#1E40AF', flexShrink: 0 }}
                    />
                  )}
                  <span className="truncate">{cleanName}</span>
                </a>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Botón "🏭 Entregar" + confirmación inline para marcar una compra
 * en fábrica como entregada sin pasar por la vista del chofer.
 *
 * Estados:
 *  - default: botón verde compacto con ícono.
 *  - confirmando: dos botones "Sí" / "No" inline.
 *  - pending: spinner mientras corre la action.
 *  - error: texto rojo pequeño abajo del botón (truncado a 40 chars).
 *
 * Tras success llamamos `router.refresh()` — el server re-renderiza
 * la página con `delivery_status='entregado'`, el predicado del
 * parent oculta este botón naturalmente.
 */
function FabricaDeliverButton({
  leadId,
  clientName,
}: {
  leadId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.set('lead_id', leadId);
        const r = await markFabricaDeliveredAction({ status: 'idle' }, fd);
        if (r.status === 'error') {
          setError(r.message);
          setConfirming(false);
        } else if (r.status === 'success') {
          router.refresh();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error de red';
        setError(message);
        setConfirming(false);
      }
    });
  }

  if (confirming) {
    return (
      <div
        role="dialog"
        aria-label={`Confirmar entrega en fábrica de ${clientName}`}
        className="flex items-center gap-1"
        style={{
          background: '#ECFDF5',
          border: '1px solid #6EE7B7',
          padding: '2px 6px',
          borderRadius: 6,
        }}
      >
        <span
          className="text-[11px]"
          style={{ color: '#065F46', fontWeight: 500 }}
        >
          ¿Marcar como entregado en fábrica?
        </span>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={pending}
          aria-busy={pending}
          className="btn"
          style={{
            padding: '2px 8px',
            fontSize: '0.6875rem',
            fontWeight: 600,
            background: '#16A34A',
            color: '#fff',
          }}
        >
          {pending ? (
            <Loader size={11} className="animate-spin" />
          ) : (
            'Sí'
          )}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={pending}
          className="btn btn-ghost"
          style={{ padding: '2px 8px', fontSize: '0.6875rem' }}
        >
          No
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={pending}
        className="btn"
        style={{
          padding: '4px 10px',
          fontSize: '0.75rem',
          fontWeight: 600,
          background: '#16A34A',
          color: '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
        aria-label={`Marcar entregado en fábrica para ${clientName}`}
        title="Marcar como entregado en fábrica"
      >
        <Factory size={12} /> Entregar
      </button>
      {error && (
        <div
          role="alert"
          className="text-[10px]"
          style={{ color: 'var(--danger, #dc2626)', maxWidth: 180 }}
          title={error}
        >
          {error.length > 40 ? `${error.slice(0, 40)}…` : error}
        </div>
      )}
    </div>
  );
}

/**
 * Botón "🗑️ Eliminar lead" con confirmación inline. Solo se renderiza
 * cuando el caller verificó que `currentUserRole ∈ {admin, admin2}` —
 * la action ACÁ revalida igual para defensa en profundidad.
 *
 * Mismo patrón de UX que `FabricaDeliverButton`: ícono rojo → al click
 * pasa a estado `confirming` con pregunta + botones [Sí, eliminar] /
 * [Cancelar]. Tras success `router.refresh()` y la fila desaparece
 * (el listado filtra `deleted_at IS NULL`).
 */
function DeleteLeadButton({
  leadId,
  clientName,
}: {
  leadId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      try {
        const r = await deleteLeadAction(leadId);
        if (r.status === 'error') {
          setError(r.message);
          setConfirming(false);
        } else if (r.status === 'success') {
          router.refresh();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error de red';
        setError(message);
        setConfirming(false);
      }
    });
  }

  if (confirming) {
    return (
      <div
        role="dialog"
        aria-label={`Confirmar eliminación de ${clientName}`}
        className="flex items-center gap-1"
        style={{
          background: '#FEF2F2',
          border: '1px solid #FECACA',
          padding: '2px 6px',
          borderRadius: 6,
        }}
      >
        <span
          className="text-[11px]"
          style={{ color: '#991B1B', fontWeight: 500 }}
        >
          ¿Eliminar lead de {clientName}?
        </span>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={pending}
          aria-busy={pending}
          className="btn"
          style={{
            padding: '2px 8px',
            fontSize: '0.6875rem',
            fontWeight: 600,
            background: '#DC2626',
            color: '#fff',
          }}
        >
          {pending ? (
            <Loader size={11} className="animate-spin" />
          ) : (
            'Sí, eliminar'
          )}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={pending}
          className="btn btn-ghost"
          style={{ padding: '2px 8px', fontSize: '0.6875rem' }}
        >
          Cancelar
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={pending}
        className="btn btn-ghost"
        style={{ padding: '6px', color: '#DC2626' }}
        aria-label={`Eliminar lead de ${clientName}`}
        title="Eliminar lead (admin)"
      >
        <Trash2 size={16} />
      </button>
      {error && (
        <div
          role="alert"
          className="text-[10px]"
          style={{ color: 'var(--danger, #dc2626)', maxWidth: 180 }}
          title={error}
        >
          {error.length > 40 ? `${error.slice(0, 40)}…` : error}
        </div>
      )}
    </div>
  );
}
