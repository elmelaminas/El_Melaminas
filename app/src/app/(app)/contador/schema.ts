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

/**
 * `receiveIndividualCashAction(payment_id, pin)` — el contador valida
 * UN cobro en efectivo específico (a nivel cliente, no a nivel admin).
 * Requiere PIN porque cada confirmación es individual y visible al
 * admin como notificación inmediata. El PIN se guarda en
 * `profiles.confirmation_pin` y se asigna desde /admin/users.
 *
 * Validación cliente: payment_id uuid + pin de 4 dígitos.
 */
export const ReceiveIndividualCashSchema = z.object({
  payment_id: z.string().uuid('payment_id inválido'),
  pin: z
    .string()
    .regex(/^\d{4}$/, 'PIN debe tener exactamente 4 dígitos'),
});

export type ReceiveIndividualCashInput = z.infer<
  typeof ReceiveIndividualCashSchema
>;

/**
 * Estados del action `receiveIndividualCashAction`. `pin_incorrect`
 * y `pin_missing` son sub-estados de error que el cliente usa para
 * decidir si reabrir el modal y permitir retry o cerrarlo con error
 * definitivo (PIN no configurado en perfil).
 */
export type ReceiveIndividualCashState =
  | { status: 'idle' }
  | { status: 'success'; received: number }
  | {
      status: 'error';
      message: string;
      reason?: 'pin_incorrect' | 'pin_missing' | 'already_validated' | 'other';
    };

export const initialReceiveIndividualCashState: ReceiveIndividualCashState = {
  status: 'idle',
};

/**
 * `receiveFromContadorAction(contador_id, amount, pin)` — un admin
 * recibe efectivo que el contador tiene en su caja (acumulado de
 * validaciones previas a las cajas de admins). El PIN se valida contra
 * `profiles.confirmation_pin` del admin.
 *
 * El monto SÍ viaja desde el cliente porque el admin elige cuánto
 * recibir (no necesariamente todo el saldo). El server valida que el
 * monto solicitado no exceda el balance vivo del contador
 * (egresos validado_contador − transfers previos) para evitar
 * sobreentregas.
 */
export const ReceiveFromContadorSchema = z.object({
  contador_id: z.string().uuid('contador_id inválido'),
  amount: z
    .number({ invalid_type_error: 'Monto inválido' })
    .positive('El monto debe ser mayor a 0')
    .max(10_000_000, 'Monto demasiado grande'),
  pin: z
    .string()
    .regex(/^\d{4}$/, 'PIN debe tener exactamente 4 dígitos'),
});

export type ReceiveFromContadorInput = z.infer<
  typeof ReceiveFromContadorSchema
>;

export type ReceiveFromContadorState =
  | { status: 'idle' }
  | { status: 'success'; received: number }
  | {
      status: 'error';
      message: string;
      reason?:
        | 'pin_incorrect'
        | 'pin_missing'
        | 'insufficient_balance'
        | 'other';
    };

export const initialReceiveFromContadorState: ReceiveFromContadorState = {
  status: 'idle',
};
