/**
 * Schema y tipos para /contador.
 *
 * Refactor (2026-05): el contador ya NO recibe efectivo de choferes
 * (ahora lo hace el admin). El contador solo valida la caja del admin
 * registrando un egreso en `admin_cash_register`.
 *
 * Validamos solo `admin_id`. El monto que se transfiere se calcula
 * server-side con un SELECT de los movimientos del admin (suma de
 * ingresos − egresos) — el cliente NO manda el amount, para evitar
 * race conditions con ingresos concurrentes (el chofer entregando
 * más efectivo al admin mientras el contador presiona el botón).
 */

import { z } from 'zod';

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
