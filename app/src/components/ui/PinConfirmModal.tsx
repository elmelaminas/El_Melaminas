'use client';

import { useEffect, useRef, useState } from 'react';
import {
  KeyRound,
  Loader,
  ShieldAlert,
  X,
} from 'lucide-react';

/**
 * Modal reutilizable de confirmación con PIN en dos pasos.
 *
 * Paso 1 — RESUMEN: pinta una lista de `details` (clave/valor) para
 *   que el usuario revise contra qué está actuando. Botones "Cancelar"
 *   y "Sí, continuar →".
 * Paso 2 — PIN: input numérico de 4 dígitos (type=password). Al pulsar
 *   "Confirmar recepción" se llama `onConfirm(pin)` y se interpreta
 *   el resultado:
 *     - success=true → cerramos el modal (el caller hace router.refresh).
 *     - success=false:
 *         · reason='pin_incorrect' → contador de intentos. Al tercero,
 *           lock de 30s antes de permitir reintento.
 *         · reason='pin_missing' → bloqueo definitivo en el modal
 *           (PIN no configurado en perfil).
 *         · cualquier otro / sin reason → mostrar `error` literal.
 *
 * Diseño:
 *   - El componente NO conoce nada del dominio (cash transfer, payment,
 *     etc.); todo viaja por props. Es 100% reutilizable.
 *   - El consumer pasa una promesa `onConfirm(pin)` con su propia
 *     server action; el modal solo gestiona la UI del flujo.
 *   - ESC cierra (cuando no está enviando) — mismo patrón que el resto
 *     de modales del módulo.
 *   - Auto-focus al input al entrar al paso PIN.
 */
export type PinConfirmResult = {
  success: boolean;
  error?: string;
  /** Sub-clasificación del error para que el modal decida si reintenta
   *  ('pin_incorrect') o queda bloqueado ('pin_missing'). Cualquier
   *  valor distinto a 'pin_incorrect'/'pin_missing' (incluyendo
   *  'already_validated'/'already_received' u 'other') solo muestra
   *  el mensaje sin reabrir reintentos. */
  reason?:
    | 'pin_incorrect'
    | 'pin_missing'
    | 'already_validated'
    | 'already_received'
    | 'other';
};

