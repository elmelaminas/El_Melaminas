'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  Loader,
  Search,
  Camera,
  CircleCheckBig,
  X,
  Pencil,
} from 'lucide-react';
import { MethodBadge, TypeBadge } from '@/components/ui/Badges';
import {
  formatMXN,
  type DeliveryStatus,
  type PaymentMethod,
  type PaymentStatus,
  type PaymentType,
} from '@/data/mock';
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import { formatDateCDMX, formatDateTimeCDMX } from '@/lib/format-date';
import {
  validatePhotoFile,
  PHOTO_ACCEPT_ATTR,
} from '@/lib/validate-photo';
import {
  getLeadRowStyle,
  LeadRowLegend,
} from '@/components/ui/lead-row-color';
import { addPaymentToLeadAction, liquidateLeadAction } from './actions';

export type PaymentRow = {
  id: string;
  /** lead_id necesario para liquidación + colorear la fila. */
  lead_id: string;
  client_name: string;
  amount: number;
  net_amount: number;
  method: 'efectivo' | 'transferencia' | 'clip';
  payment_type: 'anticipo' | 'liquidacion' | 'contra_entrega';
  status: 'exitoso' | 'pendiente' | 'rechazado';
  paid_at: string | null;
  /** URL de la foto del comprobante (transferencia, ticket, etc.).
   *  null si el pago no tiene evidencia adjunta. Cuando hay foto, la
   *  fila muestra un ícono de cámara que abre el ImageLightbox. */
  evidence_photo_url: string | null;
  // Nota: la columna "chofer" se eliminó del listado. El chofer asignado
  // ahora vive en `leads.driver_id` (asignado al crear el lead). Para
  // mostrarlo aquí habría que JOIN payments → leads → profiles.
  deductibles: { concept: string; amount: number }[];
  // Datos del lead asociado para colorear la fila (mismas reglas que
  // en /leads) y calcular el adeudo.
  lead_sale_type: string | null;
  lead_product_type: string | null;
  lead_payment_status: PaymentStatus;
  lead_delivery_status: DeliveryStatus;
  lead_row_color: string | null;
  lead_total_amount: number;
  /** Adeudo restante del LEAD (no del pago): total − sum(pagos
   *  exitosos). 0 = lead totalmente pagado. */
  adeudo: number;
  /** Nombre del usuario que insertó el pago (vía
   *  `payments.registered_by` → `profiles.full_name`). null si la
   *  resolución falló o el registro es histórico. */
  registered_by_name: string | null;
};

/**
 * Fila agrupada por lead — la tabla ahora muestra UN row por lead con
 * todos sus pagos colapsados. `payments` lista TODOS los pagos del
 * lead (no solo los que matchearon el filtro) para que el modal de
 * detalle tenga la timeline completa.
 *
 * Agregados (`monto_cobrado_total` / `deducibles_total` / `neto_total`)
 * cubren SOLO pagos en estado `exitoso` — mismo criterio que las
 * cards superiores. `ultimo_metodo` / `ultimo_tipo` valen `'varios'`
 * cuando el lead tiene mezcla; un solo valor cuando todos los pagos
 * usan el mismo.
 */
export type LeadGroupRow = {
  lead_id: string;
  client_name: string;
  total_amount: number;
  adeudo: number;
  payments: PaymentRow[];
  monto_cobrado_total: number;
  deducibles_total: number;
  neto_total: number;
  ultimo_metodo: PaymentRow['method'] | 'varios';
  ultimo_tipo: PaymentRow['payment_type'] | 'varios';
  ultima_fecha: string | null;
  tiene_evidencia: boolean;
  payments_count: number;
  // Lead-level metadata para `getLeadRowStyle`.
  lead_sale_type: string | null;
  lead_product_type: string | null;
  lead_payment_status: PaymentStatus;
  lead_delivery_status: DeliveryStatus;
  lead_row_color: string | null;
};

type FiltersState = {
  q: string;
  method: '' | 'efectivo' | 'transferencia' | 'clip';
  type: '' | 'anticipo' | 'liquidacion' | 'contra_entrega';
  /** Mes 1-12; 0 = sin filtro. Pareja inseparable con `anio`. */
  mes: number;
  /** Año 4-dígitos; 0 = sin filtro. */
  anio: number;
  /** Estado de adeudo del LEAD asociado al pago. '' = todos. */
  adeudo: '' | 'pendiente' | 'liquidado';
};

/** Mes corto para el chip — ver leads-client.tsx para racional. */
const MES_SHORT: Readonly<Record<number, string>> = {
  1: 'ene', 2: 'feb', 3: 'mar', 4: 'abr', 5: 'may', 6: 'jun',
  7: 'jul', 8: 'ago', 9: 'sep', 10: 'oct', 11: 'nov', 12: 'dic',
};

type Totals = {
  gross: number;
  deductibles: number;
  net: number;
  /** Suma de adeudos pendientes (`total_amount - SUM(pagos exitosos)`)
   *  sobre los leads visibles en la vista filtrada actual. Va en la
   *  4ta card "Por cobrar". */
  outstanding: number;
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
  { value: 'contra_entrega', label: 'Contra entrega' },
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
  contra_entrega: 'Contra entrega',
};

