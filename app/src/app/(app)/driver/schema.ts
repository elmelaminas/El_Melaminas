/**
 * Schemas Zod y tipos para /driver.
 *
 * Vive separado de actions.ts ('use server'). Mismo patrón que el resto
 * de los módulos.
 *
 * SUPOSICIONES sobre la DB (sin DDL real):
 *   - `driver_deliveries` columns: id, lead_id, driver_id (FK profiles),
 *     receiver_id (FK profiles), amount_collected (numeric nullable),
 *     evidence_url (text nullable), confirmed_at, created_at.
 * Si los nombres difieren, el INSERT fallará con un mensaje preciso
 * que aparecerá en el banner del card.
 */

import { z } from 'zod';

export const ConfirmDeliverySchema = z.object({
  lead_id: z.string().uuid('lead_id inválido'),
  receiver_id: z.string().uuid('Selecciona un admin para recibir el efectivo'),
  amount_collected: z
    .number({ invalid_type_error: 'Monto inválido' })
    .nonnegative('Monto debe ser ≥ 0')
    .max(10_000_000, 'Monto demasiado grande'),
});

export type ConfirmDeliveryInput = z.infer<typeof ConfirmDeliverySchema>;

export type ConfirmDeliveryState =
  | { status: 'idle' }
  | { status: 'success'; message: string; deliveryId: string }
  | { status: 'error'; message: string; fieldErrors?: Record<string, string[]> };

export const initialConfirmDeliveryState: ConfirmDeliveryState = {
  status: 'idle',
};
