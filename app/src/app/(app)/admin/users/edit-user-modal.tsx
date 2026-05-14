'use client';

import { useEffect, useTransition } from 'react';
import { useForm, type FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { X, Mail, Phone, Loader } from 'lucide-react';
import {
  EditUserSchema,
  initialEditUserState,
  type EditUserInput,
} from './schema';
import { updateUserAction } from './actions';
import type { Role } from '@/data/mock';

// Lista de roles para el dropdown — duplicada de new-user-modal.tsx por
// simetría visual del módulo. Si modificas una, modifica la otra (o
// muévelas a schema.ts si crece). TypeScript no obliga exhaustividad
// sobre arrays planos, así que un rol faltante NO se cacha en build.
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
 * Modal "Editar Usuario".
 *
 * Recibe los datos actuales como `initialValues` y los precarga en
 * el form. El email se muestra como read-only (es identificador de
 * Supabase Auth) y la contraseña no se toca acá — para resetear,
 * existe /forgot-password.
 *
 * Política de errores y patrón: idéntica a `NewUserModal`:
 *  - onInvalidSubmit: RHF reportó errores, log para diagnóstico.
 *  - result.status === 'error': pintamos message + fieldErrors.
 *  - catch: pintamos el message del Error y logueamos.
 *
 * Anti-self-demote: el server valida que un admin no se quite el
 * rol a sí mismo. La validación llega de vuelta como `fieldErrors.role`
 * o como root error según el caso.
 */
export function EditUserModal({
  initialValues,
  onClose,
  onSuccess,
}: {
  initialValues: {
    id: string;
    full_name: string;
    email: string;
    phone: string | null;
    role: Role;
  };
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [pending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors, isDirty },
  } = useForm<EditUserInput>({
    resolver: zodResolver(EditUserSchema),
    defaultValues: {
      profile_id: initialValues.id,
      full_name: initialValues.full_name,
      phone: initialValues.phone ?? '',
      role: initialValues.role,
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const onValidSubmit = (values: EditUserInput) => {
    clearErrors('root.serverError');

    const fd = new FormData();
    fd.set('profile_id', values.profile_id);
    fd.set('full_name', values.full_name);
    fd.set('phone', values.phone ?? '');
    fd.set('role', values.role);

    console.log('[EditUserModal] enviando updateUserAction…', {
      ...values,
      phone: values.phone,
    });

    startTransition(async () => {
      try {
        const result = await updateUserAction(initialEditUserState, fd);
        console.log('[EditUserModal] respuesta de updateUserAction:', result);

        if (result.status === 'success') {
          onSuccess();
          return;
        }

        if (result.status === 'error') {
          if (result.fieldErrors) {
            for (const [field, msgs] of Object.entries(result.fieldErrors)) {
              if (msgs && msgs[0]) {
                setError(field as keyof EditUserInput, {
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
        const message =
          err instanceof Error
            ? err.message
            : 'Error de red o servidor al invocar la acción';
        console.error('[EditUserModal] excepción al invocar la acción:', err);
        setError('root.serverError', { type: 'server', message });
      }
    });
  };

  const onInvalidSubmit = (formErrors: FieldErrors<EditUserInput>) => {
    console.warn('[EditUserModal] validación cliente falló:', formErrors);
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
      aria-labelledby="edit-user-title"
    >
      <div
        className="card w-full max-w-md p-6 animate-fade"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 id="edit-user-title" className="font-semibold text-lg">
            Editar Usuario
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
          {/* profile_id viaja como hidden field — el server lo lee del
              FormData y valida con Zod. No editable en UI. */}
          <input type="hidden" {...register('profile_id')} />

          <Field label="Nombre completo" error={errors.full_name?.message}>
            <input
              {...register('full_name')}
              className="input"
              placeholder="Ej. Juan García"
              autoComplete="name"
              disabled={pending}
            />
          </Field>

          {/* Correo: read-only, informativo. Es el identificador de auth;
              cambiarlo requiere un flujo de email change confirm. */}
          <div>
            <label className="label">Correo</label>
            <div className="relative">
              <Mail
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--text-tertiary)' }}
              />
              <input
                type="email"
                className="input"
                style={{
                  paddingLeft: 36,
                  background: 'var(--bg-muted)',
                  color: 'var(--text-secondary)',
                }}
                value={initialValues.email}
                placeholder="—"
                disabled
                readOnly
                aria-readonly="true"
              />
            </div>
            <p
              className="text-xs mt-1"
              style={{ color: 'var(--text-tertiary)' }}
            >
              El correo es el identificador de la cuenta y no se puede
              cambiar desde aquí.
            </p>
          </div>

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
            <select
              {...register('role')}
              className="select"
              disabled={pending}
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>

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
              <span>Guardando cambios…</span>
            </div>
          )}

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
              <strong>No se pudo actualizar el usuario.</strong>
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
              disabled={pending || !isDirty}
              aria-busy={pending}
              title={
                !isDirty && !pending
                  ? 'No hay cambios para guardar'
                  : undefined
              }
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
        <p
          className="text-xs mt-1"
          style={{ color: 'var(--danger, #dc2626)' }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
