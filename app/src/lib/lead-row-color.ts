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
 * Colores con transparencia para fondo de fila. La opacidad de los
 * tonos rosa/azul/verde/morado (manuales mayormente) es 0.45; los
 * automáticos comunes (naranja/amarillo) van en 0.30. Si el admin
 * asigna manualmente rosa, comparte tono con el "venta_empleado"
 * automático — eso es OK, la regla manual gana y se ve igual.
 *
 * `sin_color` → undefined → la fila vuelve al fondo normal.
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
 * Devuelve el color de fondo de la fila o undefined si no aplica nada.
 * Prioridad: manual > automática.
 */
export function getLeadRowColor(
  row: LeadRowColorInputs,
  contraEntregaIds: ReadonlySet<string>,
): string | undefined {
  // A. Override manual gana sobre todo.
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
