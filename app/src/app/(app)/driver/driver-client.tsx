'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import {
  MapPin,
  Box,
  CircleCheckBig,
  Camera,
  Layers,
  Loader,
  DollarSign,
  TriangleAlert,
  X,
  Package,
} from 'lucide-react';
import { formatMXN } from '@/data/mock';
import { DeliveryBadge } from '@/components/ui/Badges';
import { confirmDeliveryAction, reportIssueAction } from './actions';
import { ISSUE_TYPE_OPTIONS } from './schema';

export type DeliveryCardData = {
  id: string;
  client_name: string;
  address: string;
  maps_url: string;
  total_amount: number;
  adeudo: number;
  delivery_status: 'pendiente' | 'en_transito';
  colors: { color_name: string; quantity: number }[];
};

export type ReceiverOption = {
  id: string;
  name: string;
};

/**
 * Vista del chofer — mobile-first.
 *
 * El layout se restringe a max-w 420px. Botones tienen al menos 48px de
 * altura y el texto principal arranca en 16px para usabilidad táctil.
 *
 * Cada card es autocontenida: state local para receiver_id, amount,
 * file y banner de error/success. Submit llama `confirmDeliveryAction`
 * por card; al éxito se hace `router.refresh()` para que el lead salga
 * de la lista (ahora delivery_status='entregado').
 */
