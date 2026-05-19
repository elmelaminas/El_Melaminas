'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, useTransition } from 'react';
import {
  ArrowLeft,
  Plus,
  X,
  Camera,
  Upload,
  Loader,
  Trash2,
} from 'lucide-react';
import { formatMXN } from '@/data/mock';
import {
  METHOD_OPTIONS,
  PAYMENT_TYPE_OPTIONS,
  type DeductibleInput,
} from '../../new/schema';
import { updatePaymentAction } from './actions';

/**
 * Detalle precargado del pago que se está editando. Pasado desde el
 * Server Component (page.tsx) tras resolver el lead asociado y firmar
 * la URL de evidencia.
 */
export type PaymentDetail = {
  id: string;
  lead_id: string;
  client_name: string;
  lead_total: number;
  amount: number;
  net_amount: number;
  method: 'efectivo' | 'transferencia' | 'clip';
  payment_type: 'anticipo' | 'liquidacion' | 'contra_entrega';
  status: 'exitoso' | 'pendiente' | 'rechazado';
  /** URL firmada (1h TTL) o null si el pago no tiene evidencia. */
  evidence_photo_url: string | null;
  /** ISO timestamp de cuando se cobró. Readonly en el form. */
  paid_at: string | null;
  deductibles: { id: string | number; concept: string; amount: number }[];
};

/**
 * Formulario de edición de pago.
 *
 * Mismo layout y patrón que `new-payment-form.tsx` (estado local sin
 * RHF + submit con FormData), pero con campos READONLY para los datos
 * inmutables (cliente, fecha, lead_id) y deducibles precargados.
 *
 * Evidencia: si el pago ya tiene foto, el dropzone muestra el thumbnail
 * con dos acciones — "Reemplazar" (selecciona nuevo archivo) y
 * "Quitar" (marca remove_evidence=1). Si el usuario reemplaza, el
 * action sube el nuevo y limpia el blob viejo después del UPDATE.
 */
