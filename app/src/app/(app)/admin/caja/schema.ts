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
 * Además del `transfer_id`, requerimos `pin` (4 dígitos) — el admin
 * confirma su identidad antes de cerrar el ciclo financiero, igual que
 * el contador en /contador. El monto se lee fresco del server.
 */
export const ReceiveDriverCashSchema = z.object({
  transfer_id: z.string().uuid('ID de transferencia inválido'),
  pin: z
    .string()
    .regex(/^\d{4}$/, 'PIN debe tener exactamente 4 dígitos'),
});

export type ReceiveDriverCashInput = z.infer<typeof ReceiveDriverCashSchema>;

export type ReceiveDriverCashState =
  | { status: 'idle' }
  | { status: 'success'; received: number }
  | {
      status: 'error';
      message: string;
      reason?:
        | 'pin_incorrect'
        | 'pin_missing'
        | 'already_received'
        | 'other';
    };

export const initialReceiveDriverCashState: ReceiveDriverCashState = {
  status: 'idle',
};
