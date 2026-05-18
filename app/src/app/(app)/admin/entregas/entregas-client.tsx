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
  Route,
  Calendar,
  Camera,
  Undo2,
  PackageCheck,
  RefreshCcw,
  Ban,
  Factory,
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

  return (
    <tr style={rowStyle}>
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
