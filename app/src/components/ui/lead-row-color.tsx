'use client';

/**
 * Componentes cliente para los colores de fila (`/leads`,
 * `/admin/entregas`).
 *
 * IMPORTANTE: las constantes y utilidades puras viven en
 * `@/lib/lead-row-color` (módulo NEUTRO). Acá solo:
 *   - componentes que usan hooks (LeadRowLegend, RowColorPicker,
 *     RowColorPickerCell)
 *   - re-exports para mantener la API previa (un solo punto de
 *     entrada para clients que ya importan desde acá).
 *
 * Por qué el split: cuando `ROW_COLOR_VALUES` vivía en este archivo
 * `'use client'`, `leads/schema.ts` (server-only) lo importaba para
 * construir `z.enum(...)` y Next 16 lo bundleaba como referencia
 * cliente en el contexto server, rompiendo Zod con "function is not
 * iterable". Mover las constantes al módulo neutro `@/lib/...`
 * elimina ese boundary y deja la API estable para los callers.
 */

import { useState, useTransition } from 'react';
import { Loader, Check } from 'lucide-react';
import {
  COLOR_LABEL,
  LEAD_ROW_COLORS,
  ROW_COLOR_VALUES,
  colorOf,
  parseRowColor,
  type RowColorValue,
} from '@/lib/lead-row-color';

// ─── Re-exports para mantener la API previa ─────────────────────────
// Las constantes y utilidades viven en el módulo neutro; las exponemos
// también desde acá para que los imports existentes (leads-client,
// entregas-client, leads/schema) sigan funcionando.

export {
  ROW_COLOR_VALUES,
  LEAD_ROW_COLORS,
  colorOf,
  parseRowColor,
  getLeadRowColor,
  COLOR_LABEL,
} from '@/lib/lead-row-color';

export type {
  RowColorValue,
  LeadRowColorInputs,
} from '@/lib/lead-row-color';

// ─── Componentes cliente ─────────────────────────────────────────────

/**
 * Leyenda horizontal con los códigos de color (4 automáticos + 2
 * manuales). Tamaño y peso bajos — referencia secundaria.
 *
 * No usa hooks (es puramente presentacional), pero vive acá porque
 * importa `LEAD_ROW_COLORS` del módulo neutro y hace JSX. Podría
 * moverse a un archivo .tsx neutro, pero está co-locada con los
 * otros componentes por simplicidad.
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
 * Resultado mínimo que la Server Action debe devolver para que el
 * wrapper `RowColorPickerCell` interprete el éxito/error.
 */
export type RowColorMutationResult =
  | { status: 'idle' }
  | { status: 'success' }
  | { status: 'error'; message: string };

/**
 * Selector inline de color manual. Render: círculo del color actual
 * (anillo punteado si 'sin_color'/null). Click → popover con un
 * círculo por color. Al elegir → `onPick(value)`.
 *
 * Defensivo: la lista de colores se evalúa con `Array.isArray` antes
 * de iterar. Si por algún boundary inesperado `ROW_COLOR_VALUES` no
 * llegara como array, caemos a una copia literal para que el picker
 * NUNCA tire "function is not iterable".
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

  // Fallback defensivo (ver docblock). Array.isArray devuelve true para
  // tuplas `as const` regulares en runtime; sólo cae al literal si el
  // bundler entregó algo distinto a un array.
  const options: readonly RowColorValue[] = Array.isArray(ROW_COLOR_VALUES)
    ? ROW_COLOR_VALUES
    : ([
        'rosa',
        'naranja',
        'amarillo',
        'azul',
        'verde',
        'morado',
        'sin_color',
      ] as const);

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
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
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
            {options.map((v) => {
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
 * Wrapper opinado: maneja `useTransition`, error inline y pintado
 * optimista. Recibe la `action` como prop para no acoplar el módulo a
 * un dominio específico. El caller importa la Server Action
 * estáticamente desde su propio `actions.ts` y la pasa acá.
 */
export function RowColorPickerCell({
  leadId,
  value,
  action,
}: {
  leadId: string;
  value: string | null;
  action: (formData: FormData) => Promise<RowColorMutationResult>;
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
          setOptimistic(previous);
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
