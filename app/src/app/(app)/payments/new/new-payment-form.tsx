'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import {
  ArrowLeft,
  Search,
  Plus,
  X,
  Camera,
  Upload,
  Loader,
} from 'lucide-react';
import { formatMXN } from '@/data/mock';
import {
  METHOD_OPTIONS,
  PAYMENT_TYPE_OPTIONS,
  type DeductibleInput,
} from './schema';
import { savePaymentAction } from './actions';
import {
  validatePhotoFile,
  PHOTO_ACCEPT_ATTR,
} from '@/lib/validate-photo';

export type LeadOption = {
  id: string;
  client_name: string;
  phone: string;
  total_amount: number;
  paid_so_far: number;
  adeudo: number;
  sale_date: string | null;
};

/**
 * Formulario para registrar un pago.
 *
 * No usa RHF porque el form mezcla state interactivo intenso (búsqueda
 * de leads con filtrado live, selección visual con highlight, file
 * picker con drag&drop, deducibles dinámicos) y un único submit. RHF
 * agregaba más fricción que valor; usamos `useState` clásico + envío
 * manual con FormData. La validación final es responsabilidad del
 * Server Action (Zod safeParse) y los errores se pintan en el banner.
 *
 * Política de errores: el banner de error muestra el message del action.
 * Los fieldErrors anidados se concatenan al banner ya que no tenemos
 * RHF para hacer scrolling/highlight por campo (futuro: agregar refs +
 * scrollIntoView).
 */