export function PaymentsClient({
  leadGroups,
  total,
  page,
  pageSize,
  totalPages,
  filters,
  totals,
  pendingLeadCount,
  contraEntregaLeadIds,
  isAdmin,
}: {
  /** Filas agrupadas por lead — una entrada por lead con TODOS sus
   *  pagos pre-cargados. Reemplaza al viejo `payments: PaymentRow[]`
   *  que mostraba un row por pago. */
  leadGroups: LeadGroupRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  filters: FiltersState;
  totals: Totals;
  /** Cantidad de LEADS con adeudo pendiente (payment_status ≠ 'pagado').
   *  Lo usa el select "Con adeudo" para mostrar el badge contador. */
  pendingLeadCount: number;
  /** lead_ids con AL MENOS un payment_type='contra_entrega'. Lo
   *  convertimos a Set para lookup O(1) en la regla de color
   *  naranja (mismo patrón que en /leads). */
  contraEntregaLeadIds: string[];
  /** true si el usuario es admin/admin2 — habilita el botón Liquidar
   *  por fila. Falso para supervisor (que solo lee la tabla). */
  isAdmin: boolean;
}) {
  const contraEntregaSet = useMemo(
    () => new Set(contraEntregaLeadIds),
    [contraEntregaLeadIds],
  );
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  // Lightbox de evidencia abierto. Guardamos {src, alt} para mostrar
  // en el modal; null = cerrado.
  const [lightbox, setLightbox] = useState<
    { src: string; alt: string } | null
  >(null);

  // lead_id del modal de detalle por lead. null = modal cerrado. Al
  // hacer click en una fila se setea y el modal hace lookup contra
  // `leadGroups`.
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);

  // Lookup O(1) por lead_id para el modal — el array ya viene
  // agrupado y paginado desde el server.
  const groupsByLeadId = useMemo(() => {
    const map = new Map<string, LeadGroupRow>();
    for (const g of leadGroups) {
      map.set(g.lead_id, g);
    }
    return map;
  }, [leadGroups]);

  // Lazy init: leemos `filters.q` UNA SOLA VEZ al montar para
  // hidratar el input desde la URL. Después no re-sincronizamos —
  // el input es la única fuente de verdad mientras el usuario
  // escribe. Re-sincronizar desde `filters.q` revivía el texto
  // borrado en una race condition: entre el clear y el push
  // debounced, si el usuario cambiaba otro filtro (método, tipo,
  // etc.), `pushFilters` heredaba el viejo `filters.q` y volvía a
  // pintar el input con el valor previo.
  const [qInput, setQInput] = useState<string>(() => filters.q);

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
      method: string;
      type: string;
      page: number;
      mes: number;
      anio: number;
      adeudo: string;
    }>,
  ) {
    const merged = {
      // `q` defaultea al estado LOCAL del input (no a `filters.q` de la
      // URL). Sin esto, al cambiar otro filtro mientras el debounce
      // de q aún no ha disparado, mergeábamos la `q` vieja de la URL
      // y "resucitaba" el texto borrado en el input.
      q: next.q ?? qInput,
      method: next.method ?? filters.method,
      type: next.type ?? filters.type,
      page: next.page ?? page,
      // mes/anio se preservan al cambiar otros filtros — drill-down
      // desde dashboard mantiene su rango de mes hasta que el usuario
      // explícitamente "Limpiar filtros".
      mes: next.mes ?? filters.mes,
      anio: next.anio ?? filters.anio,
      adeudo: next.adeudo ?? filters.adeudo,
    };
    const params = new URLSearchParams();
    if (merged.q) params.set('q', merged.q);
    if (merged.method) params.set('method', merged.method);
    if (merged.type) params.set('type', merged.type);
    if (merged.adeudo) params.set('adeudo', merged.adeudo);
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

  const hasFilters = useMemo(
    () =>
      Boolean(
        filters.q ||
          filters.method ||
          filters.type ||
          filters.adeudo ||
          (filters.mes > 0 && filters.anio > 0),
      ),
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

      {/* Totals globales — 4 cards. La 4ta "Por cobrar" suma los
          adeudos pendientes de los leads visibles (no de TODA la BD)
          para que el contexto del filtro sea consistente. */}
      <div
        id="payments-totals"
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4"
      >
        <SummaryCard label="Cobrado bruto" value={formatMXN(totals.gross)} accent="#1E40AF" />
        <SummaryCard
          label="Deducibles"
          value={`- ${formatMXN(totals.deductibles)}`}
          accent="#B91C1C"
        />
        <SummaryCard label="Ingreso neto" value={formatMXN(totals.net)} accent="#15803D" />
        <SummaryCard
          label="💰 Por cobrar"
          value={formatMXN(totals.outstanding)}
          accent="#C2410C"
        />
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
              placeholder="Buscar por cliente o teléfono…"
              className="input"
              style={{
                paddingLeft: 36,
                paddingRight: qInput ? 36 : undefined,
              }}
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              aria-label="Buscar pagos"
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
                  pushFilters({ q: '', page: 1 });
                }}
                aria-label="Limpiar búsqueda"
                title="Limpiar búsqueda"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <select
            id="payments-filter-method"
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
          {/* Filtro por adeudo del LEAD asociado. La opción
              "Con adeudo" lleva el contador de leads pendientes en
              rojo para que sea obvio cuántos clientes deben. */}
          <select
            id="payments-filter-adeudo"
            className="select"
            value={filters.adeudo}
            onChange={(e) =>
              pushFilters({ adeudo: e.target.value, page: 1 })
            }
            aria-label="Filtrar por estado de adeudo"
            style={
              filters.adeudo === 'pendiente'
                ? { color: '#B91C1C', fontWeight: 600 }
                : undefined
            }
          >
            <option value="">Todos los adeudos</option>
            <option value="pendiente">
              🔴 Con adeudo pendiente
              {pendingLeadCount > 0 ? ` (${pendingLeadCount})` : ''}
            </option>
            <option value="liquidado">✅ Liquidados</option>
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
            {filters.adeudo === 'pendiente' && (
              <span
                className="text-xs"
                style={{
                  background: '#FEE2E2',
                  color: '#B91C1C',
                  padding: '4px 10px',
                  borderRadius: 9999,
                  fontWeight: 600,
                }}
              >
                🔴 Con adeudo{pendingLeadCount > 0 ? ` (${pendingLeadCount})` : ''}
              </span>
            )}
            {filters.adeudo === 'liquidado' && (
              <span
                className="text-xs"
                style={{
                  background: '#DCFCE7',
                  color: '#15803D',
                  padding: '4px 10px',
                  borderRadius: 9999,
                  fontWeight: 600,
                }}
              >
                ✅ Liquidados
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setQInput('');
                pushFilters({
                  q: '',
                  method: '',
                  type: '',
                  mes: 0,
                  anio: 0,
                  adeudo: '',
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

        {/* Leyenda de códigos de color — mismas reglas que /leads. */}
        <div className="mt-3">
          <LeadRowLegend />
        </div>
      </div>

      {/* Lightbox de evidencia (overlay fullscreen). Se monta solo
          cuando lightbox != null para no afectar accesibilidad
          cuando está cerrado. */}
      {lightbox && (
        <ImageLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}

      {/* Modal de detalle por lead. Se abre al hacer click en una
          fila; se cierra con Esc, click en overlay o el botón X
          interno. Las evidencias de la timeline reutilizan el mismo
          state del lightbox (se montan encima del drawer). */}
      {selectedLeadId &&
        (() => {
          const group = groupsByLeadId.get(selectedLeadId);
          if (!group) return null;
          return (
            <PaymentDetailModal
              leadId={selectedLeadId}
              clientName={group.client_name}
              totalAmount={group.total_amount}
              adeudo={group.adeudo}
              payments={group.payments}
              isAdmin={isAdmin}
              onClose={() => setSelectedLeadId(null)}
              onOpenEvidence={(src, alt) => setLightbox({ src, alt })}
            />
          );
        })()}

      {/* Tabla — una fila por LEAD agrupado. */}
      <div
        id="payments-table"
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
                <th>Monto cobrado</th>
                <th>Deducibles</th>
                <th>Neto</th>
                <th>Método</th>
                <th>Tipo</th>
                <th>Adeudo</th>
                <th>Fecha</th>
                <th className="text-center">Evidencia</th>
              </tr>
            </thead>
            <tbody>
              {leadGroups.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {hasFilters
                      ? 'Ningún pedido coincide con los filtros actuales.'
                      : 'Sin pedidos registrados.'}
                  </td>
                </tr>
              ) : (
                leadGroups.map((g) => (
                  <LeadGroupRowItem
                    key={g.lead_id}
                    group={g}
                    contraEntregaSet={contraEntregaSet}
                    isAdmin={isAdmin}
                    onOpenLead={() => setSelectedLeadId(g.lead_id)}
                  />
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
              {total === 1 ? 'pedido' : 'pedidos'}
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
 * Una fila de la tabla — UN lead agrupado con TODOS sus pagos.
 * Encapsula:
 *   - row style según las reglas de color del lead (mismas que /leads).
 *   - aggregates por lead (monto cobrado, deducibles, neto).
 *   - badges Método/Tipo, con valor "Varios" cuando hay mezcla de pagos.
 *   - prompt inline para liquidar el adeudo del lead.
 *   - badge "N pagos" junto al nombre cuando hay más de uno.
 *
 * NB: el botón "Editar pago" por fila se eliminó porque ya no apunta
 * a un pago único; quien quiera editar entra al modal con el click
 * en la fila y desde ahí navega al pago específico cuando se
 * implemente esa entrada.
 */
function LeadGroupRowItem({
  group: g,
  contraEntregaSet,
  isAdmin,
  onOpenLead,
}: {
  group: LeadGroupRow;
  contraEntregaSet: ReadonlySet<string>;
  isAdmin: boolean;
  onOpenLead: () => void;
}) {
  const router = useRouter();
  const [liqPending, startLiqTransition] = useTransition();
  const liqFileRef = useRef<HTMLInputElement>(null);
  const [showLiqPrompt, setShowLiqPrompt] = useState(false);
  const [liqMethod, setLiqMethod] = useState<PaymentRow['method']>('efectivo');
  const [liqError, setLiqError] = useState<string | null>(null);
  const [liqDone, setLiqDone] = useState(false);
  const [liqFile, setLiqFile] = useState<File | null>(null);
  const [liqPreview, setLiqPreview] = useState<string | null>(null);

  // Reglas de color del lead. Mismo shape mínimo que el caller previo.
  const rowStyle = getLeadRowStyle(
    {
      id: g.lead_id,
      row_color: g.lead_row_color,
      sale_type: g.lead_sale_type,
      product_type: g.lead_product_type,
      payment_status: g.lead_payment_status,
      delivery_status: g.lead_delivery_status,
    },
    contraEntregaSet,
  );

  // `liqDone` = optimismo post-liquidación: pinta "Liquidado" antes
  // del refresh. Importante: NO consultamos `lead_payment_status`
  // aquí — ese flag se ha visto desactualizado en producción y
  // contradice el monto real (caso Rosalía: status='pagado' pero
  // total $11,265 / pagado $8,865 / adeudo $2,400). La verdad
  // matemática es `adeudo = total - sum(pagos exitosos)`, que ya
  // viene calculada en `g.adeudo` desde page.tsx.
  const isLiquidated = liqDone || g.adeudo <= 0;

  const handleLiqFileChange = (file: File | null) => {
    if (liqPreview) {
      URL.revokeObjectURL(liqPreview);
      setLiqPreview(null);
    }
    if (!file) {
      setLiqFile(null);
      return;
    }
    setLiqError(null);
    if (file.size > 5 * 1024 * 1024) {
      setLiqError('La foto excede 5 MB.');
      setLiqFile(null);
      if (liqFileRef.current) liqFileRef.current.value = '';
      return;
    }
    if (!file.type.toLowerCase().startsWith('image/')) {
      setLiqError('Solo se aceptan imágenes (JPG, PNG, HEIC, etc.).');
      setLiqFile(null);
      if (liqFileRef.current) liqFileRef.current.value = '';
      return;
    }
    setLiqFile(file);
    setLiqPreview(URL.createObjectURL(file));
  };

  const handleConfirmLiquidate = () => {
    setLiqError(null);
    const photoCheck = validatePhotoFile(liqFile);
    if (!photoCheck.ok) {
      setLiqError(`Foto del comprobante: ${photoCheck.message}`);
      return;
    }
    const fd = new FormData();
    fd.set('lead_id', g.lead_id);
    fd.set('payment_method', liqMethod);
    if (liqFile) fd.set('evidence', liqFile);
    startLiqTransition(async () => {
      try {
        const result = await liquidateLeadAction({ status: 'idle' }, fd);
        if (result.status === 'success') {
          setLiqDone(true);
          setShowLiqPrompt(false);
          if (liqPreview) {
            URL.revokeObjectURL(liqPreview);
            setLiqPreview(null);
          }
          setLiqFile(null);
          router.refresh();
        } else if (result.status === 'error') {
          setLiqError(result.message);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error de red';
        setLiqError(msg);
      }
    });
  };

  return (
    <tr
      style={{ ...rowStyle, cursor: 'pointer' }}
      onClick={onOpenLead}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpenLead();
        }
      }}
      title="Ver todos los pagos de este lead"
    >
      <td data-label="Cliente">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="font-medium">{g.client_name}</div>
          {!isLiquidated && (
            <span
              className="text-[10px] font-semibold"
              style={{
                padding: '1px 6px',
                borderRadius: 9999,
                background: '#FEE2E2',
                color: '#991B1B',
              }}
              title={`Adeudo pendiente: ${formatMXN(g.adeudo)}`}
            >
              ⚠️ Adeudo
            </span>
          )}
          {g.payments_count > 1 && (
            <span
              className="text-[10px] font-semibold"
              style={{
                padding: '1px 6px',
                borderRadius: 9999,
                background: '#DBEAFE',
                color: '#1E40AF',
              }}
              title={`${g.payments_count} pagos registrados — abre para ver el desglose`}
            >
              {g.payments_count} pagos
            </span>
          )}
        </div>
        <div
          className="text-xs font-mono"
          style={{ color: 'var(--text-tertiary)' }}
        >
          #{g.lead_id.slice(0, 8)}
        </div>
      </td>
      <td data-label="Monto cobrado" className="font-semibold">
        {formatMXN(g.monto_cobrado_total)}
      </td>
      <td data-label="Deducibles">
        {g.deducibles_total === 0 ? (
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            —
          </span>
        ) : (
          <div style={{ color: 'var(--danger)', fontWeight: 600 }}>
            -{formatMXN(g.deducibles_total)}
          </div>
        )}
      </td>
      <td
        data-label="Neto"
        className="font-semibold"
        style={{ color: 'var(--success)' }}
      >
        {formatMXN(g.neto_total)}
      </td>
      <td data-label="Método">
        {g.ultimo_metodo === 'varios' ? (
          <VariosBadge />
        ) : (
          <MethodBadge method={METHOD_TO_BADGE[g.ultimo_metodo]} />
        )}
      </td>
      <td data-label="Tipo">
        {g.ultimo_tipo === 'varios' ? (
          <VariosBadge />
        ) : (
          <TypeBadge type={TYPE_TO_BADGE[g.ultimo_tipo]} />
        )}
      </td>
      <td
        data-label="Adeudo"
        onClick={(e) => {
          // Cualquier interacción dentro de "Adeudo" (botón Liquidar
          // o prompt expandido) NO debe abrir el modal de detalle.
          e.stopPropagation();
        }}
      >
        {isLiquidated ? (
          <span className="badge badge-success">✓ Liquidado</span>
        ) : showLiqPrompt ? (
          <div className="flex flex-col items-end gap-1.5">
            <div
              className="text-xs"
              style={{ color: 'var(--text-secondary)' }}
            >
              Liquidar <strong>{formatMXN(g.adeudo)}</strong>
            </div>
            <select
              value={liqMethod}
              onChange={(e) => {
                setLiqMethod(e.target.value as PaymentRow['method']);
                setLiqError(null);
              }}
              disabled={liqPending}
              className="select"
              style={{ padding: '4px 8px', fontSize: '0.75rem' }}
              aria-label="Método de pago para liquidación"
            >
              <option value="efectivo">Efectivo</option>
              <option value="transferencia">Transferencia</option>
              <option value="clip">Clip</option>
            </select>

            {/* Evidencia fotográfica del comprobante. Requerida cuando
                método es transferencia o Clip (sin evidencia visual
                no podemos auditar). Para efectivo es opcional. */}
            <div
              className="flex flex-col items-end gap-1"
              style={{ width: '100%' }}
            >
              <label
                className="text-xs"
                style={{
                  color: 'var(--text-secondary)',
                  fontWeight: 500,
                }}
              >
                Foto del comprobante
                <span style={{ color: '#DC2626' }}> * (obligatoria)</span>
              </label>
              <input
                ref={liqFileRef}
                type="file"
                accept={PHOTO_ACCEPT_ATTR}
                capture="environment"
                onChange={(e) =>
                  handleLiqFileChange(e.target.files?.[0] ?? null)
                }
                disabled={liqPending}
                className="text-xs"
                style={{ fontSize: '0.75rem', maxWidth: '100%' }}
              />
              {liqPreview && (
                <div className="flex items-center gap-2 mt-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={liqPreview}
                    alt="Previsualización del comprobante"
                    style={{
                      width: 64,
                      height: 64,
                      objectFit: 'cover',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => handleLiqFileChange(null)}
                    disabled={liqPending}
                    className="btn btn-ghost"
                    style={{ padding: '4px 6px', fontSize: '0.6875rem' }}
                    aria-label="Quitar foto"
                  >
                    <X size={12} /> Quitar
                  </button>
                </div>
              )}
            </div>

            {liqError && (
              <span
                role="alert"
                className="text-xs"
                style={{ color: 'var(--danger, #dc2626)' }}
              >
                {liqError}
              </span>
            )}
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="btn"
                style={{
                  padding: '4px 10px',
                  fontSize: '0.75rem',
                  background: '#16A34A',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                }}
                onClick={handleConfirmLiquidate}
                disabled={liqPending || !liqFile || liqFile.size === 0}
                title={
                  !liqFile && !liqPending
                    ? 'Sube la foto del comprobante para continuar'
                    : undefined
                }
              >
                {liqPending ? (
                  <>
                    <Loader size={12} className="animate-spin" />
                    <span style={{ marginLeft: 4 }}>Liquidando…</span>
                  </>
                ) : (
                  'Confirmar'
                )}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ padding: '4px 8px', fontSize: '0.75rem' }}
                onClick={() => {
                  setShowLiqPrompt(false);
                  setLiqError(null);
                }}
                disabled={liqPending}
              >
                <X size={12} />
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-end gap-1">
            <div
              className="text-xs"
              style={{ color: 'var(--danger, #B91C1C)', fontWeight: 600 }}
            >
              {formatMXN(g.adeudo)} pendiente
            </div>
            {/* En la vista agrupada permitimos Liquidar siempre que
                haya adeudo > 0 y el viewer sea admin/admin2. Antes
                gateábamos por payment_type='anticipo' del row, pero
                ahora la fila es un lead — no un pago — así que la
                regla relevante es solo "¿queda adeudo?". */}
            {isAdmin && (
              <button
                type="button"
                onClick={() => {
                  setLiqError(null);
                  setShowLiqPrompt(true);
                }}
                className="btn"
                style={{
                  padding: '4px 10px',
                  fontSize: '0.75rem',
                  background: '#16A34A',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
                aria-label={`Liquidar adeudo de ${g.client_name}`}
                title={`Liquidar ${formatMXN(g.adeudo)} restantes`}
              >
                <CircleCheckBig size={12} /> Liquidar
              </button>
            )}
          </div>
        )}
      </td>
      <td
        data-label="Fecha"
        className="text-sm"
        style={{ color: 'var(--text-secondary)' }}
      >
        {formatDate(g.ultima_fecha)}
      </td>
      <td data-label="Evidencia" className="text-center">
        {g.tiene_evidencia ? (
          <Camera
            size={16}
            style={{ color: 'var(--brand-secondary)' }}
            aria-label={`Hay evidencia adjunta en pagos de ${g.client_name}`}
          />
        ) : (
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            —
          </span>
        )}
      </td>
    </tr>
  );
}

/**
 * Badge gris pill "Varios" para Método/Tipo cuando el lead tiene
 * mezcla de pagos. Visualmente neutral para no competir con los
 * `<MethodBadge>` / `<TypeBadge>` cuando sí hay un valor único.
 */
function VariosBadge() {
  return (
    <span
      className="text-xs"
      style={{
        padding: '2px 8px',
        borderRadius: 9999,
        background: 'var(--bg-subtle)',
        color: 'var(--text-secondary)',
        fontWeight: 600,
      }}
    >
      Varios
    </span>
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

// `formatDate` ahora reusa el shared `formatDateCDMX` para fijar TZ
// México y soportar fechas-puras (YYYY-MM-DD) sin shifts de UTC.
const formatDate = formatDateCDMX;

/**
 * Drawer lateral derecho con el detalle de TODOS los pagos del lead
 * seleccionado: timeline ordenada del más viejo al más nuevo,
 * resumen al pie con total/pagado/adeudo, y botón "Liquidar" inline
 * cuando aún hay saldo pendiente.
 *
 * Se cierra con Escape, click en el overlay o el botón X del header.
 * Las evidencias se abren con el mismo `ImageLightbox` del padre (el
 * lightbox se monta a nivel raíz para que aparezca encima del drawer).
 */
function PaymentDetailModal({
  leadId,
  clientName,
  totalAmount,
  adeudo,
  payments,
  isAdmin,
  onClose,
  onOpenEvidence,
}: {
  leadId: string;
  clientName: string;
  totalAmount: number;
  adeudo: number;
  payments: PaymentRow[];
  isAdmin: boolean;
  onClose: () => void;
  onOpenEvidence: (src: string, alt: string) => void;
}) {
  const router = useRouter();
  // Timeline ordenada por paid_at ASC. Pagos sin fecha (legacy) caen
  // al final con string vacío.
  const timeline = useMemo(
    () =>
      [...payments].sort((a, b) =>
        (a.paid_at ?? '').localeCompare(b.paid_at ?? ''),
      ),
    [payments],
  );
  const totalPagadoExitoso = payments
    .filter((p) => p.status === 'exitoso')
    .reduce((s, p) => s + p.amount, 0);

  // Cierre con Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Inline liquidar — mismo flujo que la fila (puede liquidar lead
  // entero desde aquí). Visible solo cuando adeudo > 0 y el viewer
  // es admin/admin2.
  const [liqOpen, setLiqOpen] = useState(false);
  const [liqMethod, setLiqMethod] = useState<PaymentRow['method']>('efectivo');
  const [liqFile, setLiqFile] = useState<File | null>(null);
  const [liqError, setLiqError] = useState<string | null>(null);
  const [liqPending, startLiqTransition] = useTransition();
  const liqFileRef = useRef<HTMLInputElement>(null);

  // Form de "+ Agregar pago" inline. Mismo flujo de cobro que
  // `/payments/new` reutilizando `addPaymentToLeadAction`. Visible
  // solo para admin/admin2. Default del monto = adeudo actual; el
  // usuario puede sobreescribir si solo pone un anticipo parcial.
  const [addOpen, setAddOpen] = useState(false);
  const [addAmount, setAddAmount] = useState<string>(
    adeudo > 0 ? String(adeudo) : '',
  );
  const [addMethod, setAddMethod] =
    useState<PaymentRow['method']>('efectivo');
  const [addType, setAddType] = useState<PaymentRow['payment_type']>(
    adeudo > 0 ? 'liquidacion' : 'anticipo',
  );
  const [addFile, setAddFile] = useState<File | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [addPending, startAddTransition] = useTransition();
  const addFileRef = useRef<HTMLInputElement>(null);

  function resetAddForm() {
    setAddOpen(false);
    setAddError(null);
    setAddFile(null);
    if (addFileRef.current) addFileRef.current.value = '';
  }

  function handleAddPayment() {
    setAddError(null);
    const amountNum = Number(addAmount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setAddError('Ingresa un monto válido mayor a 0.');
      return;
    }
    const photoCheck = validatePhotoFile(addFile);
    if (!photoCheck.ok) {
      setAddError(`Foto del comprobante: ${photoCheck.message}`);
      return;
    }
    const fd = new FormData();
    fd.set('lead_id', leadId);
    fd.set('amount', String(amountNum));
    fd.set('method', addMethod);
    fd.set('payment_type', addType);
    if (addFile) fd.set('evidence', addFile);
    startAddTransition(async () => {
      try {
        const result = await addPaymentToLeadAction(
          { status: 'idle' },
          fd,
        );
        if (result.status === 'success') {
          // El modal sigue abierto (el padre conserva selectedLeadId).
          // router.refresh() recarga los pagos del lead → la timeline
          // mostrará el nuevo pago y el adeudo se actualizará solo.
          resetAddForm();
          router.refresh();
        } else if (result.status === 'error') {
          setAddError(result.message);
        }
      } catch (err) {
        setAddError(err instanceof Error ? err.message : 'Error de red');
      }
    });
  }

  function handleConfirmLiquidate() {
    setLiqError(null);
    const photoCheck = validatePhotoFile(liqFile);
    if (!photoCheck.ok) {
      setLiqError(`Foto del comprobante: ${photoCheck.message}`);
      return;
    }
    const fd = new FormData();
    fd.set('lead_id', leadId);
    fd.set('payment_method', liqMethod);
    if (liqFile) fd.set('evidence', liqFile);
    startLiqTransition(async () => {
      try {
        const result = await liquidateLeadAction({ status: 'idle' }, fd);
        if (result.status === 'success') {
          router.refresh();
          onClose();
        } else if (result.status === 'error') {
          setLiqError(result.message);
        }
      } catch (err) {
        setLiqError(err instanceof Error ? err.message : 'Error de red');
      }
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex"
      style={{ background: 'rgba(15,23,42,0.45)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="payment-detail-title"
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
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2
              id="payment-detail-title"
              className="text-xl font-bold leading-tight"
              style={{ color: 'var(--text-primary)' }}
            >
              {clientName}
            </h2>
            <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
              {payments.length}{' '}
              {payments.length === 1 ? 'pago registrado' : 'pagos registrados'}
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

        {/* Totales superiores */}
        <div
          className="grid grid-cols-2 gap-3 mb-5"
          style={{
            background: 'var(--bg-subtle)',
            borderRadius: 8,
            padding: 12,
          }}
        >
          <div>
            <div
              className="text-[11px] uppercase"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Total del pedido
            </div>
            <div className="font-bold text-lg">{formatMXN(totalAmount)}</div>
          </div>
          <div>
            <div
              className="text-[11px] uppercase"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Adeudo
            </div>
            {adeudo > 0 ? (
              <div
                className="font-bold text-lg"
                style={{ color: 'var(--danger, #B91C1C)' }}
              >
                {formatMXN(adeudo)}
              </div>
            ) : (
              <div
                className="font-bold text-lg"
                style={{ color: 'var(--success, #15803D)' }}
              >
                ✓ Liquidado
              </div>
            )}
          </div>
        </div>

        {/* Timeline */}
        <div className="flex flex-col gap-3 mb-5">
          {timeline.map((p) => (
            <div
              key={p.id}
              className="card p-3"
              style={{ background: 'var(--bg-base, #fff)' }}
            >
              <div
                className="text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {formatDateTimeCDMX(p.paid_at)}
              </div>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <strong
                  className="text-base"
                  style={{ color: 'var(--success, #15803D)' }}
                >
                  {formatMXN(p.amount)}
                </strong>
                <MethodBadge method={METHOD_TO_BADGE[p.method]} />
                <TypeBadge type={TYPE_TO_BADGE[p.payment_type]} />
              </div>
              {p.deductibles.length > 0 && (
                <div
                  className="text-[11px] mt-1"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Deducibles:{' '}
                  {p.deductibles
                    .map((d) => `${d.concept} (-${formatMXN(d.amount)})`)
                    .join(', ')}
                </div>
              )}
              <div
                className="text-[11px] mt-1 flex items-center justify-between gap-2 flex-wrap"
                style={{ color: 'var(--text-secondary)' }}
              >
                <span>
                  Estado: <strong>{p.status}</strong>
                  {p.registered_by_name
                    ? ` · Registró: ${p.registered_by_name}`
                    : ''}
                </span>
                {p.evidence_photo_url && (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenEvidence(
                        p.evidence_photo_url as string,
                        `Evidencia del pago de ${clientName}`,
                      )
                    }
                    className="btn btn-ghost"
                    style={{
                      padding: '2px 8px',
                      fontSize: '0.6875rem',
                      color: 'var(--brand-secondary)',
                    }}
                  >
                    📷 Ver evidencia
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* "+ Agregar pago" inline — admin/admin2 only. Compatible
            con el flujo de /payments/new: misma server action, mismo
            efecto de cobro (registra payment, alimenta admin_cash_register
            si es efectivo, recalcula payment_status del lead).
            Cuando el lead ya está liquidado mostramos un mensaje
            informativo en su lugar; el server action revalida igual
            esta condición por defensa en profundidad. */}
        {isAdmin && adeudo <= 0 && (
          <div
            className="mb-5 text-xs flex items-center gap-1.5"
            style={{ color: 'var(--success, #15803D)' }}
            role="status"
          >
            <CircleCheckBig size={14} />
            <span>
              Este pedido ya está liquidado — no se pueden agregar más
              pagos.
            </span>
          </div>
        )}
        {isAdmin && adeudo > 0 && (
          <div className="mb-5">
            {!addOpen ? (
              <button
                type="button"
                className="btn w-full"
                style={{
                  background: 'var(--brand-primary, #1B3A5C)',
                  color: '#fff',
                  padding: '10px 16px',
                  fontWeight: 600,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
                onClick={() => setAddOpen(true)}
              >
                + Agregar pago
              </button>
            ) : (
              <div
                className="card p-3 flex flex-col gap-2"
                style={{
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border)',
                }}
              >
                <div className="font-semibold text-sm">
                  Nuevo pago para {clientName}
                </div>
                <label
                  className="text-xs"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Monto
                </label>
                <input
                  type="number"
                  className="input"
                  value={addAmount}
                  onChange={(e) => setAddAmount(e.target.value)}
                  min={0}
                  step="0.01"
                  disabled={addPending}
                />
                {adeudo > 0 && (
                  <div
                    className="text-[11px]"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Adeudo actual: {formatMXN(adeudo)}
                  </div>
                )}
                <label
                  className="text-xs"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Método de pago
                </label>
                <select
                  value={addMethod}
                  onChange={(e) =>
                    setAddMethod(e.target.value as PaymentRow['method'])
                  }
                  disabled={addPending}
                  className="select"
                >
                  <option value="efectivo">Efectivo</option>
                  <option value="transferencia">Transferencia</option>
                  <option value="clip">Clip</option>
                </select>
                <label
                  className="text-xs"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Tipo de pago
                </label>
                <select
                  value={addType}
                  onChange={(e) =>
                    setAddType(
                      e.target.value as PaymentRow['payment_type'],
                    )
                  }
                  disabled={addPending}
                  className="select"
                >
                  <option value="anticipo">Anticipo</option>
                  <option value="liquidacion">Liquidación</option>
                  <option value="contra_entrega">Contra entrega</option>
                </select>
                <label
                  className="text-xs"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Foto del comprobante{' '}
                  <span style={{ color: '#DC2626' }}>* obligatoria</span>
                </label>
                <input
                  ref={addFileRef}
                  type="file"
                  accept={PHOTO_ACCEPT_ATTR}
                  onChange={(e) => setAddFile(e.target.files?.[0] ?? null)}
                  disabled={addPending}
                />
                {addError && (
                  <div
                    role="alert"
                    className="text-xs"
                    style={{ color: 'var(--danger, #dc2626)' }}
                  >
                    {addError}
                  </div>
                )}
                <div className="flex gap-2 mt-1">
                  <button
                    type="button"
                    className="btn btn-outline flex-1"
                    onClick={resetAddForm}
                    disabled={addPending}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="btn flex-1"
                    style={{
                      background: 'var(--brand-primary, #1B3A5C)',
                      color: '#fff',
                      fontWeight: 600,
                    }}
                    onClick={handleAddPayment}
                    disabled={addPending || !addFile}
                  >
                    {addPending ? (
                      <>
                        <Loader size={14} className="animate-spin" />
                        <span style={{ marginLeft: 6 }}>Guardando…</span>
                      </>
                    ) : (
                      'Guardar pago'
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Resumen al pie */}
        <div
          className="pt-3 mt-2"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <div className="flex items-center justify-between text-sm py-1">
            <span style={{ color: 'var(--text-tertiary)' }}>
              Total pagado:
            </span>
            <strong style={{ color: 'var(--success, #15803D)' }}>
              {formatMXN(totalPagadoExitoso)}
            </strong>
          </div>
          <div className="flex items-center justify-between text-sm py-1">
            <span style={{ color: 'var(--text-tertiary)' }}>
              Adeudo restante:
            </span>
            <strong
              style={{
                color:
                  adeudo > 0
                    ? 'var(--danger, #B91C1C)'
                    : 'var(--success, #15803D)',
              }}
            >
              {adeudo > 0 ? formatMXN(adeudo) : 'Liquidado'}
            </strong>
          </div>

          {/* Liquidar inline — mismo action que la fila. Sólo admin. */}
          {adeudo > 0 && isAdmin && (
            <div className="mt-4">
              {!liqOpen ? (
                <button
                  type="button"
                  className="btn w-full"
                  style={{
                    background: '#16A34A',
                    color: '#fff',
                    padding: '10px 16px',
                    fontWeight: 600,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                  onClick={() => setLiqOpen(true)}
                >
                  <CircleCheckBig size={16} /> Liquidar {formatMXN(adeudo)}
                </button>
              ) : (
                <div className="flex flex-col gap-2">
                  <label
                    className="text-xs"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Método de pago
                  </label>
                  <select
                    value={liqMethod}
                    onChange={(e) =>
                      setLiqMethod(e.target.value as PaymentRow['method'])
                    }
                    disabled={liqPending}
                    className="select"
                  >
                    <option value="efectivo">Efectivo</option>
                    <option value="transferencia">Transferencia</option>
                    <option value="clip">Clip</option>
                  </select>
                  <label
                    className="text-xs"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Foto del comprobante{' '}
                    <span style={{ color: '#DC2626' }}>* obligatoria</span>
                  </label>
                  <input
                    ref={liqFileRef}
                    type="file"
                    accept={PHOTO_ACCEPT_ATTR}
                    onChange={(e) => setLiqFile(e.target.files?.[0] ?? null)}
                    disabled={liqPending}
                  />
                  {liqError && (
                    <div
                      role="alert"
                      className="text-xs"
                      style={{ color: 'var(--danger, #dc2626)' }}
                    >
                      {liqError}
                    </div>
                  )}
                  <div className="flex gap-2 mt-1">
                    <button
                      type="button"
                      className="btn btn-outline flex-1"
                      onClick={() => {
                        setLiqOpen(false);
                        setLiqError(null);
                        setLiqFile(null);
                        if (liqFileRef.current) liqFileRef.current.value = '';
                      }}
                      disabled={liqPending}
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      className="btn flex-1"
                      style={{
                        background: '#16A34A',
                        color: '#fff',
                        fontWeight: 600,
                      }}
                      onClick={handleConfirmLiquidate}
                      disabled={liqPending || !liqFile}
                    >
                      {liqPending ? (
                        <>
                          <Loader size={14} className="animate-spin" />
                          <span style={{ marginLeft: 6 }}>Liquidando…</span>
                        </>
                      ) : (
                        'Confirmar liquidación'
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
