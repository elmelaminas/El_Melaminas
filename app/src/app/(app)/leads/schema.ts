/**
 * Schemas y tipos para los actions a nivel del LISTADO de /leads.
 *
 * NB: los actions del FORMULARIO de creación viven en
 * `/leads/new/{schema,actions}.ts` — éste módulo es solo para acciones
 * que ocurren desde el listado (cambiar color manual, etc.).
 *
 * Vive separado de `actions.ts` ('use server') por el patrón estándar
 * del proyecto: un módulo 'use server' solo puede exportar async
 * functions, así que schemas y tipos viven en este módulo neutro.
 */

import { z } from 'zod';
// Import directo del módulo NEUTRO (no `'use client'`). Importar
// `ROW_COLOR_VALUES` desde `@/components/ui/lead-row-color` ('use
// client') causaba que Next 16 lo entregara como referencia cliente
// al evaluarse desde `actions.ts` ('use server') → z.enum(ref, ...)
// fallaba con "function is not iterable" en runtime.
import { ROW_COLOR_VALUES } from '@/lib/lead-row-color';

export const UpdateLeadColorSchema = z.object({
  lead_id: z.string().uuid('lead_id inválido'),
  row_color: z.enum(ROW_COLOR_VALUES, { message: 'Color inválido' }),
});

export type UpdateLeadColorInput = z.infer<typeof UpdateLeadColorSchema>;

export type UpdateLeadColorState =
  | { status: 'idle' }
  | { status: 'success' }
  | { status: 'error'; message: string };

export const initialUpdateLeadColorState: UpdateLeadColorState = {
  status: 'idle',
};

/**
 * Estado del action `markFabricaDeliveredAction`. Mismo shape simple
 * que el resto de actions del listado: idle al cargar la página,
 * success al confirmar y error con mensaje legible si falla.
 */
export type MarkFabricaDeliveredState =
  | { status: 'idle' }
  | { status: 'success' }
  | { status: 'error'; message: string };

export const initialMarkFabricaDeliveredState: MarkFabricaDeliveredState = {
  status: 'idle',
};

export const MarkFabricaDeliveredSchema = z.object({
  lead_id: z.string().uuid('lead_id inválido'),
});

export type MarkFabricaDeliveredInput = z.infer<
  typeof MarkFabricaDeliveredSchema
>;
