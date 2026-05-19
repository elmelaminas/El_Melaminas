'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  Loader,
  MapPin,
  Pencil,
  TriangleAlert,
  X,
  CircleCheckBig,
  Route,
  Calendar,
  Camera,
  Undo2,
  PackageCheck,
  RefreshCcw,
  Ban,
  Factory,
  FileText,
  Image as ImageIcon,
  Phone,
  Truck,
  Wallet,
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
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import {
  getLeadRowStyle,
  LeadRowLegend,
  RowColorPickerCell,
} from '@/components/ui/lead-row-color';
import {
  updateLeadColorAction,
  markFabricaDeliveredAction,
} from '../../leads/actions';
import {
  resolveIssueAction,
  assignDeliveryRouteAction,
  returnStockAction,
  reassignDeliveryAction,
  cancelLeadAction,
} from './actions';

/**
 * Estilo de fila ROJO ALERTA. Sobre-escribe cualquier color manual o
 * automático cuando hay entrega fallida con stock pendiente de
 * devolver. Es una alarma operativa: el admin debe actuar.
 */
const STOCK_RETURN_PENDING_STYLE = {
  background: 'rgba(255, 0, 0, 0.20)',
  borderLeft: '4px solid #DC2626',
} as const;

/** Adaptador de la Server Action al shape (formData) → result que pide
 *  RowColorPickerCell. */
async function colorActionAdapter(formData: FormData) {
  return updateLeadColorAction({ status: 'idle' }, formData);
}

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
  /** Tipo de venta — feed para regla de color de fila ('venta_empleado'
   *  → rosa). */
  sale_type: string | null;
  /** Tipo de producto — feed para regla de color ('con_corte' → azul). */
  product_type: string | null;
  /** 'domicilio' | 'fabrica'. Cuando es 'fabrica' la columna de chofer
   *  muestra "Recoge en fábrica" en lugar de "Sin asignar", y la fila
   *  no aparece en la sección "Ruta del día" (el cliente recoge). */
  purchase_type: string | null;
  /** Override manual de color de fila (admin lo asigna desde el
   *  selector inline en la columna Acciones). null o 'sin_color'
   *  significan "sin override" → cae a reglas automáticas. */
  row_color: string | null;
  /** Si el chofer reportó "No pude entregar" en un intento previo,
   *  estos campos llevan motivo + URL de la foto del lugar. La fila
   *  muestra un badge naranja "No entregado" y abre un modal con
   *  el detalle al hacer click. */
  failed_delivery_reason: string | null;
  failed_delivery_photo_url: string | null;
  /** El material físicamente regresó al almacén tras la falla. Cuando
   *  `failed_delivery_reason` está y esto es false, la fila se pinta
   *  ROJA (alerta operativa) y aparece el botón "Devolver al stock". */
  stock_returned: boolean;
  colors: { color_name: string; quantity: number; cost_per_sheet: number }[];
  /** Colores del cubrecanto (informativos para el chofer). Vacío
   *  cuando el lead no incluye cubrecanto o todavía no tiene colores
   *  registrados. */
  edgebanding_colors: { color_name: string; quantity: number }[];
};

export type DriverOption = { id: string; name: string };

/**
 * Pago individual asociado a un lead, mostrado en el modal de detalle.
 * Es un subset de `payments` con los campos que el admin quiere ver
 * de un vistazo. `paid_at` cae a `created_at` cuando no hay
 * confirmación explícita (pago `pendiente`).
 */
export type LeadPayment = {
  id: string;
  amount: number;
  method: string;
  payment_type: string;
  status: string;
  paid_at: string | null;
};

/**
 * Datos extendidos del lead que NO viven en `EntregaRow` (campos que
 * sólo se ven al abrir el modal de detalle). El page los pasa
 * pre-resueltos como `Record<lead_id, LeadDetail>` para evitar un
 * round-trip al abrir el modal.
 */
export type LeadDetail = {
  phone: string;
  channel: string;
  seller_name: string | null;
  has_hojas: boolean;
  has_cubrecanto: boolean;
  has_catalogo: boolean;
  cuts_count: number | null;
  cuts_total: number | null;
  edge_banding_type: string | null;
  edge_banding_meters: number | null;
  edge_banding_total: number | null;
  edgebanding_manual_cost: number | null;
  catalog_price: number | null;
  delivery_cost: number | null;
  document_urls: string[];
  /** Colores con unit_cost real (lectura desde lead_colors.unit_cost
   *  con fallback a cost_per_sheet). El array que vive dentro de
   *  EntregaRow se queda con cost_per_sheet por compat con el resto
   *  de la tabla; aquí guardamos la versión "para el modal". */
  colors_with_unit: {
    color_name: string;
    quantity: number;
    unit_cost: number;
  }[];
  payments: LeadPayment[];
};

/**
 * Evidencia de cobro hecho por el chofer (Grupo 4). Una entrada por
 * lead — si hubo múltiples driver_deliveries (re-entrega, etc.) la
 * página servirá la más reciente.
 */
export type DeliveryEvidence = {
  url: string;
  amount: number;
  delivered_at: string | null;
};

/**
 * Candidato a entrar en la ruta del día. Llega con `delivery_order`
 * SOLO si `assigned_to_this_date=true` (es decir, su delivery_date
 * coincide con la fecha seleccionada). Los demás vienen con
 * `delivery_order=null` y el admin los puede agregar.
 */
