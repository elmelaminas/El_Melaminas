'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, useTransition } from 'react';
import { useForm, useFieldArray, type FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ArrowLeft,
  Plus,
  X,
  Calendar,
  Loader,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Trash2,
} from 'lucide-react';
import {
  LeadCreateSchema,
  CHANNEL_OPTIONS,
  SALE_TYPE_OPTIONS,
  SALE_PLACE_OPTIONS,
  PURCHASE_TYPE_OPTIONS,
  PRODUCT_TYPE_OPTIONS,
  COST_PER_SHEET_OPTIONS,
  EDGE_BANDING_OPTIONS,
  EDGE_BANDING_RATE,
  CUT_RATE,
  NEW_COLOR_SENTINEL,
  LEAD_DOCUMENT_MAX_BYTES,
  LEAD_DOCUMENT_MAX_FILES,
  LEAD_DOCUMENT_EXTS,
  isPdfUrl,
  type LeadCreateInput,
} from './schema';
import {
  saveLeadAction,
  uploadLeadDocumentsAction,
  deleteLeadDocumentAction,
} from './actions';
import { updateLeadFullAction } from '../[id]/edit/actions';
import { formatMXN } from '@/data/mock';

export type SellerOption = { id: string; name: string };
export type ColorOption = { id: string; name: string };
export type DriverOption = { id: string; name: string };

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
  drivers,
  mode = 'create',
  leadId,
  initialValues,
  initialDocumentUrl,
  initialDocumentUrls,
}: {
  sellers: SellerOption[];
  colors: ColorOption[];
  drivers: DriverOption[];
  /** 'create' → saveLeadAction + redirect a /leads. 'edit' →
   *  updateLeadFullAction(leadId, values) + redirect a /leads. */
  mode?: 'create' | 'edit';
  /** Requerido cuando mode='edit'. Lo ignoramos en 'create'. */
  leadId?: string;
  /** Valores precargados (modo edit). En create defaults vacíos. */
  initialValues?: Partial<LeadCreateInput>;
  /** URL del documento legacy (campo `leads.document_url`). Usada
   *  como fallback cuando `initialDocumentUrls` está vacío y el lead
   *  es viejo. En leads nuevos document_urls cubre todo. */
  initialDocumentUrl?: string | null;
  /** Array de URLs actuales del lead (modo edit). En create empty. */
  initialDocumentUrls?: string[] | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const isEdit = mode === 'edit';

  // Documentos adjuntos (hasta LEAD_DOCUMENT_MAX_FILES, mezcla libre
  // de PDFs e imágenes). Los Files NO entran al schema RHF: se
  // manejan como state local y se suben DESPUÉS del save exitoso.
  // Razón: cambiar el schema RHF a aceptar File rompe el flujo y
  // obliga a serializar todo el form a FormData. Más simple: dos
  // pasos secuenciales (lead → upload). Si el upload falla, el lead
  // ya está creado y la UI muestra warning.
  //
  // En modo edit, `existingUrls` arranca con las URLs ya guardadas
  // del lead. El usuario puede eliminarlas individualmente
  // (deleteLeadDocumentAction) o agregar nuevas hasta completar el
  // tope.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const initialExisting = useMemo(() => {
    if (initialDocumentUrls && initialDocumentUrls.length > 0) {
      return initialDocumentUrls.slice(0, LEAD_DOCUMENT_MAX_FILES);
    }
    return initialDocumentUrl ? [initialDocumentUrl] : [];
  }, [initialDocumentUrls, initialDocumentUrl]);
  const [existingUrls, setExistingUrls] = useState<string[]>(initialExisting);
  const [docWarning, setDocWarning] = useState<string | null>(null);
  const [deletingUrl, setDeletingUrl] = useState<string | null>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  const totalAttachments = existingUrls.length + pendingFiles.length;
  const remainingSlots = Math.max(
    0,
    LEAD_DOCUMENT_MAX_FILES - totalAttachments,
  );

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
    // En edit, los initialValues sobreescriben los defaults de
    // creación. Cada campo cae al default si initialValues no tiene
    // ese key (Partial). Cubrecanto default es '' (string vacío) en
    // schema para que el dropdown muestre "Sin cubrecanto".
    defaultValues: {
      channel: initialValues?.channel ?? 'whatsapp',
      seller_id: initialValues?.seller_id ?? sellers[0]?.id ?? '',
      driver_id: initialValues?.driver_id ?? '',
      sale_type: initialValues?.sale_type ?? 'primer_contacto',
      sale_date: initialValues?.sale_date ?? today,
      client_name: initialValues?.client_name ?? '',
      phone: initialValues?.phone ?? '',
      address: initialValues?.address ?? '',
      maps_url: initialValues?.maps_url ?? '',
      cuts_count: initialValues?.cuts_count ?? null,
      cuts_total: initialValues?.cuts_total ?? null,
      edge_banding_type: initialValues?.edge_banding_type ?? '',
      edge_banding_meters: initialValues?.edge_banding_meters ?? null,
      edge_banding_total: initialValues?.edge_banding_total ?? null,
      product_type: initialValues?.product_type ?? 'con_corte',
      purchase_type: initialValues?.purchase_type ?? 'domicilio',
      sale_place: initialValues?.sale_place ?? 'online',
      delivery_cost: initialValues?.delivery_cost ?? null,
      // `cost_per_sheet` ahora vive POR FILA dentro de cada color.
      // Default: primer valor del catálogo ($350).
      colors:
        initialValues?.colors && initialValues.colors.length > 0
          ? initialValues.colors
          : [
              {
                color_id: colors[0]?.id ?? '',
                quantity: 1,
                new_name: '',
                cost_per_sheet:
                  COST_PER_SHEET_OPTIONS[0]?.value ?? 350,
              },
            ],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'colors',
  });

  // Valores observados para reactividad de campos condicionales y resumen.
  const watchedColors = watch('colors');
  const watchedProductType = watch('product_type');
  const watchedCutsCount = watch('cuts_count');
  const watchedEdgeType = watch('edge_banding_type');
  const watchedEdgeMeters = watch('edge_banding_meters');
  // purchase_type='fabrica' → cliente recoge en taller; ocultamos
  // dirección, URL Google Maps y costo de envío en la sección Cliente
  // (no aplican).
  const watchedPurchaseType = watch('purchase_type');
  const isDomicilio = watchedPurchaseType !== 'fabrica';
  const watchedDeliveryCost = watch('delivery_cost');
  // Costo de envío visible solo en domicilio. En fábrica contribuye 0
  // al total aunque el RHF tenga un valor stale.
  const deliveryCost = isDomicilio
    ? typeof watchedDeliveryCost === 'number' && watchedDeliveryCost > 0
      ? watchedDeliveryCost
      : 0
    : 0;

  const totalSheets = useMemo(
    () =>
      (watchedColors ?? []).reduce(
        (s, c) => s + (Number.isFinite(c?.quantity) ? Number(c.quantity) : 0),
        0,
      ),
    [watchedColors],
  );

  // Subtotal de hojas: SUM(quantity * cost_per_sheet) por cada fila.
  // El costo por hoja vive POR FILA (cada color puede tener tarifa
  // distinta). Si una fila no tiene costo todavía (ej. RHF en flush),
  // contribuye 0 — el form Zod lo rechazará al submit.
  const sheetsSubtotal = useMemo(
    () =>
      (watchedColors ?? []).reduce((s, c) => {
        const qty = Number.isFinite(c?.quantity) ? Number(c.quantity) : 0;
        const cost = Number.isFinite(c?.cost_per_sheet)
          ? Number(c.cost_per_sheet)
          : 0;
        return s + qty * cost;
      }, 0),
    [watchedColors],
  );

  // Cálculos auxiliares para mostrar en pantalla (el server recalcula).
  const cutsTotal =
    watchedProductType === 'con_corte' &&
    typeof watchedCutsCount === 'number' &&
    watchedCutsCount > 0
      ? watchedCutsCount * CUT_RATE
      : 0;
  const edgeTotal =
    watchedEdgeType === '19mm' || watchedEdgeType === '3.5mm'
      ? (typeof watchedEdgeMeters === 'number' ? watchedEdgeMeters : 0) *
        EDGE_BANDING_RATE[watchedEdgeType]
      : 0;

  // El total a cobrar suma hojas (por costo de cada fila) + cortes +
  // cubrecanto + envío.
  const total = sheetsSubtotal + cutsTotal + edgeTotal + deliveryCost;

  const onValidSubmit = (values: LeadCreateInput) => {
    clearErrors('root.serverError');
    setDocWarning(null);
    console.log(
      `[NewLeadForm] enviando ${isEdit ? 'updateLeadFullAction' : 'saveLeadAction'}…`,
      values,
    );

    startTransition(async () => {
      try {
        // Branch por modo. En edit el server reusa el lead_id existente
        // y reajusta colores+stock con TxnLog. En create crea uno nuevo.
        const result =
          isEdit && leadId
            ? await updateLeadFullAction(leadId, values)
            : await saveLeadAction(values);
        console.log('[NewLeadForm] respuesta:', result);

        if (result.status === 'success') {
          // Si hay archivos nuevos en cola, subirlos al lead recién
          // guardado. Non-fatal — si falla, lead/edit ya están
          // guardados, solo mostramos warning y NO navegamos.
          if (pendingFiles.length > 0) {
            try {
              const fd = new FormData();
              fd.set('lead_id', result.leadId);
              pendingFiles.forEach((f, i) => {
                fd.set(`document_${i}`, f);
              });
              const upRes = await uploadLeadDocumentsAction(
                { status: 'idle' },
                fd,
              );
              if (upRes.status !== 'success') {
                console.error(
                  '[NewLeadForm] upload documentos falló (no fatal):',
                  upRes,
                );
                const actionLabel = isEdit ? 'Lead actualizado' : 'Lead creado';
                setDocWarning(
                  upRes.status === 'error'
                    ? `${actionLabel}, pero los archivos no se pudieron subir: ${upRes.message}`
                    : `${actionLabel}, pero los archivos no se pudieron subir.`,
                );
                return;
              }
            } catch (uploadErr) {
              console.error(
                '[NewLeadForm] upload documentos excepción (no fatal):',
                uploadErr,
              );
              const msg =
                uploadErr instanceof Error
                  ? uploadErr.message
                  : 'Error de red al subir archivos';
              const actionLabel = isEdit ? 'Lead actualizado' : 'Lead creado';
              setDocWarning(
                `${actionLabel}, pero los archivos no se pudieron subir: ${msg}`,
              );
              return;
            }
          }
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

  /** Acepta los archivos seleccionados desde el input (FileList) y los
   *  agrega a la cola tras validación por archivo (tamaño + extensión).
   *  Cap defensivo: si meter todos excedería LEAD_DOCUMENT_MAX_FILES,
   *  truncamos y mostramos warning. */
  function handleDocChange(filesList: FileList | null) {
    setDocWarning(null);
    if (!filesList || filesList.length === 0) return;
    const incoming = Array.from(filesList);
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of incoming) {
      if (f.size > LEAD_DOCUMENT_MAX_BYTES) {
        rejected.push(`"${f.name}" excede 10 MB.`);
        continue;
      }
      const ext = (f.name.split('.').pop() ?? '').toLowerCase();
      if (!(LEAD_DOCUMENT_EXTS as readonly string[]).includes(ext)) {
        rejected.push(`"${f.name}" no es un formato soportado.`);
        continue;
      }
      accepted.push(f);
    }
    if (accepted.length > remainingSlots) {
      rejected.push(
        `Solo caben ${remainingSlots} archivo(s) más (máx. ${LEAD_DOCUMENT_MAX_FILES}). Se ignoraron ${accepted.length - remainingSlots}.`,
      );
      accepted.length = remainingSlots;
    }
    if (accepted.length > 0) {
      setPendingFiles((prev) => [...prev, ...accepted]);
    }
    if (rejected.length > 0) {
      setDocWarning(rejected.join(' '));
    }
    // Limpiamos el input para que el usuario pueda re-seleccionar el
    // mismo archivo si lo quitó antes (sin esto, el browser no
    // re-emite onChange con el mismo nombre).
    if (docInputRef.current) docInputRef.current.value = '';
  }

  /** Quita un archivo PENDIENTE (todavía no subido) de la cola. */
  function removePendingAt(idx: number) {
    setDocWarning(null);
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  /** Elimina un archivo YA SUBIDO del lead (server action). Solo
   *  aplicable en mode='edit' con leadId disponible. Optimista:
   *  removemos el URL del state local; si la action falla, lo
   *  restauramos y mostramos warning. */
  function removeExistingUrl(url: string) {
    if (!isEdit || !leadId) return;
    setDocWarning(null);
    setDeletingUrl(url);
    const previous = existingUrls;
    setExistingUrls((prev) => prev.filter((u) => u !== url));
    startTransition(async () => {
      try {
        const result = await deleteLeadDocumentAction(leadId, url);
        if (result.status !== 'success') {
          setExistingUrls(previous);
          setDocWarning(result.message);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error de red';
        setExistingUrls(previous);
        setDocWarning(msg);
      } finally {
        setDeletingUrl(null);
      }
    });
  }

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
          <h1 className="text-2xl font-bold">
            {isEdit
              ? `Editando lead de ${initialValues?.client_name ?? '(sin nombre)'}`
              : 'Nuevo Lead'}
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {isEdit
              ? 'Modifica los datos. El stock se reajusta automáticamente.'
              : 'Registra un nuevo cliente y los detalles de su pedido.'}
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
                <select id="field-channel" {...register('channel')} className="select" disabled={pending}>
                  {CHANNEL_OPTIONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Vendedor(a)" error={errors.seller_id?.message}>
                <select id="field-seller" {...register('seller_id')} className="select" disabled={pending}>
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

              <Field
                label="Chofer asignado (opcional)"
                error={errors.driver_id?.message}
              >
                <select id="field-driver" {...register('driver_id')} className="select" disabled={pending}>
                  <option value="">— Sin asignar —</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
                {drivers.length === 0 && (
                  <p
                    className="text-xs mt-1"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    No hay choferes activos en el sistema.
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

              {/* purchase_type vive en "Origen del Lead" porque
                  condiciona la sección Cliente: si es 'fabrica' se
                  ocultan dirección y URL Maps. Antes vivía en
                  "Detalle del Pedido", pero la decisión de a domicilio
                  vs en fábrica se toma al inicio (al hablar con el
                  cliente), no al detallar el pedido. */}
              <Field
                label="Tipo de compra"
                error={errors.purchase_type?.message}
              >
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
            </div>
          </Section>

          {/* Cliente */}
          <Section title="Datos del Cliente" subtitle="Contacto y dirección de entrega.">
            <div id="field-client" className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
              {/* Dirección y URL Maps solo aplican cuando la compra es
                  A DOMICILIO. En fábrica el cliente recoge en el
                  taller — los campos quedan ocultos pero su valor
                  RHF se preserva en state por si el usuario vuelve a
                  cambiar a domicilio. */}
              {isDomicilio && (
                <>
                  <div id="field-address" className="md:col-span-2">
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
                  <div className="md:col-span-2">
                    <Field
                      label="Costo de envío"
                      error={errors.delivery_cost?.message}
                    >
                      <input
                        type="number"
                        min={0}
                        step="1"
                        className="input"
                        placeholder="Ej. 150"
                        disabled={pending}
                        {...register('delivery_cost', {
                          // Mapeo "" → null (y NaN → null) para que Zod
                          // nullable lo acepte. valueAsNumber daría NaN
                          // en input vacío y rompería la validación.
                          setValueAs: (v) => {
                            if (v === '' || v == null) return null;
                            const n = Number(v);
                            return Number.isFinite(n) ? n : null;
                          },
                        })}
                      />
                      <div
                        className="text-[11px] mt-1"
                        style={{ color: 'var(--text-tertiary)' }}
                      >
                        Se sumará al total del pedido
                      </div>
                    </Field>
                  </div>
                </>
              )}
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
                  id="field-sheets"
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
            </div>

            {/* Colores list */}
            <div id="field-colors" className="mt-4">
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
                  <div className="col-span-2">Cantidad</div>
                  <div className="col-span-5">Color</div>
                  <div className="col-span-3">Costo</div>
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
                    onClick={() => {
                      // Heredamos el costo de la última fila para
                      // ergonomía: si el usuario lleva 3 colores a $600,
                      // el 4° default a $600 también. Si no hay filas
                      // previas (caso teórico), cae al primer valor del
                      // catálogo.
                      const last =
                        watchedColors && watchedColors.length > 0
                          ? watchedColors[watchedColors.length - 1]
                          : undefined;
                      const defaultCost =
                        last?.cost_per_sheet ??
                        COST_PER_SHEET_OPTIONS[0]?.value ??
                        350;
                      append({
                        color_id: colors[0]?.id ?? '',
                        quantity: 1,
                        new_name: '',
                        cost_per_sheet: defaultCost,
                      });
                    }}
                    className="btn btn-outline"
                    style={{ padding: '6px 12px' }}
                    disabled={pending}
                  >
                    <Plus size={14} /> Agregar color
                  </button>
                </div>
              </div>
            </div>

            {/* Cubrecanto (estructurado): tipo + metros, total derivado */}
            <div id="field-edgebanding" className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field
                label="Cubrecanto"
                error={errors.edge_banding_type?.message}
              >
                <select
                  {...register('edge_banding_type')}
                  className="select"
                  disabled={pending}
                >
                  <option value="">Sin cubrecanto</option>
                  {EDGE_BANDING_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              {(watchedEdgeType === '19mm' || watchedEdgeType === '3.5mm') && (
                <Field
                  label="Metros lineales"
                  error={errors.edge_banding_meters?.message}
                >
                  <input
                    type="number"
                    min={0}
                    step="0.5"
                    className="input"
                    placeholder="Ej. 4"
                    disabled={pending}
                    {...register('edge_banding_meters', {
                      // Mapeo "" → null para que Zod nullable lo acepte;
                      // valueAsNumber daría NaN sino.
                      setValueAs: (v) => {
                        if (v === '' || v == null) return null;
                        const n = Number(v);
                        return Number.isFinite(n) ? n : null;
                      },
                    })}
                  />
                  <div
                    className="text-[11px] mt-1"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Tarifa: {formatMXN(EDGE_BANDING_RATE[watchedEdgeType])}/m ·
                    Total: <strong>{formatMXN(edgeTotal)}</strong>
                  </div>
                </Field>
              )}
            </div>

            {/* Cortes — solo cuando product_type='con_corte' */}
            {watchedProductType === 'con_corte' && (
              <div id="field-cuts" className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field
                  label="Número de cortes"
                  error={errors.cuts_count?.message}
                >
                  <input
                    type="number"
                    min={1}
                    step={1}
                    className="input"
                    placeholder="Ej. 12"
                    disabled={pending}
                    {...register('cuts_count', {
                      setValueAs: (v) => {
                        if (v === '' || v == null) return null;
                        const n = Number(v);
                        return Number.isFinite(n) ? n : null;
                      },
                    })}
                  />
                  <div
                    className="text-[11px] mt-1"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Tarifa: {formatMXN(CUT_RATE)}/corte ·
                    Total: <strong>{formatMXN(cutsTotal)}</strong>
                  </div>
                </Field>
              </div>
            )}

            {/* purchase_type se movió a "Origen del Lead" — acá ya
                no aparece. */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
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

          {/* Documentos adjuntos. Hasta LEAD_DOCUMENT_MAX_FILES archivos,
              mezcla libre de PDFs e imágenes. Cada uno hasta 10 MB.
              En modo edit, los URLs existentes son individualmente
              eliminables (deleteLeadDocumentAction). Los nuevos
              archivos quedan en cola hasta el submit del lead. */}
          <Section
            title="Documentos adjuntos"
            subtitle={`Cotizaciones, contratos o fotos del pedido (opcional, máx. ${LEAD_DOCUMENT_MAX_FILES} archivos · 10 MB c/u).`}
          >
            {/* Dropzone */}
            <div
              id="field-pdf"
              className="rounded-lg border p-4 flex items-center gap-3"
              style={{
                borderColor:
                  remainingSlots === 0
                    ? 'var(--border)'
                    : 'var(--brand-primary)',
                background: 'var(--bg-subtle)',
                cursor:
                  pending || remainingSlots === 0
                    ? 'not-allowed'
                    : 'pointer',
                opacity: remainingSlots === 0 ? 0.6 : 1,
              }}
              onClick={() => {
                if (!pending && remainingSlots > 0) {
                  docInputRef.current?.click();
                }
              }}
              role="button"
              aria-disabled={pending || remainingSlots === 0}
            >
              <Paperclip
                size={22}
                style={{
                  color:
                    remainingSlots > 0
                      ? 'var(--brand-primary)'
                      : 'var(--text-tertiary)',
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="text-sm font-medium">
                  {remainingSlots === 0
                    ? `Máximo ${LEAD_DOCUMENT_MAX_FILES} archivos`
                    : 'Selecciona uno o más archivos…'}
                </div>
                <div
                  className="text-[11px] mt-1"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  PDF, JPG, PNG, WEBP, HEIC · máx. 10 MB c/u ·{' '}
                  <strong>
                    {totalAttachments}/{LEAD_DOCUMENT_MAX_FILES} archivos
                  </strong>
                </div>
              </div>
              <input
                ref={docInputRef}
                type="file"
                multiple
                accept=".pdf,image/jpeg,image/png,image/webp,image/heic"
                onChange={(e) => handleDocChange(e.target.files)}
                style={{ display: 'none' }}
                disabled={pending || remainingSlots === 0}
              />
            </div>

            {/* Lista combinada: archivos existentes (modo edit) +
                archivos en cola (recién seleccionados). */}
            {(existingUrls.length > 0 || pendingFiles.length > 0) && (
              <ul
                className="mt-3 flex flex-col gap-2"
                aria-label="Archivos adjuntos al lead"
              >
                {existingUrls.map((url, i) => (
                  <DocItem
                    key={`existing-${url}`}
                    icon={isPdfUrl(url) ? 'pdf' : 'image'}
                    label={fileLabelFromUrl(url, i + 1)}
                    href={url}
                    badge="Subido"
                    disabled={pending || deletingUrl === url}
                    onRemove={
                      isEdit && leadId ? () => removeExistingUrl(url) : undefined
                    }
                    pendingRemove={deletingUrl === url}
                  />
                ))}
                {pendingFiles.map((f, i) => (
                  <DocItem
                    key={`pending-${i}-${f.name}`}
                    icon={
                      (f.name.split('.').pop() ?? '').toLowerCase() === 'pdf'
                        ? 'pdf'
                        : 'image'
                    }
                    label={f.name}
                    subLabel={`${(f.size / 1024 / 1024).toFixed(2)} MB · listo para subir`}
                    badge="En cola"
                    badgeColor="warning"
                    disabled={pending}
                    onRemove={() => removePendingAt(i)}
                  />
                ))}
              </ul>
            )}

            {docWarning && (
              <div
                role="alert"
                className="text-xs mt-2"
                style={{ color: 'var(--danger, #dc2626)' }}
              >
                {docWarning}
              </div>
            )}
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
                <span style={{ color: 'var(--text-secondary)' }}>Subtotal hojas</span>
                <span className="font-semibold">{formatMXN(sheetsSubtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-secondary)' }}>Colores</span>
                <span className="font-semibold">{fields.length}</span>
              </div>
              {deliveryCost > 0 && (
                <div className="flex justify-between">
                  <span style={{ color: 'var(--text-secondary)' }}>
                    Envío a domicilio
                  </span>
                  <span className="font-semibold">
                    {formatMXN(deliveryCost)}
                  </span>
                </div>
              )}
              <div
                id="field-total"
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
                id="btn-save-lead"
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
                ) : isEdit ? (
                  'Guardar cambios'
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
      <div className="col-span-2">
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

      <div className="col-span-5 flex flex-col gap-2">
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

      {/* Costo por hoja POR FILA — cada color puede tener tarifa
          distinta. Valores permitidos coinciden con COST_PER_SHEET_OPTIONS. */}
      <div className="col-span-3">
        <select
          {...register(`colors.${idx}.cost_per_sheet`, { valueAsNumber: true })}
          className="select"
          disabled={disabled}
        >
          {COST_PER_SHEET_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        {rowErrors?.cost_per_sheet?.message && (
          <p
            className="text-xs mt-1"
            style={{ color: 'var(--danger, #dc2626)' }}
          >
            {rowErrors.cost_per_sheet.message}
          </p>
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

/**
 * Una fila visual en la lista de archivos adjuntos. Renderiza ícono
 * según tipo, nombre, badge de estado, y botón X (si `onRemove`).
 * `href` opcional: si está, el nombre actúa como link al archivo.
 */
function DocItem({
  icon,
  label,
  subLabel,
  href,
  badge,
  badgeColor = 'success',
  onRemove,
  disabled,
  pendingRemove,
}: {
  icon: 'pdf' | 'image';
  label: string;
  subLabel?: string;
  href?: string;
  badge?: string;
  badgeColor?: 'success' | 'warning';
  onRemove?: () => void;
  disabled?: boolean;
  pendingRemove?: boolean;
}) {
  const isPdf = icon === 'pdf';
  return (
    <li
      className="rounded-lg border flex items-center gap-3 p-3"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--surface, #fff)',
      }}
    >
      {isPdf ? (
        <FileText
          size={20}
          style={{ color: '#B91C1C', flexShrink: 0 }}
          aria-hidden="true"
        />
      ) : (
        <ImageIcon
          size={20}
          style={{ color: '#1E40AF', flexShrink: 0 }}
          aria-hidden="true"
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="text-sm font-medium truncate">
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--brand-secondary)' }}
            >
              {label}
            </a>
          ) : (
            label
          )}
        </div>
        {subLabel && (
          <div
            className="text-[11px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {subLabel}
          </div>
        )}
      </div>
      {badge && (
        <span
          className={`badge badge-${badgeColor}`}
          style={{ fontSize: '0.6875rem' }}
        >
          {badge}
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className="btn btn-ghost"
          style={{ padding: '4px', color: '#DC2626' }}
          aria-label={`Eliminar ${label}`}
          title="Eliminar archivo"
        >
          {pendingRemove ? (
            <Loader size={14} className="animate-spin" />
          ) : (
            <Trash2 size={14} />
          )}
        </button>
      )}
    </li>
  );
}

/**
 * Convierte un URL de Supabase storage a un nombre legible. Si la
 * URL termina en algo como `0_1700000000_abcde.pdf`, mostramos
 * "Archivo {index}.pdf" — los timestamps + random suffix no aportan
 * información al usuario.
 */
function fileLabelFromUrl(url: string, index: number): string {
  const last = url.split('/').pop() ?? '';
  const ext = last.split('.').pop() ?? '';
  // Si el filename es uno de nuestros patrones (slot_ts_rand.ext) lo
  // sustituimos por algo más amigable.
  if (/^\d+_\d+_[a-z0-9]+\.[a-z0-9]+$/i.test(last)) {
    return `Archivo ${index}.${ext}`;
  }
  return last || `Archivo ${index}`;
}
