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
import { ROW_COLOR_VALUES } from '@/components/ui/lead-row-color';

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
