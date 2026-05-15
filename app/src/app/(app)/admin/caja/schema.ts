/**
 * Schema y tipos para /admin/caja.
 *
 * Refactor (2026-05): el admin ahora RECIBE efectivo de los choferes
 * (antes lo hacía el contador). El contador valida la caja del admin
 * desde /contador. `cash_transfers` cierra su ciclo en `status='recibido'`
 * sin pasar por 'validado'.
 *
 * Vive separado de actions.ts ('use server'). Mismo patrón que el resto.
 */

import { z } from 'zod';

/**
 * Input para `adminReceivesDriverCashAction`. El admin presiona "Recibí
 * efectivo de {driver}" en /admin/caja → tab "Efectivo de choferes".
 * Validamos solo el `transfer_id`; el monto se lee fresco del server.
 */
export const ReceiveDriverCashSchema = z.object({
  transfer_id: z.string().uuid('ID de transferencia inválido'),
});

export type ReceiveDriverCashInput = z.infer<typeof ReceiveDriverCashSchema>;

export type ReceiveDriverCashState =
  | { status: 'idle' }
  | { status: 'success'; received: number }
  | { status: 'error'; message: string };

export const initialReceiveDriverCashState: ReceiveDriverCashState = {
  status: 'idle',
};
