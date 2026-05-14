/**
 * Schema y tipos para /contador (recepción de efectivo).
 *
 * Vive separado de actions.ts ('use server'). Mismo patrón que el resto.
 *
 * Validamos solo `driver_id`. El monto que se transfiere se calcula
 * server-side con un SELECT de los `cash_transfers` pendientes del
 * chofer en el momento del action — el cliente NO manda el amount,
 * para evitar que un click en el botón "Recibí efectivo" tras un cobro
 * concurrente del chofer produzca un mismatch.
 */

import { z } from 'zod';

export const ReceiveCashSchema = z.object({
  driver_id: z.string().uuid('Selecciona un chofer'),
});

export type ReceiveCashInput = z.infer<typeof ReceiveCashSchema>;

export type ReceiveCashState =
  | { status: 'idle' }
  | { status: 'success'; message: string; received: number }
  | { status: 'error'; message: string; fieldErrors?: Record<string, string[]> };

export const initialReceiveCashState: ReceiveCashState = { status: 'idle' };

/**
 * Schema para `receiveAdminCashAction`. El contador recibe el efectivo
 * que un admin acumuló por cobros en efectivo directo (ver
 * `admin_cash_register`). NO confiamos en el monto del cliente — el
 * servidor lo recalcula desde el saldo actual del admin para evitar
 * race conditions con cobros concurrentes.
 */
export const ReceiveAdminCashSchema = z.object({
  admin_id: z.string().uuid('admin_id inválido'),
});

export type ReceiveAdminCashInput = z.infer<typeof ReceiveAdminCashSchema>;

export type ReceiveAdminCashState =
  | { status: 'idle' }
  | { status: 'success'; received: number }
  | { status: 'error'; message: string };

export const initialReceiveAdminCashState: ReceiveAdminCashState = {
  status: 'idle',
};
