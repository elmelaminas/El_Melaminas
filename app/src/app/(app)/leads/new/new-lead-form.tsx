'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useTransition } from 'react';
import { useForm, useFieldArray, type FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ArrowLeft,
  Plus,
  X,
  Calendar,
  Loader,
} from 'lucide-react';
import {
  LeadCreateSchema,
  CHANNEL_OPTIONS,
  SALE_TYPE_OPTIONS,
  SALE_PLACE_OPTIONS,
  PURCHASE_TYPE_OPTIONS,
  PRODUCT_TYPE_OPTIONS,
  NEW_COLOR_SENTINEL,
  type LeadCreateInput,
} from './schema';
import { saveLeadAction } from './actions';
import { formatMXN } from '@/data/mock';

export type SellerOption = { id: string; name: string };
export type ColorOption = { id: string; name: string };

const COST_PER_SHEET_OPTIONS = [750, 650, 600] as const;

/**
 * Formulario de nuevo lead.
 *
 * - RHF + zodResolver: validación cliente con el mismo schema que ejecuta
 *   `saveLeadAction` server-side (defensa en profundidad).
 * - useFieldArray para la lista dinámica de colores.
 * - El dropdown de color tiene una opción `+ Nuevo color…` que cuando se
 *   selecciona revela un input adicional para el nombre. La server action
 *   se encarga de crear (`INSERT colors + inventory`) los colores nuevos
 *   detectados, deduplicando por `normalized_name`.
 * - Política de errores idéntica al resto del proyecto: errores del server
 *   se pintan en banner + por campo (incluyendo paths anidados como
 *   "colors.0.quantity"). `console.log` en cada submit para diagnóstico.
 */
