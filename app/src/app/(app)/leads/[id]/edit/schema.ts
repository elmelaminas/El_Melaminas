/**
 * Schema y tipos para /leads/[id]/edit.
 *
 * Solo dos campos editables: `sale_date` y `driver_id`. El resto del
 * lead (cliente, dirección, materiales, montos) es deliberadamente
 * inmutable desde esta UI — si necesitas cambiar otra cosa, el flujo
 * recomendado es cancelar el lead y crear uno nuevo, así no se rompe
 * la trazabilidad del inventario comprometido + payments asociados.
 *
 * El control de acceso (solo admin) vive en el Server Action y en el
 * page.tsx — la regla del middleware solo restringe la ruta.
 */

import { z } from 'zod';

export const LeadEditSchema = z.object({
  sale_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (formato YYYY-MM-DD)'),
  driver_id: z
    .string()
    .uuid('Chofer inválido')
    .optional()
    .or(z.literal('')),
});

export type LeadEditInput = z.infer<typeof LeadEditSchema>;

export type LeadEditState =
  | { status: 'idle' }
  | { status: 'success' }
  | {
      status: 'error';
      message: string;
      fieldErrors?: Record<string, string[]>;
    };

export const initialLeadEditState: LeadEditState = { status: 'idle' };
