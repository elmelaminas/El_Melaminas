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
