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
  Camera,
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
  type LeadCreateInput,
  type LeadDocumentKind,
} from './schema';
import { saveLeadAction, uploadLeadDocumentAction } from './actions';
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
  /** URL del PDF actual del lead (modo edit). Si el usuario sube
   *  uno nuevo, reemplaza al actual. Si no, se mantiene el existente. */
  initialDocumentUrl?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const isEdit = mode === 'edit';

  // Documento adjunto (opcional, PDF O Foto — excluyentes). El File NO
  // entra al schema RHF: se maneja como state local y se sube DESPUÉS
  // del save exitoso del lead. Razón: cambiar el schema RHF a aceptar
  // File rompe el flujo existente y obliga a serializar el form a
  // FormData en vez de JSON. Más simple: dos pasos secuenciales (lead
  // → upload). Si el upload falla, el lead ya está creado y la UI
  // muestra warning (mejor un lead sin doc que un lead perdido).
  //
  // `docKind` controla qué tab está activo (PDF o Foto). null = ninguno
  // seleccionado todavía (estado inicial). Al cambiar de tab se limpia
  // el archivo seleccionado para evitar enviar un PDF como "foto" o
  // viceversa.
  const [docKind, setDocKind] = useState<LeadDocumentKind | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfWarning, setPdfWarning] = useState<string | null>(null);
  const pdfRef = useRef<HTMLInputElement>(null);
  // Preview URL para la foto seleccionada. Lo regeneramos cada vez que
  // cambia el archivo y lo liberamos con URL.revokeObjectURL en cleanup
  // para no fugar memoria.
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);

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
  // dirección y URL Google Maps en la sección Cliente (no aplican).
  const watchedPurchaseType = watch('purchase_type');
  const isDomicilio = watchedPurchaseType !== 'fabrica';

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
  // cubrecanto.
  const total = sheetsSubtotal + cutsTotal + edgeTotal;

  const onValidSubmit = (values: LeadCreateInput) => {
    clearErrors('root.serverError');
    setPdfWarning(null);
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
          // Documento: en ambos modos, si el usuario adjuntó archivo
          // (PDF o Foto), lo subimos para reemplazar/setear el
          // document_url. La subida es non-fatal — si falla, lead/edit
          // ya están guardados, solo mostramos warning y NO navegamos.
          if (docKind && pdfFile && pdfFile.size > 0) {
            const docLabel = docKind === 'pdf' ? 'PDF' : 'foto';
            try {
              const fd = new FormData();
              fd.set('lead_id', result.leadId);
              fd.set('kind', docKind);
              fd.set('document', pdfFile);
              const upRes = await uploadLeadDocumentAction(
                { status: 'idle' },
                fd,
              );
              if (upRes.status !== 'success') {
                console.error(
                  `[NewLeadForm] upload ${docLabel} falló (no fatal):`,
                  upRes,
                );
                const actionLabel = isEdit ? 'Lead actualizado' : 'Lead creado';
                setPdfWarning(
                  upRes.status === 'error'
                    ? `${actionLabel}, pero el/la ${docLabel} no se pudo subir: ${upRes.message}`
                    : `${actionLabel}, pero el/la ${docLabel} no se pudo subir.`,
                );
                return;
              }
            } catch (uploadErr) {
              console.error(
                `[NewLeadForm] upload ${docLabel} excepción (no fatal):`,
                uploadErr,
              );
              const msg =
                uploadErr instanceof Error
                  ? uploadErr.message
                  : `Error de red al subir ${docLabel}`;
              const actionLabel = isEdit ? 'Lead actualizado' : 'Lead creado';
              setPdfWarning(`${actionLabel}, pero el/la ${docLabel} no se pudo subir: ${msg}`);
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

  /** Validación cliente del archivo (PDF o Foto) antes de aceptarlo en
   *  state. La validación depende del `docKind` actual: el caller
   *  garantiza que docKind no sea null al llamar a esta función. Si
   *  falla, mostramos error inline y limpiamos el input. */
  function handleDocChange(file: File | null) {
    setPdfWarning(null);
    // Limpieza del preview anterior (solo aplica a fotos).
    if (photoPreview) {
      URL.revokeObjectURL(photoPreview);
      setPhotoPreview(null);
    }
    if (!file) {
      setPdfFile(null);
      return;
    }
    if (file.size > LEAD_DOCUMENT_MAX_BYTES) {
      setPdfWarning(
        docKind === 'pdf'
          ? 'El PDF excede 10 MB. Comprime o reduce el archivo.'
          : 'La foto excede 10 MB. Reduce el tamaño o calidad.',
      );
      setPdfFile(null);
      if (pdfRef.current) pdfRef.current.value = '';
      return;
    }
    if (docKind === 'pdf') {
      const ext = (file.name.split('.').pop() ?? '').toLowerCase();
      if (ext !== 'pdf') {
        setPdfWarning('Solo se aceptan archivos PDF (.pdf).');
        setPdfFile(null);
        if (pdfRef.current) pdfRef.current.value = '';
        return;
      }
    } else if (docKind === 'photo') {
      const mime = (file.type ?? '').toLowerCase();
      if (!mime.startsWith('image/')) {
        setPdfWarning('Solo se aceptan imágenes (JPG, PNG, HEIC, etc.).');
        setPdfFile(null);
        if (pdfRef.current) pdfRef.current.value = '';
        return;
      }
      // Generamos un object URL para mostrar el preview de la foto.
      // Lo liberaremos cuando el componente se desmonte o el archivo
      // cambie de nuevo.
      setPhotoPreview(URL.createObjectURL(file));
    }
    setPdfFile(file);
  }

  /** Cambia entre tabs PDF/Foto. Al cambiar limpiamos el archivo
   *  seleccionado (un PDF no aplica como foto y viceversa) y el
   *  warning. Clickear el tab activo lo deselecciona. */
  function handleDocKindToggle(next: LeadDocumentKind) {
    if (photoPreview) {
      URL.revokeObjectURL(photoPreview);
      setPhotoPreview(null);
    }
    if (pdfRef.current) pdfRef.current.value = '';
    setPdfFile(null);
    setPdfWarning(null);
    setDocKind((prev) => (prev === next ? null : next));
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
              <Field label="Subtotal hojas (auto)">
                <input
                  id="field-cost"
                  className="input"
                  type="text"
                  value={formatMXN(sheetsSubtotal)}
                  readOnly
                  style={{ background: 'var(--bg-muted)' }}
                />
                <div
                  className="text-[11px] mt-1"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Suma de cantidad × costo de cada color
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

          {/* Documento adjunto (Grupo 3). PDF O Foto opcional asociado
              al lead (excluyentes). Se sube al bucket lead-documents
              después de que el lead se crea/actualiza. Max 10 MB. En
              edit mode si el lead ya tiene documento, se muestra un
              link al actual; subir uno nuevo lo reemplaza. */}
          <Section
            title="Documento adjunto"
            subtitle={
              isEdit && initialDocumentUrl
                ? 'Cotización, contrato o foto (opcional). Subir uno nuevo reemplaza al actual.'
                : 'Cotización o contrato (PDF) o foto del pedido (opcional, máx. 10 MB).'
            }
          >
            {isEdit && initialDocumentUrl && !pdfFile && (
              <div
                className="mb-3 text-xs flex items-center gap-2 flex-wrap"
                style={{ color: 'var(--text-secondary)' }}
              >
                <FileText
                  size={14}
                  style={{ color: 'var(--brand-secondary)' }}
                />
                <span>Documento actual:</span>
                <a
                  href={initialDocumentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                  style={{
                    color: 'var(--brand-secondary)',
                    fontWeight: 500,
                  }}
                >
                  Ver documento adjunto
                </a>
              </div>
            )}
            {/* Toggle PDF ↔ Foto. Estilo tab/pill: el activo se pinta
                con --brand-primary; el inactivo en gris. Clickear el
                activo lo desactiva (estado "ninguno seleccionado"). */}
            <div
              role="tablist"
              aria-label="Tipo de documento"
              className="flex gap-2 mb-3"
            >
              <button
                type="button"
                role="tab"
                aria-selected={docKind === 'pdf'}
                onClick={() => handleDocKindToggle('pdf')}
                disabled={pending}
                className="btn"
                style={{
                  padding: '6px 14px',
                  background:
                    docKind === 'pdf'
                      ? 'var(--brand-primary)'
                      : 'var(--bg-subtle)',
                  color:
                    docKind === 'pdf' ? '#fff' : 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontWeight: 500,
                }}
              >
                <FileText size={14} />
                <span>PDF</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={docKind === 'photo'}
                onClick={() => handleDocKindToggle('photo')}
                disabled={pending}
                className="btn"
                style={{
                  padding: '6px 14px',
                  background:
                    docKind === 'photo'
                      ? 'var(--brand-primary)'
                      : 'var(--bg-subtle)',
                  color:
                    docKind === 'photo' ? '#fff' : 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontWeight: 500,
                }}
              >
                <Camera size={14} />
                <span>Foto</span>
              </button>
            </div>

            {/* Área de upload — solo visible cuando hay un kind
                seleccionado. Hasta entonces solo se ven los tabs. */}
            {docKind && (
              <div
                id="field-pdf"
                className="rounded-lg border p-4 flex items-start gap-3"
                style={{
                  borderColor: pdfFile
                    ? 'var(--success, #16A34A)'
                    : 'var(--border)',
                  background: pdfFile ? '#F0FDF4' : 'var(--bg-subtle)',
                  cursor: pending ? 'not-allowed' : 'pointer',
                }}
                onClick={() => !pending && pdfRef.current?.click()}
              >
                {docKind === 'pdf' ? (
                  <FileText
                    size={22}
                    style={{
                      color: pdfFile
                        ? 'var(--success, #16A34A)'
                        : 'var(--text-tertiary)',
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                  />
                ) : photoPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={photoPreview}
                    alt="Previsualización"
                    style={{
                      width: 64,
                      height: 64,
                      objectFit: 'cover',
                      borderRadius: 6,
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <Camera
                    size={22}
                    style={{
                      color: 'var(--text-tertiary)',
                      flexShrink: 0,
                      marginTop: 2,
                    }}
                  />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="text-sm font-medium">
                    {pdfFile
                      ? pdfFile.name
                      : docKind === 'pdf'
                        ? 'Selecciona un PDF…'
                        : 'Toma o selecciona una foto…'}
                  </div>
                  <div
                    className="text-[11px] mt-1"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    {pdfFile
                      ? `${(pdfFile.size / 1024 / 1024).toFixed(2)} MB · listo para subir`
                      : docKind === 'pdf'
                        ? 'Solo .pdf · máx. 10 MB'
                        : 'JPG, PNG, HEIC · máx. 10 MB'}
                  </div>
                </div>
                {pdfFile && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDocChange(null);
                    }}
                    className="btn btn-ghost"
                    style={{ padding: '4px' }}
                    disabled={pending}
                    aria-label={
                      docKind === 'pdf' ? 'Quitar PDF' : 'Quitar foto'
                    }
                  >
                    <X size={14} />
                  </button>
                )}
                {/* Input según kind. Re-creamos el elemento al cambiar
                    de tab (key={docKind}) para que `capture` y `accept`
                    sean los correctos sin trampas del browser. */}
                <input
                  key={docKind}
                  ref={pdfRef}
                  type="file"
                  accept={docKind === 'pdf' ? 'application/pdf,.pdf' : 'image/*'}
                  capture={docKind === 'photo' ? 'environment' : undefined}
                  onChange={(e) =>
                    handleDocChange(e.target.files?.[0] ?? null)
                  }
                  style={{ display: 'none' }}
                  disabled={pending}
                />
              </div>
            )}
            {pdfWarning && (
              <div
                role="alert"
                className="text-xs mt-2"
                style={{ color: 'var(--danger, #dc2626)' }}
              >
                {pdfWarning}
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