export function NewPaymentForm({
  leads,
}: {
  leads: LeadOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Estado del formulario.
  // NOTA: el dropdown "Chofer asignado" se quitó — esa asignación ahora
  // vive en /leads/new. Si necesitas saber el chofer de un pago, JOIN
  // con leads.driver_id usando payments.lead_id.
  const [query, setQuery] = useState('');
  const [selectedLeadId, setSelectedLeadId] = useState<string>(leads[0]?.id ?? '');
  const [amount, setAmount] = useState<number>(leads[0]?.adeudo ?? 0);
  const [method, setMethod] = useState<typeof METHOD_OPTIONS[number]['value']>('transferencia');
  const [paymentType, setPaymentType] = useState<typeof PAYMENT_TYPE_OPTIONS[number]['value']>('anticipo');
  const [deductibles, setDeductibles] = useState<(DeductibleInput & { id: number })[]>([]);
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const selectedLead = leads.find((l) => l.id === selectedLeadId);

  // Cuando cambia el lead seleccionado, pre-llena `amount` con su adeudo
  // (caso típico: el cobrador llega a liquidar exacto).
  useEffect(() => {
    if (selectedLead) {
      setAmount(selectedLead.adeudo);
    }
  }, [selectedLeadId]);  // eslint-disable-line react-hooks/exhaustive-deps

  const totalDed = useMemo(
    () =>
      deductibles.reduce(
        (s, d) => s + (Number.isFinite(d.amount) ? Number(d.amount) : 0),
        0,
      ),
    [deductibles],
  );
  const net = Math.max(amount - totalDed, 0);

  const filteredLeads = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return leads.slice(0, 8);
    return leads
      .filter(
        (l) =>
          l.client_name.toLowerCase().includes(q) ||
          l.phone.toLowerCase().includes(q) ||
          l.id.toLowerCase().includes(q),
      )
      .slice(0, 30);
  }, [query, leads]);

  const addDed = () =>
    setDeductibles((prev) => [
      ...prev,
      { id: Date.now(), concept: '', amount: 0 },
    ]);
  const removeDed = (id: number) =>
    setDeductibles((prev) => prev.filter((d) => d.id !== id));
  const updateDed = (id: number, patch: Partial<DeductibleInput>) =>
    setDeductibles((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    );

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!selectedLeadId) {
      setError('Selecciona un lead.');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('El monto debe ser mayor a 0.');
      return;
    }
    // Política 2026-05/3: la foto de evidencia es OBLIGATORIA para
    // cualquier método de pago, sin distinguir efectivo vs digital.
    const photoResult = validatePhotoFile(evidenceFile);
    if (!photoResult.ok) {
      setError(photoResult.message);
      return;
    }

    const fd = new FormData();
    fd.set('lead_id', selectedLeadId);
    fd.set('amount', String(amount));
    fd.set('method', method);
    fd.set('payment_type', paymentType);
    // Deducibles van como JSON string para que `formData.get` retorne un
    // único string parseable. Ver actions.ts donde se hace JSON.parse.
    fd.set(
      'deductibles_json',
      JSON.stringify(
        deductibles
          .filter((d) => d.concept.trim().length >= 2 && Number(d.amount) >= 0)
          .map((d) => ({ concept: d.concept.trim(), amount: Number(d.amount) })),
      ),
    );
    if (evidenceFile && evidenceFile.size > 0) fd.set('evidence', evidenceFile);

    console.log('[NewPaymentForm] enviando savePaymentAction…', {
      lead_id: selectedLeadId,
      amount,
      method,
      payment_type: paymentType,
      deductibles_count: deductibles.length,
      evidence: evidenceFile?.name ?? null,
    });

    startTransition(async () => {
      try {
        const result = await savePaymentAction({ status: 'idle' }, fd);
        console.log('[NewPaymentForm] respuesta:', result);

        if (result.status === 'success') {
          router.push('/payments');
          router.refresh();
          return;
        }
        if (result.status === 'error') {
          // Concatenamos fieldErrors al banner ya que no usamos RHF.
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
        console.error('[NewPaymentForm] excepción al invocar la acción:', err);
        setError(message);
      }
    });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setEvidenceFile(f);
  };

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6 max-w-6xl">
      <div className="flex items-center gap-3">
        <Link href="/payments" className="btn btn-ghost" style={{ padding: '8px' }}>
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Registrar Pago</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Captura cobros, deducibles y entrega de efectivo al admin.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left col */}
        <div className="xl:col-span-2 flex flex-col gap-6">
          {/* Lead search */}
          <div className="card p-6">
            <h3 className="font-semibold mb-4">Lead asociado</h3>
            <div className="relative">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--text-tertiary)' }}
              />
              <input
                id="field-lead-search"
                placeholder="Busca por cliente, teléfono o ID…"
                className="input"
                style={{ paddingLeft: 36 }}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={pending}
              />
            </div>
            <div
              className="mt-3 rounded-lg border max-h-56 overflow-y-auto"
              style={{ borderColor: 'var(--border)' }}
            >
              {filteredLeads.length === 0 ? (
                <div
                  className="p-4 text-sm"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  {leads.length === 0
                    ? 'No hay leads pendientes de pago. Todos los registrados ya están pagados.'
                    : 'Sin resultados para esa búsqueda.'}
                </div>
              ) : (
                filteredLeads.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setSelectedLeadId(l.id)}
                    className="w-full text-left px-4 py-3 flex items-center justify-between border-b last:border-b-0 hover:bg-[var(--bg-muted)]"
                    style={{
                      borderColor: 'var(--border)',
                      background: l.id === selectedLeadId ? '#EFF6FF' : 'transparent',
                    }}
                    disabled={pending}
                  >
                    <div>
                      <div className="text-sm font-medium">{l.client_name}</div>
                      <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {l.phone || l.id.slice(0, 8)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-semibold">
                        {formatMXN(l.total_amount)}
                      </div>
                      {l.adeudo > 0 && (
                        <div className="text-xs" style={{ color: 'var(--danger)' }}>
                          Adeuda {formatMXN(l.adeudo)}
                        </div>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>

            {selectedLead && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-5">
                <div>
                  <label className="label">Cliente</label>
                  <input
                    className="input"
                    value={selectedLead.client_name}
                    readOnly
                    style={{ background: 'var(--bg-muted)' }}
                  />
                </div>
                <div>
                  <label className="label">Total compra</label>
                  <input
                    className="input"
                    value={formatMXN(selectedLead.total_amount)}
                    readOnly
                    style={{ background: 'var(--bg-muted)' }}
                  />
                </div>
                <div>
                  <label className="label">Adeudo pendiente</label>
                  <input
                    className="input"
                    value={formatMXN(selectedLead.adeudo)}
                    readOnly
                    style={
                      selectedLead.adeudo > 0
                        ? { background: '#FEE2E2', color: '#B91C1C', fontWeight: 600 }
                        : { background: 'var(--bg-muted)' }
                    }
                  />
                </div>
              </div>
            )}
          </div>

          {/* Cobro */}
          <div className="card p-6">
            <h3 className="font-semibold mb-4">Datos del cobro</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="label">Monto que paga</label>
                <input
                  id="field-amount"
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
                  id="field-method"
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
                  id="field-payment-type"
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
            <div id="field-deductibles" className="mt-6">
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
                    key={d.id}
                    className="grid grid-cols-12 gap-2 items-center"
                  >
                    <input
                      className="input col-span-7"
                      placeholder="Concepto (ej. Gasolina)"
                      value={d.concept}
                      onChange={(e) => updateDed(d.id, { concept: e.target.value })}
                      disabled={pending}
                    />
                    <input
                      type="number"
                      className="input col-span-3"
                      placeholder="0"
                      value={d.amount}
                      onChange={(e) => updateDed(d.id, { amount: Number(e.target.value) })}
                      min={0}
                      step="0.01"
                      disabled={pending}
                    />
                    <button
                      type="button"
                      onClick={() => removeDed(d.id)}
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

            {/* Evidencia — OBLIGATORIA para cualquier método (2026-05/3).
                Borde rojo cuando no hay foto seleccionada para señalar
                visualmente que falta. */}
            <div id="field-evidence" className="mt-6">
              <label className="label">
                Foto del comprobante{' '}
                <span style={{ color: '#DC2626' }}>* (obligatoria)</span>
              </label>
              <div
                className="dropzone flex flex-col items-center gap-2"
                onClick={() => fileRef.current?.click()}
                style={{
                  cursor: pending ? 'not-allowed' : 'pointer',
                  borderColor: evidenceFile ? undefined : '#FCA5A5',
                }}
              >
                <Camera
                  size={28}
                  style={{
                    color: evidenceFile ? 'var(--text-tertiary)' : '#DC2626',
                  }}
                />
                <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                  {evidenceFile
                    ? evidenceFile.name
                    : 'Toca para subir una foto'}
                </div>
                <div className="text-xs">JPG, PNG, WEBP o HEIC · máx. 10 MB</div>
                <button
                  type="button"
                  className="btn btn-outline mt-1"
                  style={{ padding: '6px 12px' }}
                  disabled={pending}
                  onClick={(e) => {
                    e.stopPropagation();
                    fileRef.current?.click();
                  }}
                >
                  <Upload size={14} /> Seleccionar archivo
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept={PHOTO_ACCEPT_ATTR}
                  capture="environment"
                  onChange={handleFileChange}
                  style={{ display: 'none' }}
                  disabled={pending}
                />
              </div>
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
                <span>Registrando pago…</span>
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
                <strong>No se pudo registrar el pago.</strong>
                <br />
                {error}
              </div>
            )}

            <button
              type="submit"
              className="btn btn-primary w-full mt-5"
              style={{ height: 44 }}
              disabled={
                pending ||
                !selectedLeadId ||
                !evidenceFile ||
                evidenceFile.size === 0
              }
              aria-busy={pending}
              title={
                !evidenceFile && !pending
                  ? 'Sube una foto del comprobante para continuar'
                  : undefined
              }
            >
              {pending ? (
                <>
                  <Loader size={16} className="animate-spin" />
                  <span style={{ marginLeft: 6 }}>Registrando…</span>
                </>
              ) : (
                'Registrar Pago'
              )}
            </button>
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