export type RouteCandidate = {
  id: string;
  client_name: string;
  address: string;
  sale_date: string | null;
  driver_id: string | null;
  driver_name: string | null;
  delivery_order: number | null;
  assigned_to_this_date: boolean;
  colors: { color_name: string; quantity: number; cost_per_sheet: number }[];
};

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
  routeDate,
  routeCandidates,
  evidenceByLead,
  contraEntregaLeadIds,
  leadDetails,
}: {
  rows: EntregaRow[];
  drivers: DriverOption[];
  filters: FiltersState;
  /** Issues no resueltos por lead_id. Si un lead no tiene entrada o el
   *  array está vacío, no aparece el badge en su fila. */
  issuesByLead: Record<string, IssueRow[]>;
  /** Fecha YYYY-MM-DD seleccionada para la sección "Ruta del día". */
  routeDate: string;
  /** Leads candidatos a la ruta del día (ya asignados a esa fecha o
   *  sin fecha asignada). */
  routeCandidates: RouteCandidate[];
  /** Evidencia de cobro del chofer por lead_id (Grupo 4). null/missing
   *  cuando el chofer no subió foto en su confirmDeliveryAction. */
  evidenceByLead: Record<string, DeliveryEvidence>;
  /** lead_ids con al menos un pago contra_entrega — fila naranja. */
  contraEntregaLeadIds: string[];
  /** Datos extendidos por lead para el drawer/modal de detalle.
   *  Pre-resueltos en el server para no agregar latencia al abrir. */
  leadDetails: Record<string, LeadDetail>;
}) {
  const contraEntregaSet = useMemo(
    () => new Set(contraEntregaLeadIds),
    [contraEntregaLeadIds],
  );
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  // Lead actualmente abierto en el modal de issues. null = modal cerrado.
  const [openIssuesLead, setOpenIssuesLead] = useState<EntregaRow | null>(null);
  // Lead actualmente abierto en el modal de "No entregado". Distinto
  // del de issues — son flujos diferentes (issues = problemas DURANTE
  // entrega, failed = entrega NO ejecutada).
  const [openFailedLead, setOpenFailedLead] = useState<EntregaRow | null>(null);
  // Lightbox de evidencia. Guardamos {src, alt} para mostrar; null = cerrado.
  const [lightbox, setLightbox] = useState<
    { src: string; alt: string } | null
  >(null);
  // Lead seleccionado para el drawer de detalle. null = drawer cerrado.
  const [selectedLead, setSelectedLead] = useState<EntregaRow | null>(null);

  function pushFilters(next: Partial<FiltersState>) {
    const merged = {
      driver: next.driver ?? filters.driver,
      status: next.status ?? filters.status,
    };
    const params = new URLSearchParams();
    if (merged.driver) params.set('driver', merged.driver);
    if (merged.status) params.set('status', merged.status);
    // Preservamos `fecha` si está activa (drill-down con filtro
    // de fecha + filtros de chofer/estado simultáneos).
    const sp = new URLSearchParams(window.location.search);
    const fecha = sp.get('fecha');
    if (fecha) params.set('fecha', fecha);
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  /** Cambia la fecha de la ruta vía router.push (preserva otros filtros). */
  function pushRouteDate(newDate: string) {
    const params = new URLSearchParams();
    if (filters.driver) params.set('driver', filters.driver);
    if (filters.status) params.set('status', filters.status);
    params.set('fecha', newDate);
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
            id="entregas-filter-driver"
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

        {/* Leyenda discreta de los códigos de color de fila. Mismas
            reglas que /leads para consistencia visual entre módulos. */}
        <div className="mt-3">
          <LeadRowLegend />
        </div>
      </div>

      {/* Sección "Ruta del día" — selector de fecha + lista de
          candidatos con input de orden por entrega.
          Se renderiza ARRIBA de la tabla general porque es la operación
          de planeación más frecuente del admin (organizar el día
          antes de empezar la jornada). */}
      <div id="entregas-date">
        <RouteSection
          routeDate={routeDate}
          candidates={routeCandidates}
          onChangeDate={pushRouteDate}
        />
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

      {/* Modal de "No entregado" — muestra motivo + foto del lugar. */}
      {openFailedLead && (
        <FailedDeliveryModal
          entrega={openFailedLead}
          onClose={() => setOpenFailedLead(null)}
        />
      )}

      {/* Drawer lateral con el detalle completo del lead. */}
      {selectedLead && (
        <LeadDetailModal
          entrega={selectedLead}
          detail={leadDetails[selectedLead.id] ?? null}
          issues={issuesByLead[selectedLead.id] ?? []}
          onClose={() => setSelectedLead(null)}
        />
      )}

      {/* Lightbox de evidencia de cobro. */}
      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}

      {/* Tabla */}
      <div
        id="entregas-table"
        className="tbl-wrap"
        style={{
          opacity: pending ? 0.6 : 1,
          transition: 'opacity 150ms ease',
        }}
      >
        <div className="overflow-x-auto">
          <table className="tbl table-to-cards">
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
                <th className="text-center">Evidencia cobro</th>
                <th className="text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={11}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {hasFilters
                      ? 'Ninguna entrega coincide con los filtros actuales.'
                      : 'Sin entregas registradas.'}
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  // Override rojo: entrega fallida + stock no devuelto =
                  // alerta operativa. Gana sobre el color manual o
                  // automático del lead. Cuando el admin devuelve el
                  // stock, la regla deja de aplicar y la fila vuelve
                  // a su color normal.
                  const needsStockReturn =
                    Boolean(r.failed_delivery_reason) && !r.stock_returned;
                  const rowStyle = needsStockReturn
                    ? STOCK_RETURN_PENDING_STYLE
                    : getLeadRowStyle(r, contraEntregaSet);
                  return (
                    <Row
                      key={r.id}
                      entrega={r}
                      rowStyle={rowStyle}
                      issues={issuesByLead[r.id] ?? []}
                      evidence={evidenceByLead[r.id] ?? null}
                      onOpenIssues={() => setOpenIssuesLead(r)}
                      onOpenFailed={() => setOpenFailedLead(r)}
                      onOpenEvidence={(ev) =>
                        setLightbox({
                          src: ev.url,
                          alt: `Evidencia de cobro de ${r.client_name}`,
                        })
                      }
                      onSelectRow={() => setSelectedLead(r)}
                    />
                  );
                })
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
  rowStyle,
  issues,
  evidence,
  onOpenIssues,
  onOpenFailed,
  onOpenEvidence,
  onSelectRow,
}: {
  entrega: EntregaRow;
  /** Estilo completo de la fila (background semitransparente + borde
   *  izquierdo acento). undefined = sin color, la fila usa el estilo
   *  neutro de la tabla. Computado en el parent con getLeadRowStyle. */
  rowStyle: { background: string; borderLeft: string } | undefined;
  issues: IssueRow[];
  evidence: DeliveryEvidence | null;
  onOpenIssues: () => void;
  onOpenFailed: () => void;
  onOpenEvidence: (ev: DeliveryEvidence) => void;
  /** Click en cualquier zona "neutra" de la fila — abre el drawer de
   *  detalle. Los botones que ya tienen acción (Editar, Devolver al
   *  stock, color picker, etc.) detienen la propagación. */
  onSelectRow: () => void;
}) {
  // Desglose con costo por fila: "5× Malta ($350) + 3× Parota ($600)".
  // Si la fila no tiene cost (lead antiguo sin migrar), omitimos el "($X)".
  const colorsLabel =
    r.colors.length === 0
      ? '—'
      : r.colors
          .map((c) =>
            c.cost_per_sheet > 0
              ? `${c.quantity}× ${c.color_name} (${formatMXN(c.cost_per_sheet)})`
              : `${c.quantity}× ${c.color_name}`,
          )
          .join(' + ');
  const issueCount = issues.length;
  const hasFailed = Boolean(r.failed_delivery_reason);

  // Click handler: abre el drawer SOLO si el target no está dentro de un
  // elemento interactivo (botón, link, input). Más limpio que poner
  // stopPropagation en cada botón individual — los nuevos botones que
  // se agreguen mañana funcionan sin tocar este código.
  const handleRowActivate = (
    e:
      | React.MouseEvent<HTMLTableRowElement>
      | React.KeyboardEvent<HTMLTableRowElement>,
  ) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, label')) return;
    onSelectRow();
  };

  return (
    <tr
      style={{ ...rowStyle, cursor: 'pointer' }}
      onClick={handleRowActivate}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleRowActivate(e);
        }
      }}
      aria-label={`Ver detalle de ${r.client_name}`}
    >
      <td data-label="Cliente">
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
          {hasFailed && (
            <button
              type="button"
              onClick={onOpenFailed}
              className="badge flex items-center gap-1"
              style={{
                cursor: 'pointer',
                border: 'none',
                fontSize: '0.6875rem',
                background: '#FFEDD5',
                color: '#9A3412',
              }}
              title="Ver motivo del intento fallido"
            >
              <X size={11} /> No entregado
            </button>
          )}
          {/* Estado de devolución de stock — solo relevante cuando
              hubo falla. Naranja = pendiente, verde = devuelto. */}
          {hasFailed && !r.stock_returned && (
            <span
              className="badge flex items-center gap-1"
              style={{
                border: 'none',
                fontSize: '0.6875rem',
                background: '#FED7AA',
                color: '#7C2D12',
              }}
              title="El material aún no regresó al almacén"
            >
              <TriangleAlert size={11} /> Stock pendiente
            </span>
          )}
          {hasFailed && r.stock_returned && (
            <span
              className="badge flex items-center gap-1"
              style={{
                border: 'none',
                fontSize: '0.6875rem',
                background: '#DCFCE7',
                color: '#166534',
              }}
              title="El material regresó al almacén"
            >
              <PackageCheck size={11} /> Stock devuelto
            </span>
          )}
        </div>

        {/* Acciones post-devolución: aparece DEBAJO de los badges
            cuando el stock ya regresó y el admin debe decidir el
            siguiente paso (reagendar o cancelar). State propio por
            componente para no bloquear el resto de la fila. */}
        {hasFailed && r.stock_returned && (
          <PostReturnActions
            leadId={r.id}
            clientName={r.client_name}
          />
        )}
        <div
          className="text-xs font-mono"
          style={{ color: 'var(--text-tertiary)' }}
        >
          #{r.id.slice(0, 8)}
        </div>
      </td>
      <td data-label="Chofer">
        {r.purchase_type === 'fabrica' ? (
          <span
            className="text-sm"
            style={{
              color: '#7C2D12',
              background: '#FFEDD5',
              padding: '2px 8px',
              borderRadius: 4,
              fontWeight: 500,
            }}
            title="Compra en fábrica — el cliente recoge"
          >
            🏭 Recoge en fábrica
          </span>
        ) : r.driver_name ? (
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
      <td data-label="Materiales" className="text-sm" style={{ color: 'var(--text-secondary)', maxWidth: 220 }}>
        <div className="truncate" title={colorsLabel}>
          {colorsLabel}
        </div>
        {/* Colores del cubrecanto que el chofer debe llevar. Solo se
            muestra si el lead tiene alguno registrado. */}
        {r.edgebanding_colors.length > 0 && (
          <div
            className="text-xs mt-1 truncate"
            style={{ color: '#92400E', fontWeight: 500 }}
            title={r.edgebanding_colors
              .map((c) => `${c.quantity}m ${c.color_name}`)
              .join(', ')}
          >
            📏 Cubrecanto:{' '}
            {r.edgebanding_colors
              .map((c) => `${c.color_name} ${c.quantity}m`)
              .join(', ')}
          </div>
        )}
      </td>
      <td data-label="Dirección" className="text-sm" style={{ color: 'var(--text-secondary)', maxWidth: 240 }}>
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
      <td data-label="Total" className="text-right font-semibold">{formatMXN(r.total_amount)}</td>
      <td
        data-label="Adeudo"
        className="text-right font-bold"
        style={{
          color: r.adeudo > 0 ? 'var(--danger)' : 'var(--success)',
        }}
      >
        {formatMXN(r.adeudo)}
      </td>
      <td data-label="Entrega">
        <DeliveryBadge status={r.delivery_status} />
      </td>
      <td data-label="Pago">
        <PaymentBadge status={r.payment_status} />
      </td>
      <td data-label="Fecha" className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {formatDate(r.sale_date)}
      </td>
      <td data-label="Evidencia" className="text-center">
        {evidence ? (
          <button
            type="button"
            onClick={() => onOpenEvidence(evidence)}
            className="btn btn-ghost"
            style={{ padding: 6, color: 'var(--brand-secondary)' }}
            aria-label={`Ver evidencia de cobro de ${r.client_name}`}
            title={`Ver foto del cobro · ${formatMXN(evidence.amount)}`}
          >
            <Camera size={16} />
          </button>
        ) : (
          <span
            className="text-xs"
            style={{ color: 'var(--text-tertiary)' }}
          >
            —
          </span>
        )}
      </td>
      <td data-label="Acciones">
        <div className="flex justify-end items-center gap-1 flex-wrap">
          {r.purchase_type === 'fabrica' &&
            r.delivery_status !== 'entregado' &&
            r.delivery_status !== 'cancelado' && (
              <FabricaDeliverButton
                leadId={r.id}
                clientName={r.client_name}
              />
            )}
          {hasFailed && !r.stock_returned && (
            <ReturnStockButton
              leadId={r.id}
              clientName={r.client_name}
            />
          )}
          <RowColorPickerCell
            leadId={r.id}
            value={r.row_color}
            action={colorActionAdapter}
          />
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

/**
 * Botón "🏭 Entregar" — solo visible para leads con
 * `purchase_type='fabrica'` que aún no se entregaron. Confirma inline
 * (sí/no) y llama a `markFabricaDeliveredAction`. Mismo flujo que el
 * botón de /leads, action compartida.
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
          {pending ? <Loader size={11} className="animate-spin" /> : 'Sí'}
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
 * Botón "↩ Devolver al stock" — solo visible cuando hay falla con
 * stock pendiente. State propio (pending/error) para que un click no
 * bloquee otros botones de la tabla. Tras éxito el server hace
 * revalidatePath y router.refresh() trae la fila con
 * `stock_returned=true` → este componente se desmonta naturalmente.
 *
 * Confirm() defensivo antes de disparar: la acción suma al stock_total
 * y resetea el lead a "pendiente" — un click accidental sería difícil
 * de revertir limpiamente.
 */
function ReturnStockButton({
  leadId,
  clientName,
}: {
  leadId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    const ok = window.confirm(
      `¿Confirmar devolución al stock para "${clientName}"?\n\n` +
        'Esta acción suma el material al inventario, libera el ' +
        'compromiso del lead y lo deja pendiente para reagendar.',
    );
    if (!ok) return;

    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.set('lead_id', leadId);
        const r = await returnStockAction({ status: 'idle' }, fd);
        if (r.status === 'error') {
          setError(r.message);
        } else if (r.status === 'success') {
          // revalidatePath + refresh para que la fila se repinte
          // con stock_returned=true (badge verde, fila pierde rojo).
          router.refresh();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error de red';
        setError(message);
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        aria-busy={pending}
        className="btn"
        style={{
          padding: '4px 10px',
          fontSize: '0.75rem',
          fontWeight: 600,
          background: '#DC2626',
          color: '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
        aria-label={`Devolver al stock el material de ${clientName}`}
        title="Regresar material al almacén"
      >
        {pending ? (
          <>
            <Loader size={12} className="animate-spin" />
            <span>Devolviendo…</span>
          </>
        ) : (
          <>
            <Undo2 size={12} /> Devolver al stock
          </>
        )}
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
 * Bloque de acciones que aparece DEBAJO de los badges cuando un lead
 * tiene `stock_returned=true`. El admin elige entre dos caminos:
 *
 *   - Reenviar el pedido: recompromete el stock, limpia los campos de
 *     falla y deja el lead pendiente para reagendar en otra ruta.
 *   - Cancelar la compra: soft-delete del lead (deleted_at=now()),
 *     marca delivery_status='cancelado'. Requiere confirmación inline.
 *
 * Dos `useTransition` separados para que reasignar no bloquee el
 * botón de cancelar y viceversa. Errores inline por cada acción
 * (texto chico, truncado a 40 chars).
 *
 * UX del confirm: en vez de window.confirm() inline (modal nativo),
 * mostramos un mini-prompt con dos botones "Sí, cancelar" y "No" —
 * cliquéable sin layout shift, más accesible y consistente con el
 * resto del módulo.
 */
function PostReturnActions({
  leadId,
  clientName,
}: {
  leadId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [reassignPending, startReassign] = useTransition();
  const [cancelPending, startCancel] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  function handleReassign() {
    setReassignError(null);
    startReassign(async () => {
      try {
        const fd = new FormData();
        fd.set('lead_id', leadId);
        const r = await reassignDeliveryAction({ status: 'idle' }, fd);
        if (r.status === 'error') {
          setReassignError(r.message);
        } else if (r.status === 'success') {
          router.refresh();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error de red';
        setReassignError(message);
      }
    });
  }

  function handleCancel() {
    setCancelError(null);
    startCancel(async () => {
      try {
        const fd = new FormData();
        fd.set('lead_id', leadId);
        const r = await cancelLeadAction({ status: 'idle' }, fd);
        if (r.status === 'error') {
          setCancelError(r.message);
          setConfirming(false);
        } else if (r.status === 'success') {
          // El lead queda con deleted_at — el SELECT del page.tsx ya
          // filtra .is('deleted_at', null), así que router.refresh()
          // hace desaparecer la fila de la tabla.
          router.refresh();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error de red';
        setCancelError(message);
        setConfirming(false);
      }
    });
  }

  const anyPending = reassignPending || cancelPending;

  return (
    <div className="mt-2">
      {!confirming ? (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleReassign}
            disabled={anyPending}
            aria-busy={reassignPending}
            className="btn"
            style={{
              padding: '4px 10px',
              fontSize: '0.75rem',
              fontWeight: 600,
              background: 'var(--brand-primary)',
              color: '#fff',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
            aria-label={`Volver a mandar pedido de ${clientName}`}
            title="Recompromete el stock y deja el lead listo para reagendar"
          >
            {reassignPending ? (
              <>
                <Loader size={12} className="animate-spin" />
                <span>Reenviando…</span>
              </>
            ) : (
              <>
                <RefreshCcw size={12} /> Volver a mandar
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={anyPending}
            className="btn btn-outline"
            style={{
              padding: '4px 10px',
              fontSize: '0.75rem',
              fontWeight: 600,
              color: '#B91C1C',
              borderColor: '#FCA5A5',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
            aria-label={`Cancelar compra de ${clientName}`}
            title="Marca el lead como cancelado (soft-delete)"
          >
            <Ban size={12} /> Cancelar compra
          </button>
        </div>
      ) : (
        <div
          className="flex items-center gap-2 flex-wrap"
          style={{
            background: '#FEF2F2',
            border: '1px solid #FCA5A5',
            padding: '6px 10px',
            borderRadius: 6,
          }}
          role="dialog"
          aria-label="Confirmar cancelación"
        >
          <span
            className="text-xs"
            style={{ color: '#7F1D1D', fontWeight: 500 }}
          >
            ¿Seguro que quieres cancelar la compra de{' '}
            <strong>{clientName}</strong>?
          </span>
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelPending}
            aria-busy={cancelPending}
            className="btn"
            style={{
              padding: '4px 10px',
              fontSize: '0.75rem',
              fontWeight: 600,
              background: '#DC2626',
              color: '#fff',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {cancelPending ? (
              <>
                <Loader size={12} className="animate-spin" />
                <span>Cancelando…</span>
              </>
            ) : (
              'Sí, cancelar'
            )}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={cancelPending}
            className="btn btn-ghost"
            style={{ padding: '4px 10px', fontSize: '0.75rem' }}
          >
            No
          </button>
        </div>
      )}

      {reassignError && (
        <div
          role="alert"
          className="text-[10px] mt-1"
          style={{ color: 'var(--danger, #dc2626)', maxWidth: 240 }}
          title={reassignError}
        >
          {reassignError.length > 40
            ? `${reassignError.slice(0, 40)}…`
            : reassignError}
        </div>
      )}
      {cancelError && (
        <div
          role="alert"
          className="text-[10px] mt-1"
          style={{ color: 'var(--danger, #dc2626)', maxWidth: 240 }}
          title={cancelError}
        >
          {cancelError.length > 40
            ? `${cancelError.slice(0, 40)}…`
            : cancelError}
        </div>
      )}
    </div>
  );
}

/**
 * Formatea una fecha (`YYYY-MM-DD` puro o ISO timestamp) a texto
 * corto en es-MX.
 *
 * Fix TZ (2026-05): para columnas DATE (sale_date) `new Date(str)`
 * parsea como UTC y al formatear en México (UTC-6) muestra un día
 * atrás. Detectamos el formato YYYY-MM-DD y usamos el ctor local.
 */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(iso);
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
 * Drawer lateral con TODA la información del lead. Se monta al
 * cliquear una fila de la tabla en /admin/entregas; el `EntregaRow`
 * trae los campos visibles y `LeadDetail` (passed-in) los extendidos
 * que no caben en la tabla (teléfono, canal, vendedor, documentos,
 * desglose de cubrecanto/cortes/catálogo, pagos registrados).
 *
 * Layout: overlay oscuro fullscreen + panel anclado a la derecha
 * (max 520px). El panel cierra con:
 *   - click en el overlay (fuera del panel)
 *   - botón "X"
 *   - Escape
 *
 * Animación con CSS-in-style: el panel entra desde la derecha en
 * 250ms (animate-slide-in-right) y el overlay aparece con fade.
 * No usamos librerías de modal porque el resto del proyecto usa el
 * mismo patrón inline (IssuesModal, FailedDeliveryModal).
 *
 * NB: si `detail` es null (lead no estaba en el record passed por el
 * server — caso edge, no debería ocurrir), mostramos un mensaje de
 * fallback en lugar de romper.
 */
function LeadDetailModal({
  entrega: r,
  detail,
  issues,
  onClose,
}: {
  entrega: EntregaRow;
  detail: LeadDetail | null;
  issues: IssueRow[];
  onClose: () => void;
}) {
  // Cerrar con Escape. Listener montado solo mientras el modal está
  // abierto (este componente se desmonta cuando selectedLead = null).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const colors = detail?.colors_with_unit ?? [];
  const subtotalHojas = colors.reduce(
    (s, c) => s + c.quantity * c.unit_cost,
    0,
  );
  const sheetsCount = colors.reduce((s, c) => s + c.quantity, 0);

  return (
    <div
      className="fixed inset-0 z-50 flex"
      style={{ background: 'rgba(15,23,42,0.45)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="lead-detail-title"
    >
      <div style={{ flex: 1 }} aria-hidden="true" />
      <aside
        className="card animate-slide-in-right"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 520,
          height: '100%',
          overflowY: 'auto',
          borderRadius: 0,
          background: 'var(--bg-base, #fff)',
          padding: '20px 24px',
          boxShadow: '-8px 0 32px rgba(0,0,0,0.15)',
        }}
      >
        {/* Header con cerrar */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2
              id="lead-detail-title"
              className="text-xl font-bold leading-tight"
              style={{ color: 'var(--text-primary)' }}
            >
              {r.client_name}
            </h2>
            <div
              className="text-xs font-mono mt-1"
              style={{ color: 'var(--text-tertiary)' }}
            >
              #{r.id.slice(0, 8)}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ padding: 6, flexShrink: 0 }}
            onClick={onClose}
            aria-label="Cerrar detalle"
          >
            <X size={20} />
          </button>
        </div>

        {/* SECCIÓN 1 — Datos del cliente */}
        <DetailSection title="Datos del cliente">
          <KV
            icon={<Phone size={14} />}
            label="Teléfono"
            value={detail?.phone || '—'}
          />
          <KV
            label="Canal"
            value={(detail?.channel ?? '').toUpperCase() || '—'}
          />
          <KV label="Vendedor" value={detail?.seller_name ?? '—'} />
          <KV label="Fecha del pedido" value={formatDate(r.sale_date)} />
          <KV
            label="Tipo de compra"
            value={
              r.purchase_type === 'fabrica'
                ? '🏭 En fábrica'
                : r.purchase_type === 'domicilio'
                  ? 'A domicilio'
                  : r.purchase_type ?? '—'
            }
          />
          <KV label="Tipo de venta" value={r.sale_type ?? '—'} />
        </DetailSection>

        {/* SECCIÓN 2 — Detalle del pedido */}
        <DetailSection title="Detalle del pedido">
          {(detail?.has_hojas || detail?.has_cubrecanto || detail?.has_catalogo) && (
            <div className="flex items-center gap-1 flex-wrap mb-3">
              {detail?.has_hojas && (
                <span
                  className="badge"
                  style={{
                    fontSize: '0.6875rem',
                    background: '#DBEAFE',
                    color: '#1E40AF',
                  }}
                >
                  📋 Hojas
                </span>
              )}
              {detail?.has_cubrecanto && (
                <span
                  className="badge"
                  style={{
                    fontSize: '0.6875rem',
                    background: '#FEF3C7',
                    color: '#92400E',
                  }}
                >
                  📏 Cubrecanto
                </span>
              )}
              {detail?.has_catalogo && (
                <span
                  className="badge"
                  style={{
                    fontSize: '0.6875rem',
                    background: '#EDE9FE',
                    color: '#6D28D9',
                  }}
                >
                  📚 Catálogo
                </span>
              )}
            </div>
          )}

          {colors.length > 0 && (
            <div className="mb-3">
              <div
                className="text-xs uppercase tracking-wide mb-1"
                style={{ color: 'var(--text-tertiary)', fontWeight: 600 }}
              >
                Colores ({sheetsCount} hojas)
              </div>
              <ul className="text-sm flex flex-col gap-1">
                {colors.map((c, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span>
                      {c.quantity}× {c.color_name}
                    </span>
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {formatMXN(c.unit_cost)} ·{' '}
                      <strong>{formatMXN(c.quantity * c.unit_cost)}</strong>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {r.edgebanding_colors.length > 0 && (
            <div className="mb-3">
              <div
                className="text-xs uppercase tracking-wide mb-1"
                style={{ color: '#92400E', fontWeight: 600 }}
              >
                Cubrecanto · colores
              </div>
              <ul className="text-sm flex flex-col gap-1">
                {r.edgebanding_colors.map((c, i) => (
                  <li key={i}>
                    {c.color_name} — <strong>{c.quantity} m</strong>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {detail?.edge_banding_type && detail.edge_banding_meters != null && (
            <KV
              label="Cubrecanto estructurado"
              value={`${detail.edge_banding_type} · ${detail.edge_banding_meters} m${
                detail.edge_banding_total != null
                  ? ` · ${formatMXN(detail.edge_banding_total)}`
                  : ''
              }`}
            />
          )}

          {detail?.cuts_count != null && detail.cuts_count > 0 && (
            <KV
              label="Cortes"
              value={`${detail.cuts_count} cortes${
                detail.cuts_total != null
                  ? ` · ${formatMXN(detail.cuts_total)}`
                  : ''
              }`}
            />
          )}

          {detail?.has_catalogo && detail.catalog_price != null && (
            <KV label="Catálogo" value={formatMXN(detail.catalog_price)} />
          )}

          {detail?.has_cubrecanto &&
            detail.edgebanding_manual_cost != null &&
            detail.edgebanding_manual_cost > 0 && (
              <KV
                label="Cubrecanto (manual)"
                value={`${formatMXN(detail.edgebanding_manual_cost)} / unidad`}
              />
            )}

          {detail?.delivery_cost != null && detail.delivery_cost > 0 && (
            <KV label="Envío" value={formatMXN(detail.delivery_cost)} />
          )}

          {/* Desglose total */}
          <div
            className="mt-3 pt-3 flex justify-between items-baseline"
            style={{ borderTop: '1px solid var(--border)' }}
          >
            <span className="text-sm font-semibold">Total</span>
            <span className="text-xl font-bold">
              {formatMXN(r.total_amount)}
            </span>
          </div>
          {subtotalHojas > 0 && colors.length > 0 && (
            <div
              className="text-xs mt-1 flex justify-between"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <span>Subtotal hojas</span>
              <span>{formatMXN(subtotalHojas)}</span>
            </div>
          )}
        </DetailSection>

        {/* SECCIÓN 3 — Estado */}
        <DetailSection title="Estado">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              Entrega:
            </span>
            <DeliveryBadge status={r.delivery_status} />
            <span className="text-xs ml-2" style={{ color: 'var(--text-tertiary)' }}>
              Pago:
            </span>
            <PaymentBadge status={r.payment_status} />
          </div>
          <KV
            label="Adeudo"
            value={
              <span
                style={{
                  color: r.adeudo > 0 ? 'var(--danger)' : 'var(--success)',
                  fontWeight: 700,
                }}
              >
                {formatMXN(r.adeudo)}
              </span>
            }
          />
          <KV
            icon={<Truck size={14} />}
            label="Chofer"
            value={
              r.purchase_type === 'fabrica'
                ? '🏭 Recoge en fábrica'
                : r.driver_name ?? 'Sin asignar'
            }
          />
        </DetailSection>

        {/* SECCIÓN 4 — Dirección y mapa */}
        {(r.address || r.maps_url) && (
          <DetailSection title="Dirección">
            <div
              className="text-sm whitespace-pre-wrap"
              style={{ color: 'var(--text-primary)' }}
            >
              {r.address || '—'}
            </div>
            {r.maps_url && (
              <a
                href={r.maps_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm inline-flex items-center gap-1 mt-2 hover:underline"
                style={{ color: 'var(--brand-secondary)' }}
              >
                <MapPin size={14} /> Ver en mapa
              </a>
            )}
          </DetailSection>
        )}

        {/* SECCIÓN 5 — Documentos adjuntos */}
        {detail && detail.document_urls.length > 0 && (
          <DetailSection title="Documentos adjuntos">
            <ul className="flex flex-col gap-1">
              {detail.document_urls.map((u, i) => {
                const isPdf = /\.pdf(\?|$)/i.test(u);
                const name = u.split('/').pop() ?? `Archivo ${i + 1}`;
                const cleanName = /^\d+_\d+_[a-z0-9]+\./i.test(name)
                  ? `Archivo ${i + 1}.${name.split('.').pop() ?? ''}`
                  : name;
                return (
                  <li key={u}>
                    <a
                      href={u}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--bg-subtle)]"
                      style={{
                        textDecoration: 'none',
                        color: 'var(--text-primary)',
                        fontSize: '0.8125rem',
                      }}
                    >
                      {isPdf ? (
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
                  </li>
                );
              })}
            </ul>
          </DetailSection>
        )}

        {/* SECCIÓN 6 — Issues reportados */}
        {issues.length > 0 && (
          <DetailSection title="Reportes sin resolver">
            <ul className="flex flex-col gap-2">
              {issues.map((i) => (
                <li
                  key={i.id}
                  className="card p-3"
                  style={{
                    background: 'var(--bg-subtle)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`badge ${
                        i.issue_type === 'faltante'
                          ? 'badge-danger'
                          : 'badge-warning'
                      }`}
                      style={{ fontSize: '0.6875rem' }}
                    >
                      {i.issue_type === 'faltante' ? 'Faltante' : 'Detalle'}
                    </span>
                    <span
                      className="text-xs"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {formatDateTime(i.created_at)}
                    </span>
                  </div>
                  <p
                    className="text-sm"
                    style={{
                      color: 'var(--text-primary)',
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.4,
                    }}
                  >
                    {i.description || '(sin descripción)'}
                  </p>
                  {i.photo_url && (
                    <a
                      href={i.photo_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs hover:underline inline-flex items-center gap-1 mt-1"
                      style={{ color: 'var(--brand-secondary)' }}
                    >
                      📷 Ver foto
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </DetailSection>
        )}

        {/* SECCIÓN 7 — Pagos */}
        {detail && detail.payments.length > 0 && (
          <DetailSection title="Pagos registrados">
            <ul className="flex flex-col gap-2">
              {detail.payments.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <Wallet
                      size={14}
                      style={{ color: 'var(--text-tertiary)' }}
                    />
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {paymentTypeLabel(p.payment_type)} ·{' '}
                      {p.method || '—'}
                    </span>
                    <span
                      className={`badge ${
                        p.status === 'exitoso'
                          ? 'badge-success'
                          : p.status === 'cancelado'
                            ? 'badge-danger'
                            : 'badge-neutral'
                      }`}
                      style={{ fontSize: '0.6875rem' }}
                    >
                      {p.status || 'pendiente'}
                    </span>
                  </div>
                  <span className="font-bold">{formatMXN(p.amount)}</span>
                </li>
              ))}
            </ul>
          </DetailSection>
        )}

        {/* Acciones del modal */}
        <div className="flex items-center gap-2 mt-6">
          <Link
            href={`/leads/${r.id}/edit`}
            className="btn btn-primary"
            style={{ flex: 1, justifyContent: 'center' }}
          >
            <Pencil size={14} /> Editar lead
          </Link>
          <button
            type="button"
            className="btn btn-outline"
            onClick={onClose}
            style={{ flex: 1, justifyContent: 'center' }}
          >
            Cerrar
          </button>
        </div>
      </aside>
    </div>
  );
}

/**
 * Sección del drawer con título uppercase pequeño + contenido. Mantiene
 * estilo consistente entre las 7 secciones del modal.
 */
function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5">
      <h3
        className="text-xs uppercase tracking-wide mb-2"
        style={{ color: 'var(--text-tertiary)', fontWeight: 700 }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Par clave-valor compacto para datos del cliente / estado. */
function KV({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm py-0.5">
      <span
        className="flex items-center gap-1"
        style={{ color: 'var(--text-secondary)' }}
      >
        {icon}
        {label}
      </span>
      <span
        style={{
          color: 'var(--text-primary)',
          textAlign: 'right',
          fontWeight: 500,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function paymentTypeLabel(t: string): string {
  switch (t) {
    case 'anticipo':
      return 'Anticipo';
    case 'liquidacion':
      return 'Liquidación';
    case 'contra_entrega':
      return 'Contra entrega';
    default:
      return t || '—';
  }
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

/**
 * Sección "Ruta del día".
 *
 * UX:
 *   - Selector de fecha en la cabecera (controla `?fecha=` vía
 *     router.push, recarga el SELECT del page.tsx).
 *   - Lista de candidatos: cada fila tiene su propio `<input
 *     type="number">` para el orden. Estado local (`orderInputs`) se
 *     mantiene aparte del `delivery_order` que viene del server, para
 *     que el admin pueda editar varios antes de guardar sin que cada
 *     keystroke dispare un fetch.
 *   - Botón "Guardar ruta del día" valida que cualquiera de los inputs
 *     sea > 0 (al menos UNA entrega en la ruta) y envía un FormData
 *     con `delivery_date` + `assignments` (JSON serializado) al
 *     `assignDeliveryRouteAction`. Solo se incluyen los leads cuyo
 *     orden cambió respecto al server (optimización: evitar UPDATE
 *     no-op).
 *   - Tras success: router.refresh() para que el server vuelva a
 *     leer y reflejar el estado.
 *
 * Validación del input: 0 = quitar de la ruta de ese día, 1..N = orden,
 * vacío = "no tocar". Aceptamos repetidos (no validamos unicidad de
 * delivery_order) — el admin puede tener dos entregas con orden 1 si
 * son simultáneas. La UI pinta un warning sutil si hay duplicados pero
 * permite guardar.
 */
function RouteSection({
  routeDate,
  candidates,
  onChangeDate,
}: {
  routeDate: string;
  candidates: RouteCandidate[];
  onChangeDate: (newDate: string) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Map<lead_id, raw input value (string)>. Inicializamos con el
  // delivery_order actual del server (si está asignado a ESTA fecha) o
  // '' si no. El usuario edita strings; al guardar parseamos.
  const [orderInputs, setOrderInputs] = useState<Record<string, string>>(
    () => {
      const acc: Record<string, string> = {};
      for (const c of candidates) {
        acc[c.id] =
          c.assigned_to_this_date && c.delivery_order != null
            ? String(c.delivery_order)
            : '';
      }
      return acc;
    },
  );
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function handleOrderChange(leadId: string, raw: string) {
    // Permitimos solo dígitos (max 3) o vacío para que el usuario
    // pueda borrar y dejar "no asignado".
    if (raw !== '' && !/^\d{1,3}$/.test(raw)) return;
    setOrderInputs((prev) => ({ ...prev, [leadId]: raw }));
    setError(null);
    setSuccess(null);
  }

  /**
   * Calcula los assignments a enviar:
   *   - Solo incluimos leads cuyo input difiere del estado actual
   *     en server.
   *   - Input vacío + ya asignado a esta fecha → enviamos order=0
   *     (= quitar de la ruta).
   *   - Input vacío + NO asignado → no enviamos nada (sin cambios).
   *   - Input N + estado server distinto → enviamos order=N.
   */
  const dirtyAssignments = useMemo(() => {
    const out: { lead_id: string; delivery_order: number }[] = [];
    for (const c of candidates) {
      const raw = orderInputs[c.id] ?? '';
      const currentOrder =
        c.assigned_to_this_date && c.delivery_order != null
          ? c.delivery_order
          : 0; // 0 = "no en la ruta de esta fecha"
      const newOrder = raw === '' ? 0 : Number(raw);
      if (newOrder !== currentOrder) {
        out.push({ lead_id: c.id, delivery_order: newOrder });
      }
    }
    return out;
  }, [orderInputs, candidates]);

  function handleSave() {
    setError(null);
    setSuccess(null);
    if (dirtyAssignments.length === 0) {
      setError('No hay cambios para guardar.');
      return;
    }
    const fd = new FormData();
    fd.set('delivery_date', routeDate);
    fd.set('assignments', JSON.stringify(dirtyAssignments));

    startTransition(async () => {
      try {
        const r = await assignDeliveryRouteAction({ status: 'idle' }, fd);
        if (r.status === 'success') {
          setSuccess(r.message);
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

  // Detectamos órdenes duplicados (warning visual, no bloqueante).
  const usedOrders = new Map<number, number>();
  for (const v of Object.values(orderInputs)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) {
      usedOrders.set(n, (usedOrders.get(n) ?? 0) + 1);
    }
  }
  const hasDuplicates = Array.from(usedOrders.values()).some((c) => c > 1);

  // Conteo de entregas asignadas (orden > 0) en el state actual.
  const assignedCount = Object.values(orderInputs).filter(
    (v) => Number(v) > 0,
  ).length;

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <div className="flex items-center gap-2">
          <Route size={20} style={{ color: 'var(--brand-secondary)' }} />
          <div>
            <h3 className="font-semibold">Ruta del día</h3>
            <p
              className="text-xs"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Asigna el orden de las entregas para una fecha. Los
              choferes verán la secuencia en su vista.
            </p>
            <p
              className="text-[11px] mt-1"
              style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}
            >
              Solo se muestran entregas a domicilio.
            </p>
          </div>
        </div>
        <div className="relative">
          <Calendar
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--text-tertiary)' }}
          />
          <input
            type="date"
            className="input"
            style={{ paddingLeft: 36, minWidth: 180 }}
            value={routeDate}
            onChange={(e) => {
              const v = e.target.value;
              if (/^\d{4}-\d{2}-\d{2}$/.test(v)) onChangeDate(v);
            }}
            aria-label="Fecha de la ruta"
            disabled={pending}
          />
        </div>
      </div>

      {candidates.length === 0 ? (
        <div
          className="text-sm text-center py-6"
          style={{ color: 'var(--text-tertiary)' }}
        >
          No hay entregas pendientes para asignar a esta fecha.
        </div>
      ) : (
        <>
          <div
            className="rounded-lg border overflow-hidden"
            style={{ borderColor: 'var(--border)' }}
          >
            <div
              className="grid px-4 py-2 text-xs font-semibold uppercase tracking-wide"
              style={{
                gridTemplateColumns: '90px 1fr 200px 200px',
                background: 'var(--bg-subtle)',
                color: 'var(--text-secondary)',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div>Orden</div>
              <div>Cliente</div>
              <div>Chofer</div>
              <div>Dirección</div>
            </div>
            {candidates.map((c) => {
              const raw = orderInputs[c.id] ?? '';
              const n = Number(raw);
              const isDup =
                Number.isFinite(n) && n > 0 && (usedOrders.get(n) ?? 0) > 1;
              return (
                <div
                  key={c.id}
                  className="grid px-4 py-2 items-center border-t"
                  style={{
                    gridTemplateColumns: '90px 1fr 200px 200px',
                    borderColor: 'var(--border)',
                  }}
                >
                  <div>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      className="input"
                      style={{
                        width: 70,
                        padding: '6px 8px',
                        textAlign: 'center',
                        fontWeight: 600,
                        borderColor: isDup
                          ? 'var(--warning, #C2410C)'
                          : undefined,
                      }}
                      placeholder="—"
                      value={raw}
                      onChange={(e) =>
                        handleOrderChange(c.id, e.target.value)
                      }
                      disabled={pending}
                      aria-label={`Orden de entrega para ${c.client_name}`}
                    />
                  </div>
                  <div className="text-sm">
                    <div className="font-medium">{c.client_name}</div>
                    {c.colors.length > 0 && (
                      <div
                        className="text-xs truncate"
                        style={{ color: 'var(--text-tertiary)' }}
                        title={c.colors
                          .map((cc) =>
                            cc.cost_per_sheet > 0
                              ? `${cc.quantity}× ${cc.color_name} (${formatMXN(cc.cost_per_sheet)})`
                              : `${cc.quantity}× ${cc.color_name}`,
                          )
                          .join(' + ')}
                      >
                        {c.colors
                          .map((cc) =>
                            cc.cost_per_sheet > 0
                              ? `${cc.quantity}× ${cc.color_name} (${formatMXN(cc.cost_per_sheet)})`
                              : `${cc.quantity}× ${cc.color_name}`,
                          )
                          .join(' + ')}
                      </div>
                    )}
                  </div>
                  <div
                    className="text-sm"
                    style={{
                      color: c.driver_name
                        ? 'var(--text-primary)'
                        : '#B91C1C',
                    }}
                  >
                    {c.driver_name ?? 'Sin asignar'}
                  </div>
                  <div
                    className="text-xs truncate"
                    style={{ color: 'var(--text-secondary)' }}
                    title={c.address}
                  >
                    {c.address || '—'}
                  </div>
                </div>
              );
            })}
          </div>

          {hasDuplicates && (
            <div
              className="text-xs mt-3 flex items-center gap-1"
              style={{ color: '#C2410C' }}
            >
              <TriangleAlert size={12} />
              Hay órdenes repetidos — el chofer verá ambos en la misma
              posición.
            </div>
          )}

          <div className="flex items-center justify-between mt-4 gap-3 flex-wrap">
            <div
              className="text-xs"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <strong>{assignedCount}</strong>{' '}
              {assignedCount === 1
                ? 'entrega en la ruta'
                : 'entregas en la ruta'}
              {dirtyAssignments.length > 0 && (
                <span style={{ marginLeft: 8 }}>
                  · <strong>{dirtyAssignments.length}</strong>{' '}
                  {dirtyAssignments.length === 1
                    ? 'cambio sin guardar'
                    : 'cambios sin guardar'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {pending && (
                <span
                  className="text-xs flex items-center gap-1"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  <Loader size={12} className="animate-spin" /> Guardando…
                </span>
              )}
              <button
                type="button"
                onClick={handleSave}
                className="btn btn-primary"
                disabled={pending || dirtyAssignments.length === 0}
                aria-busy={pending}
              >
                <Route size={14} /> Guardar ruta del día
              </button>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="text-sm mt-3"
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

          {success && (
            <div
              role="status"
              className="text-sm mt-3 flex items-center gap-2"
              style={{
                color: '#15803D',
                background: 'rgba(22,163,74,0.08)',
                border: '1px solid rgba(22,163,74,0.25)',
                padding: '8px 12px',
                borderRadius: 6,
              }}
            >
              <CircleCheckBig size={16} /> {success}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Modal del badge naranja "No entregado". Muestra motivo + foto del
 * lugar (link, abre en nueva pestaña). No tiene action — el admin
 * decide externamente qué hacer (re-asignar fecha, contactar cliente,
 * etc.). Si la entrega se reintenta y se completa, las columnas
 * `failed_delivery_*` quedan en DB como histórico (no las limpiamos
 * automáticamente).
 */
function FailedDeliveryModal({
  entrega,
  onClose,
}: {
  entrega: EntregaRow;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.45)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="failed-modal-title"
    >
      <div
        className="card w-full max-w-xl p-6 animate-fade max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3
              id="failed-modal-title"
              className="font-semibold text-lg flex items-center gap-2"
              style={{ color: '#9A3412' }}
            >
              <X size={18} /> Intento fallido
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

        <div
          className="card p-4"
          style={{
            background: '#FFEDD5',
            border: '1px solid #FED7AA',
          }}
        >
          <div
            className="text-xs uppercase tracking-wide mb-2"
            style={{ color: '#9A3412', fontWeight: 600 }}
          >
            Motivo
          </div>
          <p
            className="text-sm"
            style={{ color: '#7C2D12', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}
          >
            {entrega.failed_delivery_reason ?? '(sin motivo registrado)'}
          </p>
          {entrega.failed_delivery_photo_url && (
            <a
              href={entrega.failed_delivery_photo_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm hover:underline inline-flex items-center gap-1 mt-3"
              style={{ color: '#C2410C', fontWeight: 500 }}
            >
              📷 Ver foto del lugar
            </a>
          )}
        </div>

        <p
          className="text-xs mt-4"
          style={{ color: 'var(--text-tertiary)' }}
        >
          La entrega sigue pendiente. Reagenda la ruta o contacta al
          cliente para reintentar.
        </p>
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
