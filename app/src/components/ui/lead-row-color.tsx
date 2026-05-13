'use client';

/**
 * Reglas de color por fila para los listados de leads y entregas.
 *
 * Codificación visual definida por Sergio. Hay DOS fuentes de color
 * por fila, en orden de prioridad descendente:
 *
 *   A. Manual: el admin asignó `leads.row_color` desde el selector
 *      inline (RowColorPicker). Cualquier valor válido distinto de
 *      'sin_color' gana sobre la lógica automática.
 *
 *   B. Automático (si row_color es null o 'sin_color'):
 *      Rosa     — sale_type = 'venta_empleado'
 *      Naranja  — algún payment del lead tiene
 *                 payment_type = 'contra_entrega'
 *      Amarillo — payment_status = 'pagado' AND
 *                 delivery_status != 'entregado' (y != 'cancelado')
 *      Azul     — product_type = 'con_corte'
 *      (prioridad Rosa > Naranja > Amarillo > Azul)
 *
 * Migración manual requerida en Supabase:
 *   ALTER TABLE leads ADD COLUMN IF NOT EXISTS row_color text
 *     CHECK (row_color IN ('rosa','naranja','amarillo','azul',
 *                          'verde','morado','sin_color'));
 *
 * El módulo es 'use client' porque exporta `RowColorPicker` (componente
 * con state local). Los helpers puros (`getLeadRowColor`,
 * `LeadRowLegend`) se importan desde Server Components también: Next 16
 * permite que un Server Component renderice un componente cliente, y
 * llamar funciones JS puras exportadas desde un módulo 'use client'
 * desde el server NO está soportado oficialmente. Para el uso actual
 * (los rows se renderizan en client components) esto funciona porque
 * `getLeadRowColor` se invoca DENTRO del client. Si en el futuro un
 * Server Component lo necesita, mover la función a un archivo neutro.
 */

import { useState, useTransition } from 'react';
import { Loader, Check } from 'lucide-react';
import type { DeliveryStatus, PaymentStatus } from '@/data/mock';

/** Valores válidos de `leads.row_color` (matchea el CHECK constraint
 *  de la migración). 'sin_color' es el sentinel para "limpiar override"
 *  y volver a la lógica automática. */
export const ROW_COLOR_VALUES = [
  'rosa',
  'naranja',
  'amarillo',
  'azul',
  'verde',
  'morado',
  'sin_color',
] as const;

export type RowColorValue = (typeof ROW_COLOR_VALUES)[number];

/** Validador runtime: devuelve el valor tipado si está en la lista,
 *  o null si llega algo distinto (DB row vieja, mano sucia en URL). */
export function parseRowColor(v: unknown): RowColorValue | null {
  if (typeof v !== 'string') return null;
  return (ROW_COLOR_VALUES as readonly string[]).includes(v)
    ? (v as RowColorValue)
    : null;
}

/**
 * Colores con transparencia para fondo de fila. La opacidad de los
 * colores manuales es ligeramente mayor que la de los automáticos
 * (0.45 vs 0.35) para que la asignación deliberada del admin se
 * distinga visualmente del cálculo automático cuando ambas reglas
 * dan el mismo tono base (ej. rosa manual vs rosa automático).
 *
 * 'sin_color' → undefined: la fila vuelve al fondo normal.
 */
export const LEAD_ROW_COLORS: Readonly<
  Record<Exclude<RowColorValue, 'sin_color'>, string>
> = {
  rosa: 'rgba(255, 182, 193, 0.45)',
  naranja: 'rgba(255, 165, 0, 0.30)',
  amarillo: 'rgba(255, 255, 0, 0.30)',
  azul: 'rgba(173, 216, 230, 0.45)',
  verde: 'rgba(144, 238, 144, 0.45)',
  morado: 'rgba(216, 191, 216, 0.45)',
};

/** Color de fondo asociado a un RowColorValue, o undefined si
 *  'sin_color' / inválido. */
export function colorOf(v: RowColorValue | null | undefined): string | undefined {
  if (!v || v === 'sin_color') return undefined;
  return LEAD_ROW_COLORS[v];
}

