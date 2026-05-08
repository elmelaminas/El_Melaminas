/**
 * Schema y tipos para /admin/caja (validación de efectivo recibido).
 *
 * Vive separado de actions.ts ('use server'). Mismo patrón que el resto.
 */

import { z } from 'zod';

export const ValidateTransferSchema = z.object({
  transfer_id: z.string().uuid('ID de transferencia inválido'),
});

export type ValidateTransferInput = z.infer<typeof ValidateTransferSchema>;

export type ValidateTransferState =
  | { status: 'idle' }
  | { status: 'success' }
  | { status: 'error'; message: string };

export const initialValidateTransferState: ValidateTransferState = {
  status: 'idle',
};