export function DriverClient({
  driverName,
  deliveries,
  receivers,
  cashPending,
  todayDeliveriesCount,
  todayIso,
}: {
  driverName: string;
  deliveries: DeliveryCardData[];
  receivers: ReceiverOption[];
  /** Suma de cash_transfers WHERE driver_id=uid AND status='pendiente'.
   *  Es el efectivo físico que el chofer trae y debe entregar al contador. */
  cashPending: number;
  /** Cantidad de entregas con delivery_date=hoy asignadas a este chofer.
   *  Usado para el banner "📦 Tienes N entregas programadas para hoy". */
  todayDeliveriesCount: number;
  /** Hoy en YYYY-MM-DD (UTC) — viene del server para que el formato del
   *  banner sea consistente con lo que se SELECTeó. */
  todayIso: string;
}) {
  return (
    <div className="mx-auto" style={{ maxWidth: 420, width: '100%' }}>
      {/* Header card */}
      <div
        className="rounded-2xl mb-5 p-4 flex items-center gap-3"
        style={{
          background: 'linear-gradient(135deg, #1B3A5C 0%, #2E74B5 100%)',
          color: '#fff',
        }}
      >
        <div
          className="flex items-center justify-center"
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: 'var(--brand-accent)',
            color: '#1F2937',
          }}
        >
          <Layers size={22} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="text-xs" style={{ opacity: 0.75 }}>
            Buen día,
          </div>
          <div className="font-semibold truncate">{driverName}</div>
        </div>
        <div className="text-right">
          <div className="text-xs" style={{ opacity: 0.75 }}>
            Hoy
          </div>
          <div className="font-bold">
            {deliveries.length}{' '}
            {deliveries.length === 1 ? 'entrega' : 'entregas'}
          </div>
        </div>
      </div>

      {/* Banner "Entregas programadas para hoy" (Grupo 1).
          Color azul si N > 0, gris si N = 0. Distinto del header
          "Hoy: N entregas" que muestra TODAS las entregas activas
          (incluye sin delivery_date asignada): este banner contesta
          específicamente "¿qué entregas me toca HOY según la ruta
          que el admin asignó?". */}
      <TodayDeliveriesBanner
        count={todayDeliveriesCount}
        todayIso={todayIso}
      />

      {/* Banner de efectivo acumulado.
          Visible incluso cuando cashPending=0 — sirve también de
          confirmación al chofer ("no traigo efectivo, ya entregué todo"). */}
      <div
        className="rounded-xl mb-5 p-4 flex items-center gap-3"
        style={{
          background: cashPending > 0 ? '#DCFCE7' : 'var(--bg-subtle)',
          border: cashPending > 0
            ? '1px solid rgba(22,163,74,0.25)'
            : '1px solid var(--border)',
        }}
      >
        <div
          className="flex items-center justify-center"
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: cashPending > 0 ? '#16A34A' : 'var(--text-tertiary)',
            color: '#fff',
            flexShrink: 0,
          }}
        >
          <DollarSign size={22} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="text-xs"
            style={{
              color: cashPending > 0 ? '#15803D' : 'var(--text-tertiary)',
              fontWeight: 600,
            }}
          >
            Efectivo que llevas
          </div>
          <div
            className="text-2xl font-bold leading-tight"
            style={{
              color: cashPending > 0 ? '#15803D' : 'var(--text-tertiary)',
            }}
          >
            {formatMXN(cashPending)}
          </div>
          <div
            className="text-[11px] mt-1"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {cashPending > 0
              ? 'Pendiente de entregar al contador'
              : 'No tienes efectivo pendiente'}
          </div>
        </div>
      </div>

      {/* Active deliveries */}
      <div className="flex flex-col gap-4">
        <div
          className="px-1 text-sm font-semibold"
          style={{ color: 'var(--text-secondary)' }}
        >
          Entregas activas
        </div>
        {deliveries.length === 0 ? (
          <div
            className="card p-6 text-center text-sm"
            style={{ color: 'var(--text-tertiary)' }}
          >
            No tienes entregas pendientes asignadas.
          </div>
        ) : (
          deliveries.map((d) => (
            <DeliveryCard key={d.id} delivery={d} receivers={receivers} />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Banner azul/gris en el tope del feed del chofer con el número de
 * entregas programadas para hoy. Si `count=0` muestra mensaje neutro
 * gris ("No tienes entregas programadas para hoy"); si > 0 azul con
 * el conteo + fecha legible.
 */
function TodayDeliveriesBanner({
  count,
  todayIso,
}: {
  count: number;
  todayIso: string;
}) {
  const hasDeliveries = count > 0;
  return (
    <div
      className="rounded-xl mb-5 p-4 flex items-center gap-3"
      style={{
        background: hasDeliveries ? '#DBEAFE' : 'var(--bg-subtle)',
        border: hasDeliveries
          ? '1px solid rgba(37,99,235,0.25)'
          : '1px solid var(--border)',
      }}
    >
      <div
        className="flex items-center justify-center"
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          background: hasDeliveries ? '#2563EB' : 'var(--text-tertiary)',
          color: '#fff',
          flexShrink: 0,
        }}
      >
        <Package size={22} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="text-xs"
          style={{
            color: hasDeliveries ? '#1E40AF' : 'var(--text-tertiary)',
            fontWeight: 600,
          }}
        >
          Programadas para hoy
        </div>
        <div
          className="text-2xl font-bold leading-tight"
          style={{
            color: hasDeliveries ? '#1E40AF' : 'var(--text-tertiary)',
          }}
        >
          {hasDeliveries
            ? `📦 ${count} ${count === 1 ? 'entrega' : 'entregas'}`
            : 'Sin entregas para hoy'}
        </div>
        <div
          className="text-[11px] mt-1"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {formatDateLong(todayIso)}
        </div>
      </div>
    </div>
  );
}

/** YYYY-MM-DD → "lun 8 may 2026" en español (UTC-safe). */
function formatDateLong(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('es-MX', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function DeliveryCard({
  delivery,
  receivers,
}: {
  delivery: DeliveryCardData;
  receivers: ReceiverOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [receiverId, setReceiverId] = useState(receivers[0]?.id ?? '');
  const [amount, setAmount] = useState<number>(delivery.adeudo);
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const owes = delivery.adeudo > 0;

  const handleSubmit = () => {
    setError(null);
    if (!receiverId) {
      setError('Selecciona un admin para entregar el efectivo.');
      return;
    }
    if (owes && (!Number.isFinite(amount) || amount < 0)) {
      setError('Monto cobrado inválido.');
      return;
    }
    if (owes && amount > 0 && !evidenceFile) {
      // Política: si cobró efectivo/dinero hay que subir evidencia.
      // Si quieres permitir entregas sin foto, quita este chequeo.
      const ok = confirm(
        '¿Confirmar entrega sin foto del cobro? Lo recomendable es adjuntar comprobante.',
      );
      if (!ok) return;
    }

    const fd = new FormData();
    fd.set('lead_id', delivery.id);
    fd.set('receiver_id', receiverId);
    fd.set('amount_collected', String(owes ? amount : 0));
    if (evidenceFile && evidenceFile.size > 0) fd.set('evidence', evidenceFile);

    startTransition(async () => {
      try {
        const result = await confirmDeliveryAction({ status: 'idle' }, fd);
        if (result.status === 'success') {
          router.refresh();
          return;
        }
        if (result.status === 'error') {
          let combined = result.message;
          if (result.fieldErrors) {
            const lines = Object.entries(result.fieldErrors)
              .filter(([, msgs]) => msgs && msgs[0])
              .map(([path, msgs]) => `· ${path}: ${msgs?.[0]}`);
            if (lines.length > 0) combined = `${result.message}\n${lines.join('\n')}`;
          }
          setError(combined);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error de red';
        console.error('[DeliveryCard] excepción:', err);
        setError(message);
      }
    });
  };

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <div
            className="text-xs font-mono"
            style={{ color: 'var(--text-tertiary)' }}
          >
            #{delivery.id.slice(0, 8)}
          </div>
          <div
            className="font-bold leading-tight mt-1"
            style={{ fontSize: '1.25rem' }}
          >
            {delivery.client_name}
          </div>
        </div>
        <DeliveryBadge status={delivery.delivery_status} />
      </div>

      {/* Address */}
      <div
        className="text-sm mb-2"
        style={{ color: 'var(--text-secondary)' }}
      >
        {delivery.address || '(sin dirección)'}
      </div>
      {delivery.maps_url && (
        <a
          href={delivery.maps_url}
          target="_blank"
          rel="noopener noreferrer"
          className="btn w-full mb-4"
          style={{
            background: '#16A34A',
            color: '#fff',
            height: 48,
            fontSize: '1rem',
          }}
        >
          <MapPin size={16} /> Ver en mapa
        </a>
      )}

      {/* Materials */}
      <div className="mb-4">
        <div
          className="text-xs uppercase tracking-wide mb-2"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Materiales
        </div>
        {delivery.colors.length === 0 ? (
          <div
            className="text-sm"
            style={{ color: 'var(--text-tertiary)' }}
          >
            (sin materiales registrados)
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {delivery.colors.map((c, idx) => (
              <div
                key={`${c.color_name}-${idx}`}
                className="flex items-center gap-3 p-2 rounded-lg"
                style={{ background: 'var(--bg-subtle)' }}
              >
                <div
                  className="flex items-center justify-center"
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: '#FEF3C7',
                    color: '#92400E',
                  }}
                >
                  <Box size={16} />
                </div>
                <div className="flex-1 text-sm font-medium">
                  {c.color_name}
                </div>
                <div className="font-bold text-sm">×{c.quantity}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Total + adeudo */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <div
            className="text-xs"
            style={{ color: 'var(--text-tertiary)' }}
          >
            Total
          </div>
          <div className="font-semibold">
            {formatMXN(delivery.total_amount)}
          </div>
        </div>
        <div className="text-right">
          {owes ? (
            <>
              <div
                className="text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                Adeudo
              </div>
              <div
                className="text-2xl font-bold"
                style={{ color: 'var(--danger)' }}
              >
                {formatMXN(delivery.adeudo)}
              </div>
            </>
          ) : (
            <div
              className="font-bold flex items-center gap-1"
              style={{ color: 'var(--success)' }}
            >
              <CircleCheckBig size={18} /> Pagado
            </div>
          )}
        </div>
      </div>

      <hr style={{ border: 0, borderTop: '1px solid var(--border)' }} />

      {/* Reportar problema — visible siempre, expandible. Va ANTES de
          "Confirmar entrega" para que el chofer pueda reportar
          incidencias mientras evalúa la entrega y antes de cerrarla. */}
      <ReportIssueBlock leadId={delivery.id} clientName={delivery.client_name} />

      <hr
        className="mt-4"
        style={{ border: 0, borderTop: '1px solid var(--border)' }}
      />

      <div className="mt-4">
        <div className="font-semibold mb-3">Confirmar entrega</div>

        {owes && (
          <>
            <div className="mb-3">
              <label className="label">Monto cobrado</label>
              <input
                type="number"
                className="input"
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                min={0}
                step="0.01"
                style={{ height: 48, fontSize: '1rem' }}
                disabled={pending}
              />
            </div>

            <div
              className="dropzone mb-3"
              onClick={() => !pending && fileRef.current?.click()}
              style={{ cursor: pending ? 'not-allowed' : 'pointer' }}
            >
              <Camera
                size={22}
                style={{ color: 'var(--text-tertiary)' }}
                className="mx-auto mb-1"
              />
              <div
                className="text-sm font-medium"
                style={{ color: 'var(--text-primary)' }}
              >
                {evidenceFile ? evidenceFile.name : 'Sube foto del cobro'}
              </div>
              <div className="text-[11px]">
                Comprobante de transferencia, ticket o efectivo
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => setEvidenceFile(e.target.files?.[0] ?? null)}
                style={{ display: 'none' }}
                disabled={pending}
              />
            </div>
          </>
        )}

        <div className="mb-3">
          <label className="label">Entregar efectivo a</label>
          <select
            className="select"
            value={receiverId}
            onChange={(e) => setReceiverId(e.target.value)}
            disabled={pending}
            style={{ height: 48, fontSize: '1rem' }}
          >
            <option value="">— selecciona —</option>
            {receivers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div
            role="alert"
            className="text-sm mb-3"
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

        <button
          type="button"
          onClick={handleSubmit}
          className="btn btn-primary w-full"
          style={{ height: 56, fontSize: '1rem', fontWeight: 600 }}
          disabled={pending}
          aria-busy={pending}
        >
          {pending ? (
            <>
              <Loader size={20} className="animate-spin" />
              <span style={{ marginLeft: 6 }}>Confirmando…</span>
            </>
          ) : (
            <>
              <CircleCheckBig size={20} /> Entregado
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * Bloque expandible "Reportar problema" dentro de cada card de entrega.
 * Estados:
 *   - colapsado: solo el botón ⚠️ "Reportar faltante o detalle".
 *   - expandido: select tipo + textarea + opcional foto + Enviar /
 *     Cancelar.
 *   - tras success: mensaje de confirmación que desaparece al
 *     `router.refresh` (1.2s después).
 *
 * State local por card para que cada mini-form sea independiente.
 */
function ReportIssueBlock({
  leadId,
  clientName,
}: {
  leadId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [issueType, setIssueType] =
    useState<typeof ISSUE_TYPE_OPTIONS[number]['value']>('faltante');
  const [description, setDescription] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setDescription('');
    setPhoto(null);
    setError(null);
    setSuccess(false);
    setIssueType('faltante');
    if (fileRef.current) fileRef.current.value = '';
  }

  function handleSubmit() {
    setError(null);
    if (description.trim().length < 3) {
      setError('Describe el problema (mínimo 3 caracteres).');
      return;
    }
    const fd = new FormData();
    fd.set('lead_id', leadId);
    fd.set('issue_type', issueType);
    fd.set('description', description.trim());
    if (photo && photo.size > 0) fd.set('photo', photo);

    startTransition(async () => {
      try {
        const r = await reportIssueAction({ status: 'idle' }, fd);
        if (r.status === 'success') {
          setSuccess(true);
          setTimeout(() => {
            setOpen(false);
            reset();
            router.refresh();
          }, 1200);
        } else if (r.status === 'error') {
          setError(r.message);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error de red';
        setError(message);
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          reset();
          setOpen(true);
        }}
        className="btn btn-outline w-full mt-4"
        style={{
          height: 44,
          color: '#92400E',
          borderColor: '#FEF3C7',
          background: '#FFFBEB',
        }}
        aria-label={`Reportar problema en entrega de ${clientName}`}
      >
        <TriangleAlert size={16} /> Reportar faltante o detalle
      </button>
    );
  }

  return (
    <div
      className="mt-4 p-4 rounded-lg"
      style={{
        background: '#FFFBEB',
        border: '1px solid #FEF3C7',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <div
          className="font-semibold flex items-center gap-2"
          style={{ color: '#92400E' }}
        >
          <TriangleAlert size={16} /> Reportar problema
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            reset();
          }}
          className="btn btn-ghost"
          style={{ padding: '4px' }}
          disabled={pending}
          aria-label="Cancelar reporte"
        >
          <X size={16} />
        </button>
      </div>

      <div className="mb-3">
        <label className="label">Tipo</label>
        <select
          className="select"
          value={issueType}
          onChange={(e) => setIssueType(e.target.value as typeof issueType)}
          disabled={pending}
          style={{ height: 48, fontSize: '1rem' }}
        >
          {ISSUE_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-3">
        <label className="label">Descripción</label>
        <textarea
          className="textarea"
          rows={3}
          placeholder="Describe el problema (qué falta, qué detalle, dónde está…)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={pending}
          style={{ fontSize: '1rem' }}
          maxLength={500}
        />
        <div
          className="text-[11px] mt-1"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {description.length}/500
        </div>
      </div>

      <div
        className="dropzone mb-3"
        onClick={() => !pending && fileRef.current?.click()}
        style={{ cursor: pending ? 'not-allowed' : 'pointer' }}
      >
        <Camera
          size={20}
          style={{ color: 'var(--text-tertiary)' }}
          className="mx-auto mb-1"
        />
        <div
          className="text-sm font-medium"
          style={{ color: 'var(--text-primary)' }}
        >
          {photo ? photo.name : 'Foto del problema (opcional)'}
        </div>
        <div className="text-[11px]">
          PNG, JPG o WEBP — recomendado para que el admin vea
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
          style={{ display: 'none' }}
          disabled={pending}
        />
      </div>

      {error && (
        <div
          role="alert"
          className="text-sm mb-3"
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
          className="text-sm mb-3 flex items-center gap-2"
          style={{
            color: '#15803D',
            background: 'rgba(22,163,74,0.08)',
            border: '1px solid rgba(22,163,74,0.25)',
            padding: '8px 12px',
            borderRadius: 6,
          }}
        >
          <CircleCheckBig size={16} />
          <span>Reporte enviado al admin.</span>
        </div>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        className="btn btn-primary w-full"
        style={{ height: 48, fontSize: '1rem', fontWeight: 600 }}
        disabled={pending || success}
        aria-busy={pending}
      >
        {pending ? (
          <>
            <Loader size={18} className="animate-spin" />
            <span style={{ marginLeft: 6 }}>Enviando…</span>
          </>
        ) : (
          'Enviar reporte'
        )}
      </button>
    </div>
  );
}
