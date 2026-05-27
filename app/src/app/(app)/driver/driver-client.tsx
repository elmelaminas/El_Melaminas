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
import {
  confirmDeliveryAction,
  reportIssueAction,
  markFailedDeliveryAction,
} from './actions';
import {
  ISSUE_TYPE_OPTIONS,
  DRIVER_PAYMENT_METHOD_OPTIONS,
  DRIVER_PAYMENT_METHOD_VALUES,
} from './schema';
import { formatTimeCDMX } from '@/lib/format-date';
import {
  validatePhotoFile,
  PHOTO_ACCEPT_ATTR,
} from '@/lib/validate-photo';

export type DeliveryCardData = {
  id: string;
  client_name: string;
  /** Teléfono del cliente. Vacío si el lead no registra teléfono.
   *  La card lo muestra como `tel:` clickeable para que el chofer
   *  pueda llamar/whatsappear sin teclear. */
  phone: string;
  address: string;
  maps_url: string;
  total_amount: number;
  adeudo: number;
  /** Costo del envío a domicilio. >0 solo cuando
   *  purchase_type='domicilio' y el admin ingresó un valor. Ya está
   *  incluido en `total_amount` (y por lo tanto en `adeudo`); se
   *  expone aquí solo para que el chofer vea cuánto cobrar por el
   *  flete específicamente. */
  delivery_cost: number;
  delivery_status: 'pendiente' | 'en_transito';
  /** YYYY-MM-DD; null si el lead aún no tiene fecha de entrega
   *  asignada por admin. Usado para el modo secuencial — solo se
   *  consideran "ruta del día" las que tienen delivery_date=hoy. */
  delivery_date: string | null;
  /** Orden 1..N dentro de la ruta del día. null si no asignado. */
  delivery_order: number | null;
  /** Si el chofer reportó previamente que no pudo entregar este lead,
   *  el motivo queda guardado aquí. La card lo muestra como banner
   *  naranja "intento previo: …" para que el chofer (o un compañero
   *  que retoma) sepa qué pasó. */
  failed_delivery_reason: string | null;
  failed_delivery_photo_url: string | null;
  colors: { color_name: string; quantity: number }[];
};

export type ReceiverOption = {
  id: string;
  name: string;
  /** Rol DB del receptor. El form filtra el dropdown por
   *  `receiver_role` elegido por el chofer:
   *    - 'admin' → admin + admin2 + supervisor (la spec habla de
   *      "el jefe", incluye los administrativos)
   *    - 'contador' → contadores activos. */
  role: 'admin' | 'admin2' | 'supervisor' | 'contador';
};

/**
 * Fila del historial "Entregados hoy" — se renderiza al pie de la
 * vista del chofer. Origen: driver_deliveries con delivered_at en el
 * día UTC actual + JOIN con leads (client_name) y payments
 * (payment_method del cobro del chofer, si lo hubo).
 */
