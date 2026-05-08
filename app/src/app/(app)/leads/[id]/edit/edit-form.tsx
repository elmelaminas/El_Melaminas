'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, Calendar, Loader } from 'lucide-react';
import {
  LeadEditSchema,
  initialLeadEditState,
  type LeadEditInput,
} from './schema';
import { updateLeadAction } from './actions';

export type DriverOption = { id: string; name: string };

/**
 * Formulario de edición de lead — solo fecha y chofer.
 *
 * Recibe los valores actuales como props (hidratación server-side) para
 * que el form arranque con los datos del lead seleccionado. Submit envía
 * `FormData` al action ligado por `.bind(null, leadId)` para que el
 * leadId no viaje en el body — más limpio y no manipulable desde
 * DevTools.
 */
export function EditLeadForm({
  leadId,
  clientName,
  initialSaleDate,
  initialDriverId,
  drivers,
}: {
  leadId: string;
  clientName: string;
  initialSaleDate: string;
  initialDriverId: string;
  drivers: DriverOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const {
    register,
    handleSubmit,
    setError,
    clearErrors,
    formState: { errors, isDirty },
  } = useForm<LeadEditInput>({
    resolver: zodResolver(LeadEditSchema),
    defaultValues: {
      sale_date: initialSaleDate,
      driver_id: initialDriverId,
    },
  });

  const onValidSubmit = (values: LeadEditInput) => {
    clearErrors('root.serverError');

    const fd = new FormData();
    fd.set('sale_date', values.sale_date);
    fd.set('driver_id', values.driver_id ?? '');

    startTransition(async () => {
      try {
        const result = await updateLeadAction(leadId, initialLeadEditState, fd);
        if (result.status === 'success') {
          router.push('/leads');
          router.refresh();
          return;
        }
        if (result.status === 'error') {
          if (result.fieldErrors) {
            for (const [field, msgs] of Object.entries(result.fieldErrors)) {
              if (msgs && msgs[0]) {
                setError(field as keyof LeadEditInput, {
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
        console.error('[EditLeadForm] excepción al invocar la acción:', err);
        setError('root.serverError', { type: 'server', message });
      }
    });
  };

  const rootError = errors.root?.serverError?.message;

  return (
    <form
      onSubmit={handleSubmit(onValidSubmit)}
      noValidate
      className="flex flex-col gap-6 max-w-xl"
    >
      <div className="flex items-center gap-3">
        <Link
          href="/leads"
          className="btn btn-ghost"
          style={{ padding: '8px' }}
          aria-label="Regresar"
        >
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Editar Lead</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            <strong>{clientName || '(sin nombre)'}</strong> · solo fecha y chofer
          </p>
        </div>
      </div>

      <div className="card p-6 flex flex-col gap-4">
        <div>
          <label className="label">Fecha</label>
          <div className="relative">
            <Calendar
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'var(--text-tertiary)' }}
            />
            <input
              {...register('sale_date')}
              type="date"
              className="input"
              style={{ paddingLeft: 36 }}
              disabled={pending}
            />
          </div>
          {errors.sale_date?.message && (
            <p
              className="text-xs mt-1"
              style={{ color: 'var(--danger, #dc2626)' }}
            >
              {errors.sale_date.message}
            </p>
          )}
        </div>

        <div>
          <label className="label">Chofer asignado</label>
          <select
            {...register('driver_id')}
            className="select"
            disabled={pending}
          >
            <option value="">— Sin asignar —</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          {errors.driver_id?.message && (
            <p
              className="text-xs mt-1"
              style={{ color: 'var(--danger, #dc2626)' }}
            >
              {errors.driver_id.message}
            </p>
          )}
          {drivers.length === 0 && (
            <p
              className="text-xs mt-1"
              style={{ color: 'var(--text-tertiary)' }}
            >
              No hay choferes activos. Crea o reactiva uno en /admin/users.
            </p>
          )}
        </div>

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
            <strong>No se pudo guardar.</strong>
            <br />
            {rootError}
          </div>
        )}

        <div className="flex gap-2 mt-2">
          <Link href="/leads" className="btn btn-outline flex-1">
            Cancelar
          </Link>
          <button
            type="submit"
            className="btn btn-primary flex-1"
            disabled={pending || !isDirty}
            aria-busy={pending}
            title={!isDirty ? 'No hay cambios que guardar' : undefined}
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
    </form>
  );
}