export function PinConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  details,
  confirmText = 'Confirmar recepción',
  intro = '¿Estás recibiendo el efectivo de:',
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (pin: string) => Promise<PinConfirmResult>;
  /** Título del modal (paso 1). */
  title: string;
  /** Lista de pares clave/valor a mostrar en el paso 1 como resumen. */
  details: { label: string; value: React.ReactNode }[];
  /** Texto del botón final (paso 2). */
  confirmText?: string;
  /** Texto de introducción al resumen — útil para variar el copy
   *  entre "¿Estás recibiendo X?" / "¿Confirmas Y?". */
  intro?: string;
}) {
  const [step, setStep] = useState<'confirm' | 'pin'>('confirm');
  const [pin, setPin] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  // Lockout: timestamp futuro hasta el cual no permitimos reintento.
  // `Number.MAX_SAFE_INTEGER` significa bloqueo permanente (p.ej. PIN
  // no configurado — el usuario debe cerrar el modal y actuar fuera).
  const [lockUntil, setLockUntil] = useState<number | null>(null);
  const [, forceTick] = useState(0);
  const pinInputRef = useRef<HTMLInputElement>(null);

  // Reset interno cuando el modal se reabre. Importante: sin esto, si
  // un usuario falla, cierra y vuelve a abrir, el estado quedaría
  // sucio.
  useEffect(() => {
    if (isOpen) {
      setStep('confirm');
      setPin('');
      setError(null);
      setAttempts(0);
      setLockUntil(null);
      setPending(false);
    }
  }, [isOpen]);

  // ESC cierra cuando no está enviando.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, pending]);

  // Focus al input al entrar al paso PIN.
  useEffect(() => {
    if (isOpen && step === 'pin') {
      pinInputRef.current?.focus();
    }
  }, [isOpen, step]);

  // Tick de 1s mientras hay lockout temporal — refresca contador
  // visible y libera el botón al expirar. No corre cuando el lock
  // es permanente (MAX_SAFE_INTEGER) ni cuando no hay lock.
  useEffect(() => {
    if (lockUntil == null) return;
    if (lockUntil === Number.MAX_SAFE_INTEGER) return;
    const id = setInterval(() => {
      if (lockUntil <= Date.now()) {
        setLockUntil(null);
        setAttempts(0);
      } else {
        forceTick((n) => n + 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [lockUntil]);

  if (!isOpen) return null;

  const lockedSecondsLeft =
    lockUntil != null && lockUntil !== Number.MAX_SAFE_INTEGER
      ? Math.max(0, Math.ceil((lockUntil - Date.now()) / 1000))
      : 0;
  const isLocked = lockUntil != null;

  const handleSubmit = async () => {
    if (!/^\d{4}$/.test(pin)) {
      setError('Ingresa los 4 dígitos del PIN.');
      return;
    }
    if (isLocked) return;
    setError(null);
    setPending(true);
    try {
      const result = await onConfirm(pin);
      if (result.success) {
        onClose();
        return;
      }
      // Errores diferenciados según reason.
      if (result.reason === 'pin_incorrect') {
        const next = attempts + 1;
        setAttempts(next);
        setPin('');
        if (next >= 3) {
          setLockUntil(Date.now() + 30_000);
          setError(
            'Demasiados intentos fallidos. Espera 30 segundos antes de reintentar.',
          );
        } else {
          setError(`PIN incorrecto. Intento ${next} de 3.`);
        }
      } else if (result.reason === 'pin_missing') {
        // PIN no configurado: bloqueo permanente del modal.
        setError(
          result.error ??
            'No tienes PIN configurado. Contacta al administrador.',
        );
        setLockUntil(Number.MAX_SAFE_INTEGER);
      } else {
        setError(result.error ?? 'No se pudo confirmar.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error de red';
      setError(message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.55)' }}
      onClick={() => {
        if (!pending) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pin-modal-title"
    >
      <div
        className="card w-full max-w-md p-6 animate-fade"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3
            id="pin-modal-title"
            className="font-semibold text-lg flex items-center gap-2"
          >
            {step === 'confirm' ? (
              <>
                <ShieldAlert size={18} style={{ color: '#D97706' }} />
                {title}
              </>
            ) : (
              <>
                <KeyRound size={18} style={{ color: '#4338CA' }} />
                Ingresa tu PIN de confirmación
              </>
            )}
          </h3>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ padding: '6px' }}
            onClick={onClose}
            disabled={pending}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        {step === 'confirm' ? (
          <>
            <p
              className="text-sm mb-4"
              style={{ color: 'var(--text-secondary)' }}
            >
              {intro}
            </p>
            <div
              className="card p-4 mb-4"
              style={{
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border)',
              }}
            >
              {details.map((d, i) => (
                <div
                  key={`${d.label}-${i}`}
                  className="flex items-baseline justify-between gap-3 text-sm py-1"
                >
                  <span style={{ color: 'var(--text-tertiary)' }}>
                    {d.label}:
                  </span>
                  <span
                    style={{
                      color: 'var(--text-primary)',
                      textAlign: 'right',
                    }}
                  >
                    {d.value}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-outline flex-1"
                onClick={onClose}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-primary flex-1"
                onClick={() => setStep('pin')}
              >
                Sí, continuar →
              </button>
            </div>
          </>
        ) : (
          <>
            <input
              ref={pinInputRef}
              type="password"
              inputMode="numeric"
              pattern="[0-9]{4}"
              maxLength={4}
              autoComplete="off"
              className="input mb-2"
              style={{
                textAlign: 'center',
                fontSize: '1.5rem',
                letterSpacing: '0.6em',
                paddingLeft: '0.6em',
              }}
              placeholder="••••"
              value={pin}
              onChange={(e) => {
                const onlyDigits = e.target.value
                  .replace(/\D/g, '')
                  .slice(0, 4);
                setPin(onlyDigits);
                if (error && !isLocked) setError(null);
              }}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  pin.length === 4 &&
                  !pending &&
                  !isLocked
                ) {
                  void handleSubmit();
                }
              }}
              disabled={pending || isLocked}
            />
            <p
              className="text-xs mb-3"
              style={{ color: 'var(--text-tertiary)' }}
            >
              4 dígitos numéricos. Si no tienes PIN, contacta al admin.
            </p>

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
                }}
              >
                {error}
                {lockedSecondsLeft > 0 && (
                  <span style={{ marginLeft: 4 }}>
                    ({lockedSecondsLeft}s)
                  </span>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-outline flex-1"
                onClick={onClose}
                disabled={pending}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-primary flex-1"
                onClick={() => void handleSubmit()}
                disabled={pending || isLocked || pin.length !== 4}
                aria-busy={pending}
              >
                {pending ? (
                  <>
                    <Loader size={14} className="animate-spin" />
                    <span style={{ marginLeft: 6 }}>Validando…</span>
                  </>
                ) : (
                  confirmText
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