export type DeliveredTodayRow = {
  id: string;
  lead_id: string;
  client_name: string;
  amount_collected: number;
  /** 'efectivo' | 'transferencia' | 'clip' | null (cuando el lead ya
   *  estaba liquidado y el chofer no cobró nada). */
  payment_method: string | null;
  delivered_at: string | null;
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
  todayCompletedCount,
  todayIso,
  deliveredToday,
}: {
  driverName: string;
  deliveries: DeliveryCardData[];
  receivers: ReceiverOption[];
  /** Suma de cash_transfers WHERE driver_id=uid AND status='pendiente'.
   *  Es el efectivo físico que el chofer trae y debe entregar al contador. */
  cashPending: number;
  /** Cantidad de entregas con delivery_date=hoy asignadas a este chofer
   *  AÚN ACTIVAS (pendiente/en_transito). Usado para el banner
   *  "📦 Tienes N entregas programadas para hoy". */
  todayDeliveriesCount: number;
  /** Cantidad de entregas con delivery_date=hoy ya entregadas. Sumado
   *  al todayDeliveriesCount da el total del día; usado para el
   *  contador "Entrega N de M" del modo secuencial. */
  todayCompletedCount: number;
  /** Hoy en YYYY-MM-DD (UTC) — viene del server para que el formato del
   *  banner sea consistente con lo que se SELECTeó. */
  todayIso: string;
  /** Driver_deliveries completadas en el día UTC actual. Se muestra al
   *  pie como historial — lista compacta con cliente + monto + método +
   *  hora de entrega. */
  deliveredToday: DeliveredTodayRow[];
}) {
  // Modo secuencial vs lista (Grupo 2):
  //   - Si hay deliveries activas con delivery_date=hoy, mostramos
  //     SOLO la primera en orden (delivery_order ASC) y el contador
  //     "Entrega N de M" prominente.
  //   - Si no, mantenemos el comportamiento previo (lista de todas
  //     las activas, sin orden particular).
  // Política: leads sin delivery_order entre los del día (ej: el
  // admin agregó uno manualmente sin especificar orden) se ordenan
  // al final, manteniendo estabilidad por client_name.
  const todaysDeliveries = deliveries
    .filter((d) => d.delivery_date === todayIso)
    .sort((a, b) => {
      const oa = a.delivery_order ?? 9999;
      const ob = b.delivery_order ?? 9999;
      if (oa !== ob) return oa - ob;
      return a.client_name.localeCompare(b.client_name, 'es-MX');
    });
  const isSequentialMode = todaysDeliveries.length > 0;
  const currentDelivery = isSequentialMode ? todaysDeliveries[0] : null;
  // M = activas hoy + ya entregadas hoy (total programado para el día).
  // N = entregadas hoy + 1 (la siguiente activa).
  const totalToday = todayDeliveriesCount + todayCompletedCount;
  const currentIndex = todayCompletedCount + 1;
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
        {isSequentialMode && currentDelivery ? (
          <>
            {/* Modo secuencial: mostramos SOLO la entrega actual + un
                contador prominente de progreso del día. Las demás del
                día quedan invisibles hasta que ésta se complete o se
                marque falla, momento en que el server refresca y la
                siguiente toma su lugar. */}
            <div
              className="rounded-xl p-4 text-center"
              style={{
                background: 'var(--brand-primary)',
                color: '#fff',
              }}
            >
              <div className="text-xs uppercase tracking-wide opacity-80">
                Progreso del día
              </div>
              <div className="text-3xl font-bold mt-1">
                Entrega {currentIndex}{' '}
                <span style={{ opacity: 0.7, fontSize: '1.5rem' }}>
                  de {totalToday}
                </span>
              </div>
              <div className="text-xs opacity-80 mt-1">
                Completa esta entrega para avanzar a la siguiente
              </div>
            </div>
            <DeliveryCard
              delivery={currentDelivery}
              receivers={receivers}
            />
          </>
        ) : (
          <>
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
          </>
        )}

        {/* Historial del día: entregas ya completadas hoy. */}
        <DeliveredTodaySection history={deliveredToday} />
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
  // Rol del destinatario del efectivo: 'admin' o 'contador'. Null
  // hasta que el chofer elija una de las dos cards. Cambiar el rol
  // resetea el receiver_id para evitar enviar un id que no pertenece
  // al rol elegido.
  const [receiverRole, setReceiverRole] = useState<
    'admin' | 'contador' | null
  >(null);
  const [receiverId, setReceiverId] = useState<string>('');
  const [amount, setAmount] = useState<number>(delivery.adeudo);
  const [paymentMethod, setPaymentMethod] = useState<
    (typeof DRIVER_PAYMENT_METHOD_VALUES)[number]
  >('efectivo');
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const owes = delivery.adeudo > 0;
  // Receptores filtrados según el rol elegido. La spec mapea
  // 'admin' → admins+supervisores ("al jefe"), 'contador' → contadores.
  const eligibleReceivers = receivers.filter((r) => {
    if (receiverRole === 'admin') {
      return r.role === 'admin' || r.role === 'admin2' || r.role === 'supervisor';
    }
    if (receiverRole === 'contador') {
      return r.role === 'contador';
    }
    return false;
  });
  // Foto SIEMPRE obligatoria (2026-05/3) — cualquier confirmación de
  // entrega exige evidencia visual, esté liquidado o no.
  const isEfectivo = paymentMethod === 'efectivo';

  const handleSubmit = () => {
    setError(null);
    if (owes && (!Number.isFinite(amount) || amount < 0)) {
      setError('Monto cobrado inválido.');
      return;
    }
    const photoCheck = validatePhotoFile(evidenceFile);
    if (!photoCheck.ok) {
      setError(`Foto de la entrega: ${photoCheck.message}`);
      return;
    }
    if (owes && amount > 0 && isEfectivo && !receiverRole) {
      setError('Selecciona a quién entregas el efectivo (admin o contador).');
      return;
    }
    if (owes && amount > 0 && isEfectivo && !receiverId) {
      setError(
        receiverRole === 'contador'
          ? 'Selecciona el contador que recibirá el efectivo.'
          : 'Selecciona el admin que recibirá el efectivo.',
      );
      return;
    }

    const fd = new FormData();
    fd.set('lead_id', delivery.id);
    fd.set('amount_collected', String(owes ? amount : 0));
    if (owes && amount > 0) {
      fd.set('payment_method', paymentMethod);
      if (isEfectivo && receiverId) {
        fd.set('receiver_id', receiverId);
      }
      if (isEfectivo && receiverRole) {
        fd.set('receiver_role', receiverRole);
      }
    }
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

      {/* Teléfono del cliente — clickeable como tel: link para que el
          chofer pueda marcar directo desde el móvil. Si falta, mostramos
          un placeholder gris. */}
      <div className="text-sm mb-2">
        {delivery.phone ? (
          <a
            href={`tel:${delivery.phone}`}
            style={{
              color: 'var(--brand-primary)',
              textDecoration: 'none',
              fontWeight: 500,
            }}
            aria-label={`Llamar a ${delivery.client_name} al ${delivery.phone}`}
          >
            📱 {delivery.phone}
          </a>
        ) : (
          <span style={{ color: 'var(--text-tertiary)' }}>
            Sin teléfono
          </span>
        )}
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

      {/* Costo del envío — visible solo cuando hay flete a domicilio.
          Ya está incluido en `adeudo`/`total_amount`; lo desglosamos
          aquí para que el chofer sepa cuánto cobrar específicamente
          por el viaje (vs por el material). */}
      {delivery.delivery_cost > 0 && (
        <div
          className="flex items-center gap-2 p-3 rounded-lg mb-4"
          style={{
            background: '#DBEAFE',
            border: '1px solid rgba(30,64,175,0.25)',
          }}
        >
          <span aria-hidden="true" style={{ fontSize: '1.125rem' }}>
            🚗
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              className="text-xs uppercase tracking-wide"
              style={{ color: '#1E40AF', fontWeight: 600 }}
            >
              Costo de envío
            </div>
            <div
              className="text-base font-bold"
              style={{ color: '#1E3A8A' }}
            >
              {formatMXN(delivery.delivery_cost)}
            </div>
            <div
              className="text-[11px] mt-0.5"
              style={{ color: '#1E3A8A' }}
            >
              Ya incluido en el adeudo total.
            </div>
          </div>
        </div>
      )}

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

      {/* Banner de intento previo fallido (solo si existe). Visible
          arriba de los CTAs para que el chofer/compañero que retoma
          la entrega vea el contexto antes de actuar. */}
      {delivery.failed_delivery_reason && (
        <div
          className="mt-3 p-3 rounded-lg flex items-start gap-2"
          style={{
            background: '#FFEDD5',
            border: '1px solid #FED7AA',
          }}
        >
          <TriangleAlert
            size={16}
            style={{ color: '#C2410C', flexShrink: 0, marginTop: 2 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              className="text-xs font-semibold"
              style={{ color: '#9A3412' }}
            >
              Intento previo fallido
            </div>
            <p
              className="text-sm mt-1"
              style={{ color: '#7C2D12', whiteSpace: 'pre-wrap' }}
            >
              {delivery.failed_delivery_reason}
            </p>
            {delivery.failed_delivery_photo_url && (
              <a
                href={delivery.failed_delivery_photo_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs hover:underline inline-flex items-center gap-1 mt-1"
                style={{ color: '#C2410C' }}
              >
                📷 Ver foto del intento
              </a>
            )}
          </div>
        </div>
      )}

      <hr
        className="mt-3"
        style={{ border: 0, borderTop: '1px solid var(--border)' }}
      />

      {/* Reportar problema — visible siempre, expandible. Va ANTES de
          "Confirmar entrega" para que el chofer pueda reportar
          incidencias mientras evalúa la entrega y antes de cerrarla. */}
      <ReportIssueBlock leadId={delivery.id} clientName={delivery.client_name} />

      {/* "No pude entregar" — bloque rojo, separado de reportar
          problema porque cambia el flujo: tras enviar este reporte la
          entrega NO se completa, queda como pendiente con la falla
          registrada. Mismo patrón expandible/colapsado. */}
      <FailedDeliveryBlock
        leadId={delivery.id}
        clientName={delivery.client_name}
      />

      <hr
        className="mt-4"
        style={{ border: 0, borderTop: '1px solid var(--border)' }}
      />

      <div className="mt-4">
        <div className="font-semibold mb-3">Confirmar entrega</div>

        {/* Aviso de flete — solo cuando hay costo de envío. El chofer
            sabe que parte del adeudo es por el viaje específicamente. */}
        {delivery.delivery_cost > 0 && (
          <div
            className="text-xs mb-3 p-2 rounded"
            style={{
              background: '#DBEAFE',
              color: '#1E3A8A',
              border: '1px solid rgba(30,64,175,0.20)',
            }}
            role="note"
          >
            🚗 Este pedido incluye{' '}
            <strong>{formatMXN(delivery.delivery_cost)}</strong> de costo
            de envío.
          </div>
        )}

        {owes ? (
          <>
            <div className="mb-3">
              <label className="label">¿Cómo cobró el cliente?</label>
              <div
                role="radiogroup"
                aria-label="Método de pago"
                className="grid grid-cols-3 gap-2"
              >
                {DRIVER_PAYMENT_METHOD_OPTIONS.map((m) => {
                  const active = paymentMethod === m.value;
                  return (
                    <button
                      key={m.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setPaymentMethod(m.value)}
                      disabled={pending}
                      className="btn"
                      style={{
                        padding: '8px 6px',
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        background: active
                          ? 'var(--brand-primary)'
                          : 'var(--bg-subtle)',
                        color: active ? '#fff' : 'var(--text-primary)',
                        border: active
                          ? '2px solid var(--brand-primary)'
                          : '2px solid transparent',
                        borderRadius: 8,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 2,
                        minHeight: 56,
                      }}
                    >
                      <span aria-hidden="true" style={{ fontSize: '1.25rem' }}>
                        {m.emoji}
                      </span>
                      <span>{m.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

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
              style={{
                cursor: pending ? 'not-allowed' : 'pointer',
                // Borde rojo cuando no hay foto — refuerzo visual de
                // que es obligatoria.
                borderColor: evidenceFile ? undefined : '#FCA5A5',
              }}
            >
              <Camera
                size={22}
                style={{ color: evidenceFile ? '#B91C1C' : '#DC2626' }}
                className="mx-auto mb-1"
              />
              <div
                className="text-sm font-medium"
                style={{ color: 'var(--text-primary)' }}
              >
                {evidenceFile
                  ? evidenceFile.name
                  : 'Foto de la entrega (obligatoria)'}
              </div>
              <div className="text-[11px]" style={{ color: '#B91C1C' }}>
                Obligatoria · JPG, PNG, WEBP o HEIC · máx. 10 MB
              </div>
              <input
                ref={fileRef}
                type="file"
                accept={PHOTO_ACCEPT_ATTR}
                capture="environment"
                onChange={(e) => setEvidenceFile(e.target.files?.[0] ?? null)}
                style={{ display: 'none' }}
                disabled={pending}
              />
            </div>

            {/* Selector de DESTINATARIO del efectivo. Sólo cuando
                el cobro es en efectivo (transferencia/Clip va directo
                a cuenta). Dos pasos:
                  1) Elegir rol — 'admin' o 'contador' (cards visuales).
                  2) Elegir persona específica de ese rol (dropdown).
                Cambiar el rol resetea el receiver_id. */}
            {isEfectivo && amount > 0 && (
              <div className="mb-3">
                <label className="label">
                  ¿A quién entregas el efectivo?
                </label>
                <div
                  role="radiogroup"
                  aria-label="Destinatario del efectivo"
                  className="grid grid-cols-2 gap-2"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={receiverRole === 'admin'}
                    onClick={() => {
                      setReceiverRole('admin');
                      setReceiverId('');
                    }}
                    disabled={pending}
                    className="btn"
                    style={{
                      padding: 12,
                      fontSize: '0.8125rem',
                      fontWeight: 600,
                      background:
                        receiverRole === 'admin'
                          ? 'var(--brand-primary)'
                          : 'var(--bg-subtle)',
                      color:
                        receiverRole === 'admin'
                          ? '#fff'
                          : 'var(--text-primary)',
                      border:
                        receiverRole === 'admin'
                          ? '2px solid var(--brand-primary)'
                          : '2px solid transparent',
                      borderRadius: 8,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 4,
                      minHeight: 72,
                    }}
                  >
                    <span aria-hidden="true" style={{ fontSize: '1.5rem' }}>
                      👔
                    </span>
                    <span>Al Admin</span>
                    <span
                      className="text-[10px]"
                      style={{
                        opacity: 0.8,
                        fontWeight: 400,
                        whiteSpace: 'normal',
                        lineHeight: 1.2,
                      }}
                    >
                      Entregar directamente al jefe
                    </span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={receiverRole === 'contador'}
                    onClick={() => {
                      setReceiverRole('contador');
                      setReceiverId('');
                    }}
                    disabled={pending}
                    className="btn"
                    style={{
                      padding: 12,
                      fontSize: '0.8125rem',
                      fontWeight: 600,
                      background:
                        receiverRole === 'contador'
                          ? 'var(--brand-primary)'
                          : 'var(--bg-subtle)',
                      color:
                        receiverRole === 'contador'
                          ? '#fff'
                          : 'var(--text-primary)',
                      border:
                        receiverRole === 'contador'
                          ? '2px solid var(--brand-primary)'
                          : '2px solid transparent',
                      borderRadius: 8,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 4,
                      minHeight: 72,
                    }}
                  >
                    <span aria-hidden="true" style={{ fontSize: '1.5rem' }}>
                      💼
                    </span>
                    <span>Al Contador</span>
                    <span
                      className="text-[10px]"
                      style={{
                        opacity: 0.8,
                        fontWeight: 400,
                        whiteSpace: 'normal',
                        lineHeight: 1.2,
                      }}
                    >
                      Entregar al contador de caja
                    </span>
                  </button>
                </div>

                {receiverRole && (
                  <div className="mt-3">
                    <label className="label">
                      {receiverRole === 'contador'
                        ? 'Selecciona el contador'
                        : 'Selecciona el admin'}
                    </label>
                    <select
                      className="select"
                      value={receiverId}
                      onChange={(e) => setReceiverId(e.target.value)}
                      disabled={pending}
                      style={{ height: 48, fontSize: '1rem' }}
                    >
                      <option value="">— selecciona —</option>
                      {eligibleReceivers.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    {eligibleReceivers.length === 0 && (
                      <p
                        className="text-xs mt-1"
                        style={{ color: 'var(--danger, #dc2626)' }}
                      >
                        No hay{' '}
                        {receiverRole === 'contador'
                          ? 'contadores'
                          : 'admins'}{' '}
                        activos en el sistema.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div
            className="mb-3 p-3 rounded-lg flex items-center gap-2"
            style={{
              background: '#DCFCE7',
              border: '1px solid rgba(22,163,74,0.25)',
              color: '#15803D',
            }}
            role="status"
          >
            <CircleCheckBig size={18} />
            <span className="text-sm font-medium">
              Este pedido ya está liquidado
            </span>
          </div>
        )}

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
          disabled={pending || !evidenceFile || evidenceFile.size === 0}
          aria-busy={pending}
          title={
            !evidenceFile && !pending
              ? 'Sube la foto de la entrega para continuar'
              : undefined
          }
        >
          {pending ? (
            <>
              <Loader size={20} className="animate-spin" />
              <span style={{ marginLeft: 6 }}>Confirmando…</span>
            </>
          ) : owes ? (
            <>
              <CircleCheckBig size={20} /> Confirmar entrega y cobro
            </>
          ) : (
            <>
              <CircleCheckBig size={20} /> Confirmar entrega
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * Sección al pie de la vista del chofer con el historial del día. Lista
 * compacta de las entregas marcadas como `entregado` hoy: cliente, monto,
 * método de pago (badge) y hora de entrega. Solo se renderiza si hay
 * ≥ 1 entrega; no mostramos card vacía.
 */
function DeliveredTodaySection({
  history,
}: {
  history: DeliveredTodayRow[];
}) {
  if (history.length === 0) return null;
  return (
    <div className="card p-4 mt-5">
      <div className="font-semibold mb-3 flex items-center gap-2">
        <CircleCheckBig size={18} style={{ color: '#15803D' }} />
        <span>Entregados hoy ({history.length})</span>
      </div>
      <div className="flex flex-col gap-2">
        {history.map((d) => {
          const methodMeta = DRIVER_PAYMENT_METHOD_OPTIONS.find(
            (m) => m.value === d.payment_method,
          );
          return (
            <div
              key={d.id}
              className="flex items-center justify-between gap-2 p-2 rounded-lg"
              style={{
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="text-sm font-medium truncate">
                  {d.client_name}
                </div>
                <div
                  className="text-xs"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  {formatTimeOfDay(d.delivered_at)}
                  {d.amount_collected > 0
                    ? ` · ${formatMXN(d.amount_collected)}`
                    : ' · ya liquidado'}
                </div>
              </div>
              {methodMeta ? (
                <span
                  className="badge"
                  style={{
                    background: '#E0E7FF',
                    color: '#3730A3',
                    fontSize: '0.6875rem',
                    fontWeight: 600,
                  }}
                  title={`Cobrado via ${methodMeta.label}`}
                >
                  {methodMeta.emoji} {methodMeta.label}
                </span>
              ) : (
                <span
                  className="badge"
                  style={{
                    background: '#DCFCE7',
                    color: '#15803D',
                    fontSize: '0.6875rem',
                    fontWeight: 600,
                  }}
                  title="Pedido ya liquidado, sin cobro hoy"
                >
                  ✓ Liquidado
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Hora local del chofer (CDMX). Reusa el helper shared para fijar
// timezone y mantener el formato consistente con el resto de la app.
const formatTimeOfDay = formatTimeCDMX;

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
    const photoCheck = validatePhotoFile(photo);
    if (!photoCheck.ok) {
      setError(`Foto del problema: ${photoCheck.message}`);
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
        style={{
          cursor: pending ? 'not-allowed' : 'pointer',
          borderColor: photo ? undefined : '#FCA5A5',
        }}
      >
        <Camera
          size={20}
          style={{ color: photo ? '#92400E' : '#DC2626' }}
          className="mx-auto mb-1"
        />
        <div
          className="text-sm font-medium"
          style={{ color: 'var(--text-primary)' }}
        >
          {photo ? photo.name : 'Foto del problema (obligatoria)'}
        </div>
        <div className="text-[11px]" style={{ color: '#B91C1C' }}>
          Obligatoria · JPG, PNG, WEBP o HEIC · máx. 10 MB
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={PHOTO_ACCEPT_ATTR}
          capture="environment"
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
        disabled={pending || success || !photo || photo.size === 0}
        aria-busy={pending}
        title={
          !photo && !pending
            ? 'Sube la foto del problema para continuar'
            : undefined
        }
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

/**
 * Bloque "No pude entregar" — botón rojo expandible. Distinto de
 * `ReportIssueBlock` (que es para faltantes/detalles SIN bloquear la
 * entrega): este flujo NO completa la entrega, deja el lead como
 * pendiente con `failed_delivery_reason` + foto del lugar registrados.
 *
 * Diferencias con ReportIssueBlock:
 *   - `description` es OBLIGATORIO con mín. 10 chars (vs 3 en issues).
 *   - La foto es OBLIGATORIA (vs opcional en issues).
 *   - El input file usa `capture="environment"` para abrir cámara
 *     trasera directamente en mobile (en desktop cae al picker normal).
 *
 * State local por card. Tras success el server hace
 * revalidatePath('/driver') y router.refresh() actualiza la card.
 */
function FailedDeliveryBlock({
  leadId,
  clientName,
}: {
  leadId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setReason('');
    setPhoto(null);
    setError(null);
    setSuccess(false);
    if (fileRef.current) fileRef.current.value = '';
  }

  function handleSubmit() {
    setError(null);
    if (reason.trim().length < 10) {
      setError('El motivo debe tener al menos 10 caracteres.');
      return;
    }
    const photoCheck = validatePhotoFile(photo);
    if (!photoCheck.ok) {
      setError(`Foto del lugar: ${photoCheck.message}`);
      return;
    }
    const fd = new FormData();
    fd.set('lead_id', leadId);
    fd.set('reason', reason.trim());
    if (photo) fd.set('photo', photo);

    startTransition(async () => {
      try {
        const r = await markFailedDeliveryAction({ status: 'idle' }, fd);
        if (r.status === 'success') {
          setSuccess(true);
          // Refresh inmediato — la card debe salir del modo
          // secuencial / pasar a la siguiente en cuanto el server
          // confirme. El delay corto evita un flash visual.
          setTimeout(() => {
            setOpen(false);
            reset();
            router.refresh();
          }, 800);
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
        className="btn btn-outline w-full mt-3"
        style={{
          height: 44,
          color: '#B91C1C',
          borderColor: '#FECACA',
          background: '#FEF2F2',
        }}
        aria-label={`Marcar entrega como fallida para ${clientName}`}
      >
        <X size={16} /> No pude entregar
      </button>
    );
  }

  return (
    <div
      className="mt-3 p-4 rounded-lg"
      style={{
        background: '#FEF2F2',
        border: '1px solid #FECACA',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <div
          className="font-semibold flex items-center gap-2"
          style={{ color: '#B91C1C' }}
        >
          <X size={16} /> Marcar como no entregada
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
          aria-label="Cancelar"
        >
          <X size={16} />
        </button>
      </div>

      <div className="mb-3">
        <label className="label">
          Motivo <span style={{ color: '#B91C1C' }}>*</span>
        </label>
        <textarea
          className="textarea"
          rows={3}
          placeholder="Describe por qué no pudiste entregar (cliente ausente, dirección incorrecta, rechazo…)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={pending}
          style={{ fontSize: '1rem' }}
          maxLength={1000}
        />
        <div
          className="text-[11px] mt-1"
          style={{
            color:
              reason.trim().length < 10
                ? 'var(--danger, #dc2626)'
                : 'var(--text-tertiary)',
          }}
        >
          {reason.trim().length < 10
            ? `Mínimo 10 caracteres (${reason.trim().length}/10)`
            : `${reason.length}/1000`}
        </div>
      </div>

      <div
        className="dropzone mb-3"
        onClick={() => !pending && fileRef.current?.click()}
        style={{
          cursor: pending ? 'not-allowed' : 'pointer',
          // Borde rojo si la foto aún no se subió — refuerzo visual
          // de que es obligatoria.
          borderColor: photo ? undefined : '#FCA5A5',
        }}
      >
        <Camera
          size={22}
          style={{ color: photo ? '#B91C1C' : '#DC2626' }}
          className="mx-auto mb-1"
        />
        <div
          className="text-sm font-medium"
          style={{ color: 'var(--text-primary)' }}
        >
          {photo ? photo.name : 'Toma foto del lugar'}
        </div>
        <div className="text-[11px]" style={{ color: '#B91C1C' }}>
          Obligatoria · cámara trasera en mobile
        </div>
        <input
          ref={fileRef}
          type="file"
          // capture="environment" abre la cámara trasera en mobile
          // (Android/iOS). En desktop cae al picker normal.
          accept={PHOTO_ACCEPT_ATTR}
          capture="environment"
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
          <span>Falla registrada. Avanzando a la siguiente…</span>
        </div>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        className="btn w-full"
        style={{
          height: 48,
          fontSize: '1rem',
          fontWeight: 600,
          background: '#DC2626',
          color: '#fff',
        }}
        disabled={pending || success || !photo || photo.size === 0}
        aria-busy={pending}
        title={
          !photo && !pending
            ? 'Sube la foto del lugar para continuar'
            : undefined
        }
      >
        {pending ? (
          <>
            <Loader size={18} className="animate-spin" />
            <span style={{ marginLeft: 6 }}>Registrando…</span>
          </>
        ) : (
          'Registrar falla y continuar'
        )}
      </button>
    </div>
  );
}
