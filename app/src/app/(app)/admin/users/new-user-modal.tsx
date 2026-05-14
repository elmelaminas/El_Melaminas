'use client';

import { useEffect, useTransition } from 'react';
import { useForm, type FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { X, Mail, Phone, Loader } from 'lucide-react';
import {
  CreateUserSchema,
  initialCreateUserState,
  type CreateUserInput,
} from './schema';
import { createUserAction } from './actions';
import type { Role } from '@/data/mock';

// NB: este array es DISTINTO de `ROLES` en `./schema.ts`. Aquel es la
// tupla literal que Zod usa para validar el enum; éste es el array de
// `{value, label}` que renderiza el dropdown. Si agregas un nuevo rol,
// hay que tocar AMBOS — TypeScript no obliga exhaustividad sobre arrays
// (a diferencia de `Record<Role, …>` que sí cazaría el faltante).
const ROLES: { value: Role; label: string }[] = [
  { value: 'admin', label: 'Administrador' },
  { value: 'admin2', label: 'Administrador 2' },
  { value: 'seller', label: 'Vendedor' },
  { value: 'driver', label: 'Chofer' },
  { value: 'warehouse', label: 'Almacén' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'contador', label: 'Contador' },
];

/**
 * Modal "Nuevo Usuario".
 *
 * **Política de errores**: TODA falla — sea de validación cliente, retorno
 * de la action, o throw inesperado al invocarla — termina visible en el
 * banner rojo del modal y logueado a `console.error`. Tres caminos:
 *  - `onInvalidSubmit`: RHF reportó errores de campo. Field-level errors
 *    ya pintan; agregamos un log para diagnóstico.
 *  - `result.status === 'error'`: la action retornó error legible. Pintamos
 *    el `message` en banner + mapeamos `fieldErrors` a inputs.
 *  - `catch`: el `await` rechazó (bug en serialización, network, env vars
 *    faltantes que escaparon del try del server). Pintamos el message del
 *    Error y logueamos.
 */
export function NewUserModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [pending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<CreateUserInput>({
    resolver: zodResolver(CreateUserSchema),
    defaultValues: {
      full_name: '',
      email: '',
      phone: '',
      role: 'seller',
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const onValidSubmit = (values: CreateUserInput) => {
    // Limpiamos cualquier error previo antes de un nuevo intento.
    clearErrors('root.serverError');

    const fd = new FormData();
    fd.set('full_name', values.full_name);
    fd.set('email', values.email);
    fd.set('phone', values.phone ?? '');
    fd.set('role', values.role);

    // Diagnóstico: confirma que el handler se disparó. Visible en DevTools.
    console.log('[NewUserModal] enviando createUserAction…', { ...values, phone: values.phone });

    startTransition(async () => {
      try {
        const result = await createUserAction(initialCreateUserState, fd);
        console.log('[NewUserModal] respuesta de createUserAction:', result);

        if (result.status === 'success') {
          onSuccess();
          return;
        }

        if (result.status === 'error') {
          if (result.fieldErrors) {
            for (const [field, msgs] of Object.entries(result.fieldErrors)) {
              if (msgs && msgs[0]) {
                setError(field as keyof CreateUserInput, {
                  type: 'server',
                  message: msgs[0],
                });
              }
            }
          }
          setError('root.serverError', {
            type: 'server',
            message: result.message,
          });
        }
      } catch (err) {
        // Esto solo pasa si la action throw'eó algo que escapó al try/catch
        // del server (no debería con el wrap actual, pero por si acaso).
        const message =
          err instanceof Error
            ? err.message
            : 'Error de red o servidor al invocar la acción';
        console.error('[NewUserModal] excepción al invocar la acción:', err);
        setError('root.serverError', { type: 'server', message });
      }
    });
  };

  const onInvalidSubmit = (formErrors: FieldErrors<CreateUserInput>) => {
    // RHF ya pintó los errores por campo; lo logueamos para que el
    // diagnóstico en DevTools sea explícito si "no pasa nada".
    console.warn('[NewUserModal] validación cliente falló:', formErrors);
  };

  const rootError = errors.root?.serverError?.message;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.45)' }}
      onClick={() => {
        if (!pending) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-user-title"
    >
      <div
        className="card w-full max-w-md p-6 animate-fade"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 id="new-user-title" className="font-semibold text-lg">
            Nuevo Usuario
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

        <form
          onSubmit={handleSubmit(onValidSubmit, onInvalidSubmit)}
          noValidate
          className="flex flex-col gap-4"
        >
          <Field label="Nombre completo" error={errors.full_name?.message}>
            <input
              {...register('full_name')}
              className="input"
              placeholder="Ej. Juan García"
              autoComplete="name"
              disabled={pending}
            />
          </Field>

          <Field label="Correo" error={errors.email?.message}>
            <div className="relative">
              <Mail
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--text-tertiary)' }}
              />
              <input
                {...register('email')}
                type="email"
                className="input"
                style={{ paddingLeft: 36 }}
                placeholder="usuario@elmelaminas.com"
                autoComplete="email"
                disabled={pending}
              />
            </div>
          </Field>

          <Field label="Teléfono" error={errors.phone?.message}>
            <div className="relative">
              <Phone
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--text-tertiary)' }}
              />
              <input
                {...register('phone')}
                type="tel"
                className="input"
                style={{ paddingLeft: 36 }}
                placeholder="55 1234 5678"
                autoComplete="tel"
                disabled={pending}
              />
            </div>
          </Field>

          <Field label="Rol" error={errors.role?.message}>
            <select {...register('role')} className="select" disabled={pending}>
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>

          {/* Banner de progreso — visible mientras la action está en vuelo.
              Confirma al usuario que SÍ se está ejecutando algo. */}
          {pending && (
            <div
              role="status"
              aria-live="polite"
              className="text-sm flex items-center gap-2"
              style={{
                color: 'var(--text-secondary)',
                background: 'var(--surface-2, rgba(15,23,42,0.04))',
                padding: '8px 12px',
                borderRadius: 6,
              }}
            >
              <Loader size={16} className="animate-spin" />
              <span>Creando usuario en Supabase…</span>
            </div>
          )}

          {/* Banner de error — visible si la action retornó error o lanzó. */}
          {rootError && !pending && (
            <div
              role="alert"
              className="text-sm"
              style={{
                color: 'var(--danger, #dc2626)',
                background: 'var(--danger-bg, rgba(220,38,38,0.08))',
                border: '1px solid rgba(220,38,38,0.25)',
                padding: '8px 12px',
                borderRadius: 6,
                whiteSpace: 'pre-wrap',
              }}
            >
              <strong>No se pudo crear el usuario.</strong>
              <br />
              {rootError}
            </div>
          )}

          <div className="flex gap-2 mt-2">
            <button
              type="button"
              className="btn btn-outline flex-1"
              onClick={onClose}
              disabled={pending}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="btn btn-primary flex-1"
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? (
                <>
                  <Loader size={16} className="animate-spin" />
                  <span style={{ marginLeft: 6 }}>Creando…</span>
                </>
              ) : (
                'Crear usuario'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {error && (
        <p className="text-xs mt-1" style={{ color: 'var(--danger, #dc2626)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
