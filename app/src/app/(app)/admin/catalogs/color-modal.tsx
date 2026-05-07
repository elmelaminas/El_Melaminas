'use client';

import { useEffect, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { X, Loader } from 'lucide-react';
import {
  ColorUpdateSchema,
  initialColorFormState,
  type ColorUpdateInput,
} from './schema';
import { updateColorAction } from './actions';

/**
 * Modal para editar el nombre de un color. No permite crear desde aquí —
 * los colores nuevos se crean implícitamente al registrar un lead con un
 * color que no existe (módulo B, /leads/new).
 */
export function ColorModal({
  initial,
  onClose,
  onSuccess,
}: {
  initial: { id: string; name: string };
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
  } = useForm<ColorUpdateInput>({
    resolver: zodResolver(ColorUpdateSchema),
    defaultValues: { id: initial.id, name: initial.name },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const onValidSubmit = (values: ColorUpdateInput) => {
    clearErrors('root.serverError');
    const fd = new FormData();
    fd.set('id', values.id);
    fd.set('name', values.name);

    console.log('[ColorModal] enviando…', values);

    startTransition(async () => {
      try {
        const result = await updateColorAction(initialColorFormState, fd);
        console.log('[ColorModal] respuesta:', result);

        if (result.status === 'success') {
          onSuccess();
          return;
        }
        if (result.status === 'error') {
          if (result.fieldErrors) {
            for (const [field, msgs] of Object.entries(result.fieldErrors)) {
              if (msgs && msgs[0]) {
                setError(field as keyof ColorUpdateInput, {
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
        console.error('[ColorModal] excepción al invocar la acción:', err);
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
        if (!pending) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="color-modal-title"
    >
      <div
        className="card w-full max-w-md p-6 animate-fade"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 id="color-modal-title" className="font-semibold text-lg">
            Editar Color
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
          onSubmit={handleSubmit(onValidSubmit)}
          noValidate
          className="flex flex-col gap-4"
        >
          <input type="hidden" {...register('id')} />

          <Field label="Nombre del color" error={errors.name?.message}>
            <input
              {...register('name')}
              className="input"
              placeholder="Ej. Negra"
              disabled={pending}
            />
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
              <span>Actualizando…</span>
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
              <strong>No se pudo actualizar.</strong>
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