export type LeadRowColorInputs = {
  id: string;
  /** Override manual del admin (Grupo manual). Valor válido != null
   *  gana sobre las reglas automáticas. */
  row_color: string | null;
  /** `'venta_empleado'` → rosa (regla automática). */
  sale_type: string | null;
  /** `'con_corte'` → azul (regla automática). */
  product_type: string | null;
  payment_status: PaymentStatus;
  delivery_status: DeliveryStatus;
};

/**
 * Devuelve el color de fondo de la fila o undefined si no aplica nada.
 * Prioridad: manual > automática.
 */
export function getLeadRowColor(
  row: LeadRowColorInputs,
  contraEntregaIds: ReadonlySet<string>,
): string | undefined {
  // A. Override manual gana sobre todo. parseRowColor filtra valores
  //    rotos de DB (NULL, '', valores no incluidos en el CHECK).
  const manual = parseRowColor(row.row_color);
  if (manual && manual !== 'sin_color') {
    return LEAD_ROW_COLORS[manual];
  }

  // B. Reglas automáticas en orden de prioridad.
  if (row.sale_type === 'venta_empleado') return LEAD_ROW_COLORS.rosa;
  if (contraEntregaIds.has(row.id)) return LEAD_ROW_COLORS.naranja;
  if (
    row.payment_status === 'pagado' &&
    row.delivery_status !== 'entregado' &&
    row.delivery_status !== 'cancelado'
  ) {
    return LEAD_ROW_COLORS.amarillo;
  }
  if (row.product_type === 'con_corte') return LEAD_ROW_COLORS.azul;

  return undefined;
}

/** Labels en español para cada color (UI). */
const COLOR_LABEL: Readonly<Record<RowColorValue, string>> = {
  sin_color: 'Sin color',
  rosa: 'Rosa',
  morado: 'Morado',
  azul: 'Azul',
  amarillo: 'Amarillo',
  naranja: 'Naranja',
  verde: 'Verde',
};

/**
 * Leyenda horizontal con los 4 códigos automáticos + 2 colores manuales.
 * Tamaño pequeño y neutro — no debe competir con filtros ni tabla.
 */
export function LeadRowLegend() {
  const items: { color: string; label: string }[] = [
    { color: LEAD_ROW_COLORS.rosa, label: 'Venta empleado' },
    { color: LEAD_ROW_COLORS.naranja, label: 'Contra entrega' },
    { color: LEAD_ROW_COLORS.amarillo, label: 'Pagado sin entregar' },
    { color: LEAD_ROW_COLORS.azul, label: 'Con corte' },
    { color: LEAD_ROW_COLORS.verde, label: 'Verde (manual)' },
    { color: LEAD_ROW_COLORS.morado, label: 'Morado (manual)' },
  ];
  return (
    <div
      className="flex items-center gap-3 flex-wrap text-xs"
      style={{ color: 'var(--text-tertiary)' }}
      aria-label="Leyenda de colores de fila"
    >
      <span style={{ fontWeight: 500 }}>Códigos:</span>
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 9999,
              background: it.color,
              border: '1px solid var(--border)',
            }}
          />
          <span>{it.label}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Selector inline de color manual para una fila.
 *
 * Render: botón circular del color actual (o anillo punteado si
 * 'sin_color'/null). Al hacer click despliega un popover con un círculo
 * por cada `RowColorValue`. Al elegir uno se llama `onPick(value)` y
 * el popover se cierra.
 *
 * El estado pending/error se maneja externamente — el caller envuelve
 * `onPick` con su `useTransition` + llamada a la action. Esto permite
 * que el picker no conozca el dominio (acciones, Supabase) y sea
 * reusable en /leads y /admin/entregas con la misma forma.
 *
 * El popover NO usa Portal: vive dentro del `<td>` con `position:
 * absolute`. Si la tabla tiene `overflow-x: auto`, puede recortarse;
 * en ese caso un dropdown más simple basta — Sergio puede pedirlo.
 */