export function EditPaymentForm({ detail }: { detail: PaymentDetail }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [amount, setAmount] = useState<number>(detail.amount);
  const [method, setMethod] = useState<PaymentDetail['method']>(detail.method);
  const [paymentType, setPaymentType] = useState<PaymentDetail['payment_type']>(
    detail.payment_type,
  );
  // Mantenemos un `localId` numérico para keys/manipulación; las filas
  // que vienen de DB usan su id real (string), las nuevas usan
  // `Date.now()` (number). El action ignora ambos y solo respeta
  // concept + amount.
  const [deductibles, setDeductibles] = useState<
    (DeductibleInput & { localId: string | number })[]
  >(
    detail.deductibles.map((d) => ({
      localId: d.id,
      concept: d.concept,
      amount: d.amount,
    })),
  );
  // null = sin cambio respecto a `detail.evidence_photo_url`.
  // File = nueva foto seleccionada (sube y reemplaza la actual).
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  // true cuando el usuario pidió quitar la foto actual sin subir una
  // nueva — el action setea evidence_photo_url = null.
  const [removeEvidence, setRemoveEvidence] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const totalDed = useMemo(
    () =>
      deductibles.reduce(
        (s, d) => s + (Number.isFinite(d.amount) ? Number(d.amount) : 0),
        0,
      ),
    [deductibles],
  );
  const net = Math.max(amount - totalDed, 0);

  const addDed = () =>
    setDeductibles((prev) => [
      ...prev,
      { localId: Date.now(), concept: '', amount: 0 },
    ]);
  const removeDed = (id: string | number) =>
    setDeductibles((prev) => prev.filter((d) => d.localId !== id));
  const updateDed = (
    id: string | number,
    patch: Partial<DeductibleInput>,
  ) =>
    setDeductibles((prev) =>
      prev.map((d) => (d.localId === id ? { ...d, ...patch } : d)),
    );

  const evidenceRequired = method === 'transferencia' || method === 'clip';
  const hasExistingEvidence = Boolean(
    detail.evidence_photo_url && !removeEvidence,
  );
  // Para el badge "requerida": la evidencia falta sólo cuando es
  // requerida Y no hay foto actual (preservada) Y no se subió una nueva.
  const evidenceMissing =
    evidenceRequired && !hasExistingEvidence && !evidenceFile;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (f) {
      setEvidenceFile(f);
      setRemoveEvidence(false); // si subió nueva, ya no aplica "quitar"
    }
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!Number.isFinite(amount) || amount <= 0) {
      setError('El monto debe ser mayor a 0.');
      return;
    }
    if (evidenceMissing) {
      setError(
        `La evidencia es obligatoria para método ${
          method === 'transferencia' ? 'Transferencia' : 'Clip'
        }.`,
      );
      return;
    }

    const fd = new FormData();
    fd.set('amount', String(amount));
    fd.set('method', method);
    fd.set('payment_type', paymentType);
    fd.set(
      'deductibles_json',
      JSON.stringify(
        deductibles
          .filter(
            (d) =>
              d.concept.trim().length >= 2 && Number(d.amount) >= 0,
          )
          .map((d) => ({
            concept: d.concept.trim(),
            amount: Number(d.amount),
          })),
      ),
    );
    if (evidenceFile && evidenceFile.size > 0) {
      fd.set('evidence', evidenceFile);
    }
    if (removeEvidence && !evidenceFile) {
      fd.set('remove_evidence', '1');
    }

    startTransition(async () => {
      try {
        const result = await updatePaymentAction(detail.id, fd);
        if (result.status === 'success') {
          router.push('/payments');
          router.refresh();
          return;
        }
        if (result.status === 'error') {
          let combined = result.message;
          if (result.fieldErrors) {
            const lines = Object.entries(result.fieldErrors)
              .filter(([, msgs]) => msgs && msgs[0])
              .map(([path, msgs]) => `· ${path}: ${msgs?.[0]}`);
            if (lines.length > 0) {
              combined = `${result.message}\n${lines.join('\n')}`;
            }
          }
          setError(combined);
        }
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'Error de red o servidor al invocar la acción';
        setError(message);
      }
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="flex flex-col gap-6 max-w-6xl"
    >
      <div className="flex items-center gap-3">
        <Link
          href="/payments"
          className="btn btn-ghost"
          style={{ padding: '8px' }}
        >
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">
            Editando pago de {detail.client_name} —{' '}
            <span style={{ color: 'var(--text-secondary)' }}>
              {formatMXN(detail.amount)}
            </span>
          </h1>
          <p
            className="text-sm"
            style={{ color: 'var(--text-secondary)' }}
          >
            Ajusta monto, método, tipo, deducibles y evidencia. La fecha
            del cobro y el lead asociado quedan como están.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left col */}
        <div className="xl:col-span-2 flex flex-col gap-6">
          {/* Cliente + meta readonly */}
          <div className="card p-6">
            <h3 className="font-semibold mb-4">Cliente y referencia</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="label">Cliente</label>
                <input
                  className="input"
                  value={detail.client_name}
                  readOnly
                  style={{ background: 'var(--bg-muted)' }}
                />
              </div>
              <div>
                <label className="label">Total compra</label>
                <input
                  className="input"
                  value={formatMXN(detail.lead_total)}
                  readOnly
                  style={{ background: 'var(--bg-muted)' }}
                />
              </div>
              <div>
                <label className="label">Fecha del pago</label>
                <input
                  className="input"
                  value={formatDateTime(detail.paid_at)}
                  readOnly
                  style={{ background: 'var(--bg-muted)' }}
                />
              </div>
              <div>
                <label className="label">Lead ID</label>
                <input
                  className="input font-mono"
                  value={detail.lead_id}
                  readOnly
                  style={{
                    background: 'var(--bg-muted)',
                    fontSize: '0.75rem',
                  }}
                />
              </div>
            </div>
          </div>

          {/* Cobro */}
          <div className="card p-6">
            <h3 className="font-semibold mb-4">Datos del cobro</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="label">Monto cobrado</label>
                <input
                  type="number"
                  className="input"
                  value={amount}
                  onChange={(e) => setAmount(Number(e.target.value))}
                  min={0}
                  step="0.01"
                  disabled={pending}
                />
              </div>
              <div>
                <label className="label">Método de pago</label>
                <select
                  className="select"
                  value={method}
                  onChange={(e) =>
                    setMethod(e.target.value as typeof method)
                  }
                  disabled={pending}
                >
                  {METHOD_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Tipo de pago</label>
                <select
                  className="select"
                  value={paymentType}
                  onChange={(e) =>
                    setPaymentType(e.target.value as typeof paymentType)
                  }
                  disabled={pending}
                >
                  {PAYMENT_TYPE_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Deducibles */}
            <div className="mt-6">
              <div className="flex items-center justify-between mb-2">
                <label className="label" style={{ marginBottom: 0 }}>
                  Deducibles
                </label>
                <button
                  type="button"
                  onClick={addDed}
                  className="btn btn-outline"
                  style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                  disabled={pending}
                >
                  <Plus size={12} /> Agregar deducible
                </button>
              </div>
              {deductibles.length === 0 && (
                <div
                  className="rounded-lg border-dashed border p-4 text-center text-sm"
                  style={{
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text-tertiary)',
                  }}
                >
                  Sin deducibles registrados.
                </div>
              )}
              <div className="flex flex-col gap-2">
                {deductibles.map((d) => (
                  <div
                    key={d.localId}
                    className="grid grid-cols-12 gap-2 items-center"
                  >
                    <input
                      className="input col-span-7"
                      placeholder="Concepto (ej. Gasolina)"
                      value={d.concept}
                      onChange={(e) =>
                        updateDed(d.localId, { concept: e.target.value })
                      }
                      disabled={pending}
                    />
                    <input
                      type="number"
                      className="input col-span-3"
                      placeholder="0"
                      value={d.amount}
                      onChange={(e) =>
                        updateDed(d.localId, {
                          amount: Number(e.target.value),
                        })
                      }
                      min={0}
                      step="0.01"
                      disabled={pending}
                    />
                    <button
                      type="button"
                      onClick={() => removeDed(d.localId)}
                      className="btn btn-danger-outline col-span-2"
                      style={{ padding: '6px' }}
                      disabled={pending}
                      aria-label="Eliminar deducible"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Evidencia */}
            <div className="mt-6">
              <label className="label">
                Evidencia del pago{' '}
                {evidenceRequired && (
                  <span style={{ color: 'var(--danger)' }}>* requerida</span>
                )}
              </label>

              {hasExistingEvidence && !evidenceFile ? (
                <div
                  className="card p-3 flex items-center gap-3"
                  style={{ border: '1px solid var(--border)' }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={detail.evidence_photo_url!}
                    alt={`Evidencia actual del pago de ${detail.client_name}`}
                    style={{
                      width: 96,
                      height: 96,
                      objectFit: 'cover',
                      borderRadius: 8,
                      background: 'var(--bg-muted)',
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="text-sm font-medium"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      Evidencia actual
                    </div>
                    <div
                      className="text-xs mt-1"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      Se conserva si no la reemplazas.
                    </div>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <button
                        type="button"
                        className="btn btn-outline"
                        style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                        onClick={() => fileRef.current?.click()}
                        disabled={pending}
                      >
                        <Upload size={12} /> Reemplazar
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger-outline"
                        style={{ padding: '4px 10px', fontSize: '0.75rem' }}
                        onClick={() => setRemoveEvidence(true)}
                        disabled={pending}
                      >
                        <Trash2 size={12} /> Quitar
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  className="dropzone flex flex-col items-center gap-2"
                  onClick={() => fileRef.current?.click()}
                  style={{ cursor: pending ? 'not-allowed' : 'pointer' }}
                >
                  <Camera
                    size={28}
                    style={{ color: 'var(--text-tertiary)' }}
                  />
                  <div
                    className="font-medium"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {evidenceFile
                      ? evidenceFile.name
                      : removeEvidence
                        ? 'Sin evidencia (se quitará al guardar)'
                        : 'Haz clic para subir una foto'}
                  </div>
                  <div className="text-xs">PNG, JPG o WEBP hasta 5 MB</div>
                  <div className="flex items-center gap-2 mt-1">
                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ padding: '6px 12px' }}
                      disabled={pending}
                      onClick={(e) => {
                        e.stopPropagation();
                        fileRef.current?.click();
                      }}
                    >
                      <Upload size={14} /> Seleccionar archivo
                    </button>
                    {(evidenceFile || removeEvidence) &&
                      detail.evidence_photo_url && (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          style={{
                            padding: '6px 12px',
                            fontSize: '0.75rem',
                          }}
                          disabled={pending}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEvidenceFile(null);
                            setRemoveEvidence(false);
                          }}
                        >
                          Cancelar cambio
                        </button>
                      )}
                  </div>
                </div>
              )}

              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={handleFileChange}
                style={{ display: 'none' }}
                disabled={pending}
              />
            </div>
          </div>
        </div>

        {/* Right col — sticky summary */}
        <div className="xl:sticky xl:top-24 self-start">
          <div className="card p-6">
            <h3 className="font-semibold mb-4">Resumen del cobro</h3>
            <div className="space-y-3 text-sm">
              <Row label="Monto bruto" value={formatMXN(amount)} />
              <Row
                label="Deducibles"
                value={`- ${formatMXN(totalDed)}`}
                color={totalDed > 0 ? 'var(--danger)' : undefined}
              />
              <div
                className="border-t pt-3"
                style={{ borderColor: 'var(--border)' }}
              >
                <div
                  className="text-xs uppercase tracking-wide"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Ingreso neto
                </div>
                <div
                  className="text-3xl font-bold mt-1"
                  style={{ color: 'var(--success)' }}
                >
                  {formatMXN(net)}
                </div>
              </div>
            </div>

            {pending && (
              <div
                role="status"
                aria-live="polite"
                className="mt-4 text-sm flex items-center gap-2"
                style={{
                  color: 'var(--text-secondary)',
                  background: 'var(--surface-2, rgba(15,23,42,0.04))',
                  padding: '8px 12px',
                  borderRadius: 6,
                }}
              >
                <Loader size={16} className="animate-spin" />
                <span>Guardando cambios…</span>
              </div>
            )}

            {error && !pending && (
              <div
                role="alert"
                className="mt-4 text-sm"
                style={{
                  color: 'var(--danger, #dc2626)',
                  background: 'var(--danger-bg, rgba(220,38,38,0.08))',
                  border: '1px solid rgba(220,38,38,0.25)',
                  padding: '8px 12px',
                  borderRadius: 6,
                  whiteSpace: 'pre-wrap',
                }}
              >
                <strong>No se pudo guardar el pago.</strong>
                <br />
                {error}
              </div>
            )}

            <div className="flex gap-2 mt-5">
              <Link
                href="/payments"
                className="btn btn-outline"
                style={{ flex: 1, justifyContent: 'center', height: 44 }}
              >
                Cancelar
              </Link>
              <button
                type="submit"
                className="btn btn-primary"
                style={{ flex: 1, height: 44 }}
                disabled={pending}
                aria-busy={pending}
              >
                {pending ? (
                  <>
                    <Loader size={16} className="animate-spin" />
                    <span style={{ marginLeft: 6 }}>Guardando…</span>
                  </>
                ) : (
                  'Guardar cambios'
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}

function Row({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="flex justify-between">
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ color, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
