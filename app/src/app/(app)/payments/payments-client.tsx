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
import {
  getLeadRowStyle,
  LeadRowLegend,
} from '@/components/ui/lead-row-color';
import { liquidateLeadAction } from './actions';

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
};

type FiltersState = {
  q: string;
  method: '' | 'efectivo' | 'transferencia' | 'clip';
  type: '' | 'anticipo' | 'liquidacion' | 'contra_entrega';
  /** Mes 1-12; 0 = sin filtro. Pareja inseparable con `anio`. */
  mes: number;
  /** Año 4-dígitos; 0 = sin filtro. */
  anio: number;
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
  payments,
  total,
  page,
  pageSize,
  totalPages,
  filters,
  totals,
  contraEntregaLeadIds,
}: {
  payments: PaymentRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  filters: FiltersState;
  totals: Totals;
  /** lead_ids con AL MENOS un payment_type='contra_entrega'. Lo
   *  convertimos a Set para lookup O(1) en la regla de color
   *  naranja (mismo patrón que en /leads). */
  contraEntregaLeadIds: string[];
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
    next: Partial<{
      q: string;
      method: string;
      type: string;
      page: number;
      mes: number;
      anio: number;
    }>,
  ) {
    const merged = {
      q: next.q ?? filters.q,
      method: next.method ?? filters.method,
      type: next.type ?? filters.type,
      page: next.page ?? page,
      // mes/anio se preservan al cambiar otros filtros — drill-down
      // desde dashboard mantiene su rango de mes hasta que el usuario
      // explícitamente "Limpiar filtros".
      mes: next.mes ?? filters.mes,
      anio: next.anio ?? filters.anio,
    };
    const params = new URLSearchParams();
    if (merged.q) params.set('q', merged.q);
    if (merged.method) params.set('method', merged.method);
    if (merged.type) params.set('type', merged.type);
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

      {/* Totals globales */}
      <div id="payments-totals" className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                  method: '',
                  type: '',
                  mes: 0,
                  anio: 0,
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

      {/* Tabla */}
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
              {payments.length === 0 ? (
                <tr>
                  <td
                    colSpan={9}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {hasFilters
                      ? 'Ningún pago coincide con los filtros actuales.'
                      : 'Sin pagos registrados.'}
                  </td>
                </tr>
              ) : (
                payments.map((p) => (
                  <PaymentRowItem
                    key={p.id}
                    payment={p}
                    contraEntregaSet={contraEntregaSet}
                    onOpenEvidence={() =>
                      p.evidence_photo_url &&
                      setLightbox({
                        src: p.evidence_photo_url,
                        alt: `Evidencia del pago de ${p.client_name}`,
                      })
                    }
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

/**
 * Una fila de la tabla de pagos. Encapsula:
 *   - row style según las reglas de color del lead (mismas que /leads).
 *   - render del adeudo restante del LEAD + badge "Liquidado" o
 *     prompt inline para liquidar.
 *   - confirmación inline del método de pago para la liquidación
 *     (sin modal, para no tapar el resto de la tabla).
 */
function PaymentRowItem({
  payment: p,
  contraEntregaSet,
  onOpenEvidence,
}: {
  payment: PaymentRow;
  contraEntregaSet: ReadonlySet<string>;
  onOpenEvidence: () => void;
}) {
  const router = useRouter();
  const [liqPending, startLiqTransition] = useTransition();
  const liqFileRef = useRef<HTMLInputElement>(null);
  // null = ningún prompt visible; un valor = método seleccionado en
  // el prompt inline antes de confirmar.
  const [showLiqPrompt, setShowLiqPrompt] = useState(false);
  const [liqMethod, setLiqMethod] = useState<PaymentRow['method']>('efectivo');
  const [liqError, setLiqError] = useState<string | null>(null);
  const [liqDone, setLiqDone] = useState(false);
  // Evidencia: archivo seleccionado + URL de preview (object URL).
  const [liqFile, setLiqFile] = useState<File | null>(null);
  const [liqPreview, setLiqPreview] = useState<string | null>(null);
  const liqEvidenceRequired =
    liqMethod === 'transferencia' || liqMethod === 'clip';

  const ded = p.deductibles.reduce((a, d) => a + d.amount, 0);

  // Reglas de color del lead. Usamos un shape mínimo compatible con
  // getLeadRowStyle: solo necesita los flags semánticos del lead.
  const rowStyle = getLeadRowStyle(
    {
      id: p.lead_id,
      row_color: p.lead_row_color,
      sale_type: p.lead_sale_type,
      product_type: p.lead_product_type,
      payment_status: p.lead_payment_status,
      delivery_status: p.lead_delivery_status,
    },
    contraEntregaSet,
  );

  // Estado del adeudo del LEAD asociado a este pago. `liqDone` es
  // optimismo post-liquidación: pinta "Liquidado" inmediatamente.
  const isLiquidated =
    liqDone || p.adeudo <= 0 || p.lead_payment_status === 'pagado';

  const handleLiqFileChange = (file: File | null) => {
    // Limpia preview anterior (libera el object URL).
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
    // Validación cliente — el server también la enforces.
    if (liqEvidenceRequired && !liqFile) {
      setLiqError(
        'Foto del comprobante requerida para transferencias y Clip.',
      );
      return;
    }
    const fd = new FormData();
    fd.set('lead_id', p.lead_id);
    fd.set('payment_method', liqMethod);
    if (liqFile) fd.set('evidence', liqFile);
    startLiqTransition(async () => {
      try {
        const result = await liquidateLeadAction({ status: 'idle' }, fd);
        if (result.status === 'success') {
          setLiqDone(true);
          setShowLiqPrompt(false);
          // Liberar preview tras submit exitoso — el lead ya está
          // liquidado, el state se va a desmontar pronto.
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
    <tr style={rowStyle}>
      <td data-label="Cliente">
        <div className="font-medium">{p.client_name}</div>
        <div
          className="text-xs font-mono"
          style={{ color: 'var(--text-tertiary)' }}
        >
          #{p.id.slice(0, 8)}
        </div>
      </td>
      <td data-label="Monto" className="font-semibold">
        {formatMXN(p.amount)}
      </td>
      <td data-label="Deducibles">
        {ded === 0 ? (
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
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
        data-label="Neto"
        className="font-semibold"
        style={{ color: 'var(--success)' }}
      >
        {formatMXN(p.net_amount)}
      </td>
      <td data-label="Método">
        <MethodBadge method={METHOD_TO_BADGE[p.method]} />
      </td>
      <td data-label="Tipo">
        <TypeBadge type={TYPE_TO_BADGE[p.payment_type]} />
      </td>
      <td data-label="Adeudo">
        {isLiquidated ? (
          <span className="badge badge-success">✓ Liquidado</span>
        ) : showLiqPrompt ? (
          <div className="flex flex-col items-end gap-1.5">
            <div
              className="text-xs"
              style={{ color: 'var(--text-secondary)' }}
            >
              Liquidar <strong>{formatMXN(p.adeudo)}</strong>
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
                {liqEvidenceRequired ? (
                  <span style={{ color: '#DC2626' }}> *</span>
                ) : (
                  <span style={{ color: 'var(--text-tertiary)' }}> (opcional)</span>
                )}
              </label>
              <input
                ref={liqFileRef}
                type="file"
                accept="image/*"
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
                disabled={liqPending}
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
              {formatMXN(p.adeudo)} pendiente
            </div>
            {/* Solo permitimos liquidar desde rows de tipo anticipo —
                liquidación y contra_entrega no deben volver a generar
                otra liquidación. */}
            {p.payment_type === 'anticipo' && (
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
                aria-label={`Liquidar adeudo de ${p.client_name}`}
                title={`Liquidar ${formatMXN(p.adeudo)} restantes`}
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
        {formatDate(p.paid_at)}
      </td>
      <td data-label="Evidencia" className="text-center">
        {p.evidence_photo_url ? (
          <button
            type="button"
            onClick={onOpenEvidence}
            className="btn btn-ghost"
            style={{ padding: 6, color: 'var(--brand-secondary)' }}
            aria-label={`Ver evidencia del pago de ${p.client_name}`}
            title="Ver foto del cobro"
          >
            <Camera size={16} />
          </button>
        ) : (
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            —
          </span>
        )}
      </td>
    </tr>
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
