'use client';

import { useEffect, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { X, Mail, Phone } from 'lucide-react';
import {
  CreateUserSchema,
  createUserAction,
  initialCreateUserState,
  type CreateUserInput,
} from './actions';
import type { Role } from '@/data/mock';

const ROLES: { value: Role; label: string }[] = [
  { value: 'admin', label: 'Administrador' },
  { value: 'seller', label: 'Vendedor' },
  { value: 'driver', label: 'Chofer' },
  { value: 'warehouse', label: 'Almacén' },
  { value: 'supervisor', label: 'Supervisor' },
];

/**
 * Modal "Nuevo Usuario".
 *
 * Patrón:
 *  - RHF + zodResolver para validación de UX en cliente (errores instantáneos
 *    por campo).
 *  - El submit válido construye un FormData y llama al Server Action via
 *    `useTransition` — la action vuelve a validar con el mismo schema en el
 *    servidor (defensa en profundidad).
 *  - Si la action regresa errores de campo (improbable porque el cliente ya
 *    validó, pero posible si llega FormData malformado vía POST directo),
 *    los pintamos también.
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

  // ESC cierra el modal — patrón estándar de accesibilidad.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onValidSubmit = (values: CreateUserInput) => {
    const fd = new FormData();
    fd.set('full_name', values.full_name);
    fd.set('email', values.email);
    fd.set('phone', values.phone ?? '');
    fd.set('role', values.role);

    startTransition(async () => {
      // `prev` no se lee dentro de la action — la firma sigue el patrón
      // `useActionState` para mantener compatibilidad si en el futuro
      // queremos cambiar al hook estándar sin tocar el server.
      const result = await createUserAction(initialCreateUserState, fd);

      if (result.status === 'success') {
        onSuccess();
        return;
      }

      if (result.status === 'error') {
        // Mapear errores de campo del server al form si existen.
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
    });
  };

  const rootError = errors.root?.serverError?.message;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.45)' }}
      onClick={onClose}
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
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        <form
          onSubmit={handleSubmit(onValidSubmit)}
          noValidate
          className="flex flex-col gap-4"
        >
          <Field
            label="Nombre completo"
            error={errors.full_name?.message}
          >
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

          {rootError && (
            <div
              role="alert"
              className="text-sm"
              style={{
                color: 'var(--danger, #dc2626)',
                background: 'var(--danger-bg, rgba(220,38,38,0.08))',
                padding: '8px 12px',
                borderRadius: 6,
              }}
            >
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
            <button type="submit" className="btn btn-primary flex-1" disabled={pending}>
              {pending ? 'Creando...' : 'Crear usuario'}
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
