'use client';

import { useEffect, useTransition } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { X, Phone, Loader } from 'lucide-react';
import {
  SellerCreateSchema,
  SellerUpdateSchema,
  initialSellerFormState,
} from './schema';
import { createSellerAction, updateSellerAction } from './actions';

/**
 * Modal compartido para crear/editar un vendedor.
 *
 * Misma política de errores que `NewUserModal` en /admin/users: validación
 * cliente vía Zod, errores del server pintados en banner + por campo,
 * `console.log` en cada intento para diagnóstico.
 */

type CreateProps = {
  mode: 'create';
  onClose: () => void;
  onSuccess: () => void;
};
type EditProps = {
  mode: 'edit';
  initial: { id: string; name: string; phone: string | null };
  onClose: () => void;
  onSuccess: () => void;
};
type Props = CreateProps | EditProps;

// Forma común del formulario. En modo `create` `id` no existe; en `edit` sí
// y es validado por SellerUpdateSchema. Tipamos al supremo para que RHF acepte
// ambos flujos sin forzar discriminated unions en el form state.
type SellerFormValues = {
  id?: string;
  name: string;
  phone?: string;
};

export function SellerModal(props: Props) {
  const isEdit = props.mode === 'edit';
  const [pending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<SellerFormValues>({
    // El cast es necesario porque cada schema infiere un tipo distinto y
    // queremos un solo `useForm<SellerFormValues>`.
    resolver: (isEdit
      ? zodResolver(SellerUpdateSchema)
      : zodResolver(SellerCreateSchema)) as Resolver<SellerFormValues>,
    defaultValues: isEdit
      ? {
          id: props.initial.id,
          name: props.initial.name,
          phone: props.initial.phone ?? '',
        }
      : { name: '', phone: '' },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props, pending]);

  const onValidSubmit = (values: SellerFormValues) => {
    clearErrors('root.serverError');

    const fd = new FormData();
    fd.set('name', values.name);
    fd.set('phone', values.phone ?? '');
    if (isEdit && values.id) fd.set('id', values.id);

    console.log('[SellerModal] enviando…', { mode: props.mode, ...values });

    startTransition(async () => {
      try {
        const result = isEdit
          ? await updateSellerAction(initialSellerFormState, fd)
          : await createSellerAction(initialSellerFormState, fd);

        console.log('[SellerModal] respuesta:', result);

        if (result.status === 'success') {
          props.onSuccess();
          return;
        }
        if (result.status === 'error') {
          if (result.fieldErrors) {
            for (const [field, msgs] of Object.entries(result.fieldErrors)) {
              if (msgs && msgs[0]) {
                setError(field as keyof SellerFormValues, {
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
        console.error('[SellerModal] excepción al invocar la acción:', err);
        setError('root.serverError', { type: 'server', message });
      }
    });
  };

  const rootError = errors.root?.serverError?.message;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.45)' }}
      onClick={() => {
        if (!pending) props.onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="seller-modal-title"
    >
      <div
        className="card w-full max-w-md p-6 animate-fade"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 id="seller-modal-title" className="font-semibold text-lg">
            {isEdit ? 'Editar Vendedor' : 'Nuevo Vendedor'}
          </h3>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ padding: '6px' }}
            onClick={props.onClose}
            disabled={pending}
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
          {isEdit && <input type="hidden" {...register('id')} />}

          <Field label="Nombre completo" error={errors.name?.message}>
            <input
              {...register('name')}
              className="input"
              placeholder="Ej. Ana López"
              autoComplete="name"
              disabled={pending}
            />
          </Field>

          <Field label="Teléfono (opcional)" error={errors.phone?.message}>
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
              <span>{isEdit ? 'Actualizando…' : 'Creando vendedor…'}</span>
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
              <strong>
                {isEdit ? 'No se pudo actualizar.' : 'No se pudo crear.'}
              </strong>
              <br />
              {rootError}
            </div>
          )}

          <div className="flex gap-2 mt-2">
            <button
              type="button"
              className="btn btn-outline flex-1"
              onClick={props.onClose}
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
                  <span style={{ marginLeft: 6 }}>
                    {isEdit ? 'Guardando…' : 'Creando…'}
                  </span>
                </>
              ) : isEdit ? (
                'Guardar cambios'
              ) : (
                'Crear vendedor'
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