export function NewLeadForm({
  sellers,
  colors,
}: {
  sellers: SellerOption[];
  colors: ColorOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const today = new Date().toISOString().slice(0, 10);

  const {
    register,
    control,
    handleSubmit,
    setError,
    clearErrors,
    watch,
    formState: { errors },
  } = useForm<LeadCreateInput>({
    resolver: zodResolver(LeadCreateSchema),
    defaultValues: {
      channel: 'whatsapp',
      seller_id: sellers[0]?.id ?? '',
      sale_type: 'primer_contacto',
      sale_date: today,
      client_name: '',
      phone: '',
      address: '',
      maps_url: '',
      cost_per_sheet: 750,
      edge_banding: '',
      product_type: 'con_corte',
      purchase_type: 'domicilio',
      sale_place: 'online',
      colors: [
        { color_id: colors[0]?.id ?? '', quantity: 1, new_name: '' },
      ],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'colors',
  });

  // Valores observados para el resumen sticky (re-render solo aquí).
  const watchedColors = watch('colors');
  const watchedCostPerSheet = watch('cost_per_sheet');

  const totalSheets = useMemo(
    () =>
      (watchedColors ?? []).reduce(
        (s, c) => s + (Number.isFinite(c?.quantity) ? Number(c.quantity) : 0),
        0,
      ),
    [watchedColors],
  );
  const total = totalSheets * (Number(watchedCostPerSheet) || 0);

  const onValidSubmit = (values: LeadCreateInput) => {
    clearErrors('root.serverError');
    console.log('[NewLeadForm] enviando saveLeadAction…', values);

    startTransition(async () => {
      try {
        const result = await saveLeadAction(values);
        console.log('[NewLeadForm] respuesta:', result);

        if (result.status === 'success') {
          // Vamos al listado; cuando exista /leads/[id] redirigimos ahí.
          router.push('/leads');
          router.refresh();
          return;
        }
        if (result.status === 'error') {
          if (result.fieldErrors) {
            for (const [path, msgs] of Object.entries(result.fieldErrors)) {
              if (msgs && msgs[0]) {
                // RHF acepta paths anidados como "colors.0.quantity".
                setError(path as keyof LeadCreateInput, {
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
        console.error('[NewLeadForm] excepción al invocar la acción:', err);
        setError('root.serverError', { type: 'server', message });
      }
    });
  };

  const onInvalidSubmit = (formErrors: FieldErrors<LeadCreateInput>) => {
    console.warn('[NewLeadForm] validación cliente falló:', formErrors);
  };

  const rootError = errors.root?.serverError?.message;

  return (
    <form
      onSubmit={handleSubmit(onValidSubmit, onInvalidSubmit)}
      noValidate
      className="flex flex-col gap-6 max-w-5xl"
    >
      {/* Header */}
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
          <h1 className="text-2xl font-bold">Nuevo Lead</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Registra un nuevo cliente y los detalles de su pedido.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Form */}
        <div className="xl:col-span-2 flex flex-col gap-6">
          {/* Origen */}
          <Section title="Origen del Lead" subtitle="¿Cómo llegó este cliente?">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Canal" error={errors.channel?.message}>
                <select {...register('channel')} className="select" disabled={pending}>
                  {CHANNEL_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Vendedor(a)" error={errors.seller_id?.message}>
                <select {...register('seller_id')} className="select" disabled={pending}>
                  <option value="">— sin vendedor —</option>
                  {sellers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {sellers.length === 0 && (
                  <p
                    className="text-xs mt-1"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    No hay vendedores activos. Crea uno en /admin/catalogs.
                  </p>
                )}
              </Field>

              <Field label="Tipo de venta" error={errors.sale_type?.message}>
                <select {...register('sale_type')} className="select" disabled={pending}>
                  {SALE_TYPE_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Fecha" error={errors.sale_date?.message}>
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
              </Field>
            </div>
          </Section>

          {/* Cliente */}
          <Section title="Datos del Cliente" subtitle="Contacto y dirección de entrega.">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Nombre completo" error={errors.client_name?.message}>
                <input
                  {...register('client_name')}
                  className="input"
                  placeholder="Ej. Juan Pérez García"
                  autoComplete="name"
                  disabled={pending}
                />
              </Field>
              <Field label="Teléfono" error={errors.phone?.message}>
                <input
                  {...register('phone')}
                  className="input"
                  placeholder="55 1234 5678"
                  autoComplete="tel"
                  type="tel"
                  disabled={pending}
                />
              </Field>
              <div className="md:col-span-2">
                <Field label="Dirección" error={errors.address?.message}>
                  <textarea
                    {...register('address')}
                    className="textarea"
                    rows={2}
                    placeholder="Calle, número, colonia, alcaldía…"
                    disabled={pending}
                  />
                </Field>
              </div>
              <div className="md:col-span-2">
                <Field
                  label="URL Google Maps (opcional)"
                  error={errors.maps_url?.message}
                >
                  <input
                    {...register('maps_url')}
                    className="input"
                    placeholder="https://maps.google.com/…"
                    disabled={pending}
                  />
                </Field>
              </div>
            </div>
          </Section>

          {/* Pedido */}
          <Section
            title="Detalle del Pedido"
            subtitle="Materiales, costo y modalidad de venta."
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Número de hojas (auto)">
                <input
                  className="input"
                  type="number"
                  value={totalSheets}
                  readOnly
                  style={{ background: 'var(--bg-muted)' }}
                />
                <div
                  className="text-[11px] mt-1"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Suma automática de las hojas por color
                </div>
              </Field>
              <Field label="Costo por hoja" error={errors.cost_per_sheet?.message}>
                <select
                  {...register('cost_per_sheet', { valueAsNumber: true })}
                  className="select"
                  disabled={pending}
                >
                  {COST_PER_SHEET_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {formatMXN(c)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {/* Colores list */}
            <div className="mt-4">
              <label className="label">Colores</label>
              {errors.colors?.message && (
                <p
                  className="text-xs mb-2"
                  style={{ color: 'var(--danger, #dc2626)' }}
                >
                  {errors.colors.message}
                </p>
              )}
              <div
                className="rounded-lg border"
                style={{ borderColor: 'var(--border)' }}
              >
                <div
                  className="grid grid-cols-12 px-4 py-2 text-xs font-semibold uppercase tracking-wide"
                  style={{
                    background: 'var(--bg-subtle)',
                    color: 'var(--text-secondary)',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <div className="col-span-3">Cantidad</div>
                  <div className="col-span-7">Color</div>
                  <div className="col-span-2 text-right">Acción</div>
                </div>

                {fields.map((field, idx) => (
                  <ColorRowFields
                    key={field.id}
                    idx={idx}
                    register={register}
                    watch={watch}
                    errors={errors}
                    colors={colors}
                    disabled={pending}
                    onRemove={() => remove(idx)}
                    canRemove={fields.length > 1}
                  />
                ))}

                <div
                  className="px-4 py-3 border-t"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <button
                    type="button"
                    onClick={() =>
                      append({
                        color_id: colors[0]?.id ?? '',
                        quantity: 1,
                        new_name: '',
                      })
                    }
                    className="btn btn-outline"
                    style={{ padding: '6px 12px' }}
                    disabled={pending}
                  >
                    <Plus size={14} /> Agregar color
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
              <Field
                label="Cubrecanto (opcional)"
                error={errors.edge_banding?.message}
              >
                <input
                  {...register('edge_banding')}
                  className="input"
                  placeholder="Ej. 4 m linosa 19 mm"
                  disabled={pending}
                />
              </Field>
              <Field label="Tipo de producto" error={errors.product_type?.message}>
                <select
                  {...register('product_type')}
                  className="select"
                  disabled={pending}
                >
                  {PRODUCT_TYPE_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Tipo de compra" error={errors.purchase_type?.message}>
                <select
                  {...register('purchase_type')}
                  className="select"
                  disabled={pending}
                >
                  {PURCHASE_TYPE_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Lugar de venta" error={errors.sale_place?.message}>
                <select
                  {...register('sale_place')}
                  className="select"
                  disabled={pending}
                >
                  {SALE_PLACE_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </Section>
        </div>

        {/* Resumen sticky */}
        <div className="xl:sticky xl:top-24 self-start">
          <div className="card p-6">
            <h3 className="font-semibold mb-4">Resumen del pedido</h3>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>Hojas totales</span>
                <span className="font-semibold">{totalSheets}</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>Costo por hoja</span>
                <span className="font-semibold">
                  {formatMXN(Number(watchedCostPerSheet) || 0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>Colores</span>
                <span className="font-semibold">{fields.length}</span>
              </div>
              <div
                className="border-t pt-3 mt-2"
                style={{ borderColor: 'var(--border)' }}
              >
                <div
                  className="text-xs uppercase tracking-wide"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Total a cobrar
                </div>
                <div
                  className="text-3xl font-bold mt-1"
                  style={{ color: 'var(--brand-primary)' }}
                >
                  {formatMXN(total)}
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
                <span>Guardando lead en Supabase…</span>
              </div>
            )}

            {rootError && !pending && (
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
                <strong>No se pudo guardar el lead.</strong>
                <br />
                {rootError}
              </div>
            )}

            <div className="flex gap-2 mt-6">
              <Link href="/leads" className="btn btn-outline flex-1">
                Cancelar
              </Link>
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
                  'Guardar Lead'
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}

// ─── Subcomponentes ──────────────────────────────────────────────────────

/**
 * Una fila del editor de colores. Con dropdown para color existente +
 * opción `+ Nuevo color…` que revela un input adicional para nombre.
 */
function ColorRowFields({
  idx,
  register,
  watch,
  errors,
  colors,
  disabled,
  onRemove,
  canRemove,
}: {
  idx: number;
  register: ReturnType<typeof useForm<LeadCreateInput>>['register'];
  watch: ReturnType<typeof useForm<LeadCreateInput>>['watch'];
  errors: FieldErrors<LeadCreateInput>;
  colors: ColorOption[];
  disabled: boolean;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const colorIdValue = watch(`colors.${idx}.color_id`);
  const isNew = colorIdValue === NEW_COLOR_SENTINEL;

  // El cast a Record es porque errors.colors es FieldErrors[] (array de
  // errores), pero RHF tipa los índices como números. Con el cast accedemos
  // limpiamente al error de cada campo de la fila.
  const rowErrors = (errors.colors as Record<number, Record<string, { message?: string }>> | undefined)?.[idx];

  return (
    <div
      className="grid grid-cols-12 items-start gap-3 px-4 py-2 border-t"
      style={{ borderColor: 'var(--border)' }}
    >
      <div className="col-span-3">
        <input
          {...register(`colors.${idx}.quantity`, { valueAsNumber: true })}
          type="number"
          min={1}
          className="input"
          disabled={disabled}
        />
        {rowErrors?.quantity?.message && (
          <p
            className="text-xs mt-1"
            style={{ color: 'var(--danger, #dc2626)' }}
          >
            {rowErrors.quantity.message}
          </p>
        )}
      </div>

      <div className="col-span-7 flex flex-col gap-2">
        <select
          {...register(`colors.${idx}.color_id`)}
          className="select"
          disabled={disabled}
        >
          <option value="">— selecciona —</option>
          {colors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option value={NEW_COLOR_SENTINEL}>+ Nuevo color…</option>
        </select>
        {rowErrors?.color_id?.message && (
          <p
            className="text-xs"
            style={{ color: 'var(--danger, #dc2626)' }}
          >
            {rowErrors.color_id.message}
          </p>
        )}

        {isNew && (
          <>
            <input
              {...register(`colors.${idx}.new_name`)}
              className="input"
              placeholder="Nombre del color nuevo (ej. Carbón)"
              disabled={disabled}
            />
            {rowErrors?.new_name?.message && (
              <p
                className="text-xs"
                style={{ color: 'var(--danger, #dc2626)' }}
              >
                {rowErrors.new_name.message}
              </p>
            )}
          </>
        )}
      </div>

      <div className="col-span-2 flex justify-end">
        <button
          type="button"
          onClick={onRemove}
          className="btn btn-danger-outline"
          style={{ padding: '6px 10px' }}
          aria-label="Eliminar color"
          disabled={disabled || !canRemove}
          title={!canRemove ? 'Debe haber al menos un color' : undefined}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card p-6">
      <div className="mb-5">
        <h3 className="font-semibold">{title}</h3>
        {subtitle && (
          <p
            className="text-xs"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {subtitle}
          </p>
        )}
      </div>
      {children}
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
