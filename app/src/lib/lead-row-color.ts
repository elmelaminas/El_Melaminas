/**
 * Constantes y utilidades PURAS para los colores de fila de
 * `/leads` y `/admin/entregas`.
 *
 * Vive en un módulo neutro (sin `'use client'` ni `'use server'`)
 * porque lo consumen TRES contextos distintos:
 *
 *   1. Server Actions (`leads/actions.ts` con `'use server'`) — vía
 *      `leads/schema.ts` que importa `ROW_COLOR_VALUES` para
 *      construir `z.enum(...)`.
 *   2. Server Components (`leads/page.tsx`, `admin/entregas/page.tsx`)
 *      — para tipar las filas crudas que vienen de Supabase (no se
 *      usa directamente acá, pero el tipo viaja).
 *   3. Client Components — vía `@/components/ui/lead-row-color`
 *      que re-exporta estas constantes para mantener la API previa.
 *
 * BUG histórico que resolvió este split: cuando estas constantes
 * vivían dentro de un módulo `'use client'` y `schema.ts` las
 * importaba para `z.enum(...)`, el bundler de Next 16 las trataba
 * como referencias cliente en el contexto server → `z.enum(ref, ...)`
 * fallaba con "function is not iterable" en runtime al validar la
 * action. Mantener este archivo NEUTRO es lo que evita ese bug.
 *
 * NO añadir JSX ni hooks acá — eso obligaría a poner `'use client'`
 * y reintroducirìa el bug. Los componentes que sí necesitan client
 * (LeadRowLegend, RowColorPicker, RowColorPickerCell) viven en
 * `@/components/ui/lead-row-color`.
 */

import type { DeliveryStatus, PaymentStatus } from '@/data/mock';

/** Valores válidos de `leads.row_color` (matchea el CHECK constraint).
 *  `'sin_color'` es el sentinel para "limpiar override" y volver a la
 *  lógica automática. */
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

/** Validador runtime — útil cuando llegan valores arbitrarios desde
 *  DB (filas viejas) o desde el cliente sin validar.
 *
 *  Defensivo: si `ROW_COLOR_VALUES` por alguna razón no es un array
 *  iterable (boundary roto, build viejo en cache, etc.), caemos al
 *  conjunto literal para no romper la app. */
export function parseRowColor(v: unknown): RowColorValue | null {
  if (typeof v !== 'string') return null;
  const list = Array.isArray(ROW_COLOR_VALUES)
    ? (ROW_COLOR_VALUES as readonly string[])
    : ([
        'rosa',
        'naranja',
        'amarillo',
        'azul',
        'verde',
        'morado',
        'sin_color',
      ] as const);
  return list.includes(v) ? (v as RowColorValue) : null;
}

/**
 * Colores con transparencia para fondo de fila.
 *
 * Iteración: empezamos con tonos pasteles claros + opacidades por
 * tono (0.45–0.75) pero rosa/azul se veían fuertes y amarillo/naranja/
 * morado se "perdían" contra el fondo blanco — diferencia perceptual
 * inconsistente entre los 6 colores. Solución: usar tonos MÁS
 * SATURADOS en el RGB base y una opacidad uniforme de 0.85 para los
 * 6, así el peso visual queda parejo y todos se ven como "tarjetas
 * coloreadas".
 *
 * `sin_color` → undefined → la fila vuelve al fondo normal.
 */
export const LEAD_ROW_COLORS: Readonly<
  Record<Exclude<RowColorValue, 'sin_color'>, string>
> = {
  rosa: 'rgba(255, 105, 180, 0.85)',
  naranja: 'rgba(255, 140, 0, 0.85)',
  amarillo: 'rgba(255, 215, 0, 0.85)',
  azul: 'rgba(135, 206, 235, 0.85)',
  verde: 'rgba(50, 205, 50, 0.85)',
  morado: 'rgba(147, 112, 219, 0.85)',
};

/**
 * Colores SÓLIDOS (sin alpha) para el borde izquierdo acento de la
 * fila. Combina con el background de `LEAD_ROW_COLORS` para reforzar
 * visualmente la asignación: el borde se ve nítido aún si el background
 * se mezcla con la fila siguiente.
 */