export function RowColorPicker({
  value,
  onPick,
  pending,
  disabled,
}: {
  value: string | null;
  onPick: (next: RowColorValue) => void;
  pending?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = parseRowColor(value) ?? 'sin_color';
  const swatchBg = colorOf(current);

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => !disabled && !pending && setOpen((v) => !v)}
        disabled={disabled || pending}
        aria-label={`Cambiar color de fila (actual: ${COLOR_LABEL[current]})`}
        title={`Color actual: ${COLOR_LABEL[current]}`}
        className="btn btn-ghost"
        style={{
          padding: '4px',
          width: 28,
          height: 28,
          borderRadius: 9999,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {pending ? (
          <Loader size={14} className="animate-spin" />
        ) : (
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 16,
              height: 16,
              borderRadius: 9999,
              background: swatchBg ?? 'transparent',
              // 'sin_color' → borde punteado; con color → borde sólido
              // suave para que el círculo se vea aún sobre fondos
              // coloreados.
              border:
                current === 'sin_color'
                  ? '1.5px dashed var(--border-strong)'
                  : '1px solid var(--border)',
            }}
          />
        )}
      </button>

      {open && (
        <>
          {/* Capa invisible para cerrar al click-fuera. z-index < popover. */}
          <div
            onClick={() => setOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 40,
            }}
            aria-hidden="true"
          />
          <div
            role="listbox"
            aria-label="Colores disponibles"
            className="card"
            style={{
              position: 'absolute',
              top: '110%',
              right: 0,
              zIndex: 41,
              padding: 6,
              display: 'grid',
              gridTemplateColumns: 'repeat(7, 28px)',
              gap: 4,
              minWidth: 'max-content',
            }}
          >
            {ROW_COLOR_VALUES.map((v) => {
              const bg = colorOf(v);
              const isCurrent = v === current;
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    if (v !== current) onPick(v);
                  }}
                  className="btn btn-ghost"
                  style={{
                    padding: 0,
                    width: 28,
                    height: 28,
                    borderRadius: 9999,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    position: 'relative',
                  }}
                  aria-label={COLOR_LABEL[v]}
                  aria-selected={isCurrent}
                  title={COLOR_LABEL[v]}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'inline-block',
                      width: 18,
                      height: 18,
                      borderRadius: 9999,
                      background: bg ?? 'transparent',
                      border:
                        v === 'sin_color'
                          ? '1.5px dashed var(--border-strong)'
                          : '1px solid var(--border)',
                    }}
                  />
                  {isCurrent && (
                    <Check
                      size={10}
                      style={{
                        position: 'absolute',
                        color: 'var(--text-primary)',
                        pointerEvents: 'none',
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Resultado mínimo que la Server Action debe devolver para que el
 * wrapper `RowColorPickerCell` interprete el éxito/error.
 */
export type RowColorMutationResult =
  | { status: 'idle' }
  | { status: 'success' }
  | { status: 'error'; message: string };

/**
 * Wrapper que ya conoce `useTransition`, manejo de error y optimismo.
 * Recibe la `action` como prop para mantener el módulo desacoplado del
 * dominio — el caller (leads-client / entregas-client) le pasa la
 * Server Action importada estáticamente desde su propio `actions.ts`,
 * lo cual SÍ está soportado (Next genera el RPC binding).
 *
 * Pintado optimista: el círculo cambia de color al instante; si la
 * action falla, revertimos. `revalidatePath` del server + refresh del
 * router traen el valor canónico posteriormente.
 */
export function RowColorPickerCell({
  leadId,
  value,
  action,
}: {
  leadId: string;
  value: string | null;
  /** Server Action que recibe FormData con lead_id + row_color y
   *  devuelve { status }. Importada por el caller desde `actions.ts`. */
  action: (
    formData: FormData,
  ) => Promise<RowColorMutationResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<string | null>(value);

  function handlePick(next: RowColorValue) {
    setError(null);
    const previous = optimistic;
    setOptimistic(next);

    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.set('lead_id', leadId);
        fd.set('row_color', next);
        const r = await action(fd);
        if (r.status === 'error') {
          setError(r.message);
          setOptimistic(previous); // revert al estado anterior
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Error de red';
        setError(message);
        setOptimistic(previous);
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <RowColorPicker
        value={optimistic}
        onPick={handlePick}
        pending={pending}
      />
      {error && (
        <div
          role="alert"
          className="text-[10px]"
          style={{ color: 'var(--danger, #dc2626)', maxWidth: 160 }}
          title={error}
        >
          {error.length > 30 ? `${error.slice(0, 30)}…` : error}
        </div>
      )}
    </div>
  );
}