export const LEAD_ROW_BORDERS: Readonly<
  Record<Exclude<RowColorValue, 'sin_color'>, string>
> = {
  rosa: '#FF69B4',
  naranja: '#FF8C00',
  amarillo: '#FFD700',
  azul: '#87CEEB',
  verde: '#32CD32',
  morado: '#9370DB',
};

/** Color de fondo asociado a un RowColorValue, o undefined si
 *  'sin_color' / null / inválido. */
export function colorOf(
  v: RowColorValue | null | undefined,
): string | undefined {
  if (!v || v === 'sin_color') return undefined;
  return LEAD_ROW_COLORS[v];
}

export type LeadRowColorInputs = {
  id: string;
  /** Override manual del admin. Valor válido != 'sin_color' gana
   *  sobre las reglas automáticas. */
  row_color: string | null;
  /** `'venta_empleado'` → rosa (regla automática). */
  sale_type: string | null;
  /** `'con_corte'` → azul (regla automática). */
  product_type: string | null;
  payment_status: PaymentStatus;
  delivery_status: DeliveryStatus;
};

/**
 * Decide la CLAVE de color que aplica (manual o automática), o
 * undefined si ninguna aplica. Helper interno compartido por
 * `getLeadRowColor` y `getLeadRowStyle` — single source of truth de
 * la lógica de prioridad.
 */
function resolveRowColorKey(
  row: LeadRowColorInputs,
  contraEntregaIds: ReadonlySet<string>,
): Exclude<RowColorValue, 'sin_color'> | undefined {
  // A. Override manual gana sobre todo.
  const manual = parseRowColor(row.row_color);
  if (manual && manual !== 'sin_color') return manual;

  // B. Reglas automáticas en orden de prioridad.
  //    Amarillo se reasignó a `product_type='sin_corte'` (2026-05).
  //    Antes la regla era "pagado y sin entregar"; ahora ese estado
  //    no tiene color automático — el admin puede pintarlo a mano.
  if (row.sale_type === 'venta_empleado') return 'rosa';
  if (contraEntregaIds.has(row.id)) return 'naranja';
  if (row.product_type === 'sin_corte') return 'amarillo';
  if (row.product_type === 'con_corte') return 'azul';

  return undefined;
}

/**
 * Devuelve el color de fondo de la fila o undefined si no aplica nada.
 * Mantenido por compatibilidad. Para nuevos callers preferir
 * `getLeadRowStyle`, que también devuelve el borde acento izquierdo.
 */
export function getLeadRowColor(
  row: LeadRowColorInputs,
  contraEntregaIds: ReadonlySet<string>,
): string | undefined {
  const key = resolveRowColorKey(row, contraEntregaIds);
  return key ? LEAD_ROW_COLORS[key] : undefined;
}

/**
 * Devuelve el estilo COMPLETO de la fila — background semitransparente
 * + borde izquierdo de 4px con el tono sólido como acento. undefined
 * cuando ninguna regla aplica (la fila queda con el estilo neutro de
 * la tabla).
 *
 * Diseño: el borde izquierdo se ve nítido aún cuando el background se
 * percibe suave; refuerza visualmente la asignación sin saturar la
 * tipografía. Conjuntamente, la fila se lee como tarjeta coloreada.
 */
export function getLeadRowStyle(
  row: LeadRowColorInputs,
  contraEntregaIds: ReadonlySet<string>,
):
  | {
      background: string;
      borderLeft: string;
    }
  | undefined {
  const key = resolveRowColorKey(row, contraEntregaIds);
  if (!key) return undefined;
  return {
    background: LEAD_ROW_COLORS[key],
    borderLeft: `4px solid ${LEAD_ROW_BORDERS[key]}`,
  };
}

/** Labels en español para cada color (UI). Exportado para que
 *  componentes cliente lo usen sin redefinirlo. */
export const COLOR_LABEL: Readonly<Record<RowColorValue, string>> = {
  sin_color: 'Sin color',
  rosa: 'Rosa',
  morado: 'Morado',
  azul: 'Azul',
  amarillo: 'Amarillo',
  naranja: 'Naranja',
  verde: 'Verde',
};
