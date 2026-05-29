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

/**
 * `receiveIndividualFromContadorAction(payment_id, pin)` — un admin
 * recibe del contador UN cobro específico (a nivel cliente) que el
 * contador ya validó previamente. El admin valida con su propio PIN.
 *
 * Pre-condición: el contador debe haber validado este cobro antes
 * (existe un egreso `source='validado_contador'` con el mismo
 * `payment_id`). Sin esa fila el admin no puede recibir nada — el
 * dinero todavía está físicamente en manos del admin original, no del
 * contador.
 */
export const ReceiveIndividualFromContadorSchema = z.object({
  payment_id: z.string().uuid('payment_id inválido'),
  pin: z
    .string()
    .regex(/^\d{4}$/, 'PIN debe tener exactamente 4 dígitos'),
});

export type ReceiveIndividualFromContadorInput = z.infer<
  typeof ReceiveIndividualFromContadorSchema
>;

export type ReceiveIndividualFromContadorState =
  | { status: 'idle' }
  | { status: 'success'; received: number }
  | {
      status: 'error';
      message: string;
      reason?:
        | 'pin_incorrect'
        | 'pin_missing'
        | 'not_validated'
        | 'already_received'
        | 'other';
    };

export const initialReceiveIndividualFromContadorState: ReceiveIndividualFromContadorState =
  { status: 'idle' };

/**
 * `receiveBulkFromContadorAction(payment_ids, pin)` — el admin recibe
 * del contador VARIOS cobros en un solo gesto, validando una sola vez
 * con su PIN. Implementa el flujo de checkboxes en la tabla "Cobros en
 * efectivo registrados".
 *
 * Pre-condición por cada payment_id: igual que la versión individual
 * (existe egreso `validado_contador`, no existe ya un ingreso
 * `recibido_contador`).
 *
 * Semántica de fallos: si cualquier payment_id no cumple las
 * pre-condiciones, abortamos toda la operación y hacemos rollback de
 * los inserts ya realizados (best-effort). Esto evita estados
 * parciales donde una parte del bulk se aplicó y la otra no.
 *
 * Cota razonable: max 100 payment_ids por bulk para evitar
 * abuso/timeout.
 */
export const ReceiveBulkFromContadorSchema = z.object({
  payment_ids: z
    .array(z.string().uuid('payment_id inválido'))
    .min(1, 'Selecciona al menos un cobro')
    .max(100, 'Demasiados cobros seleccionados'),
  pin: z
    .string()
    .regex(/^\d{4}$/, 'PIN debe tener exactamente 4 dígitos'),
});

export type ReceiveBulkFromContadorInput = z.infer<
  typeof ReceiveBulkFromContadorSchema
>;

export type ReceiveBulkFromContadorState =
  | { status: 'idle' }
  | {
      status: 'success';
      /** Suma de montos recibidos en este bulk. */
      received: number;
      /** Cantidad de cobros recibidos en este bulk. */
      count: number;
    }
  | {
      status: 'error';
      message: string;
      reason?:
        | 'pin_incorrect'
        | 'pin_missing'
        | 'not_validated'
        | 'already_received'
        | 'other';
    };

export const initialReceiveBulkFromContadorState: ReceiveBulkFromContadorState =
  { status: 'idle' };

/**
 * `bulkReceiveCashContadorAction(payment_ids, pin)` — el contador
 * valida en bulk varios cobros en efectivo desde la tabla "Cobros en
 * efectivo registrados". Reemplaza al flujo per-row de
 * `receiveIndividualCashAction` para el rol contador.
 *
 * Pre-condición por cada payment_id: existe un ingreso
 * `source='pago_efectivo'` y no existe ya un egreso
 * `validado_contador` con ese mismo payment_id (idempotencia).
 *
 * Side-effect: por cada fila, un INSERT egreso
 * `source='validado_contador'` en la caja del admin que originalmente
 * recibió el efectivo (`admin_id` del ingreso original). El balance
 * de ese admin se reconcilia (ingreso − egreso = 0); el contador
 * "absorbe" el efectivo físicamente.
 */
export const BulkReceiveCashContadorSchema = z.object({
  payment_ids: z
    .array(z.string().uuid('payment_id inválido'))
    .min(1, 'Selecciona al menos un cobro')
    .max(100, 'Demasiados cobros seleccionados'),
  pin: z
    .string()
    .regex(/^\d{4}$/, 'PIN debe tener exactamente 4 dígitos'),
});

export type BulkReceiveCashContadorInput = z.infer<
  typeof BulkReceiveCashContadorSchema
>;

export type BulkReceiveCashContadorState =
  | { status: 'idle' }
  | { status: 'success'; received: number; count: number }
  | {
      status: 'error';
      message: string;
      reason?:
        | 'pin_incorrect'
        | 'pin_missing'
        | 'not_pago_efectivo'
        | 'already_validated'
        | 'other';
    };

export const initialBulkReceiveCashContadorState: BulkReceiveCashContadorState =
  { status: 'idle' };

/**
 * `adminReceiveDirectOrContadorBulkAction(pending_ids, validated_ids, pin)`
 * — un admin (admin o admin2) recibe en bulk una mezcla de cobros:
 *   - `pending_payment_ids`: el contador AÚN no los validó; el admin
 *     los recibe DIRECTO (bypass del contador) con source
 *     `recibido_directo_admin`.
 *   - `validated_payment_ids`: el contador SÍ los validó; el admin
 *     los recibe vía contador con source `recibido_contador` + un
 *     row en `contador_to_admin_transfers`.
 *
 * Al menos un id en alguno de los dos arrays. Total ≤ 100 para
 * acotar bulks abusivos. PIN del admin que ejecuta.
 *
 * Por cada `pending_payment_id` se insertan DOS rows en
 * `admin_cash_register`:
 *   1. EGRESO en la caja del admin original (admin que recibió cash
 *      del cliente) con source `recibido_directo_admin` — el dinero
 *      sale de su caja.
 *   2. INGRESO en la caja del admin actual con source
 *      `recibido_directo_admin` — el dinero entra a la mía.
 * Esto mantiene la contabilidad balanceada (ingreso − egreso = 0
 * por admin) sin involucrar al contador.
 */
export const AdminReceiveDirectOrContadorBulkSchema = z
  .object({
    pending_payment_ids: z.array(z.string().uuid('payment_id inválido')),
    validated_payment_ids: z.array(z.string().uuid('payment_id inválido')),
    pin: z
      .string()
      .regex(/^\d{4}$/, 'PIN debe tener exactamente 4 dígitos'),
  })
  .refine(
    (d) =>
      d.pending_payment_ids.length + d.validated_payment_ids.length >= 1,
    {
      message: 'Selecciona al menos un cobro',
      path: ['pending_payment_ids'],
    },
  )
  .refine(
    (d) =>
      d.pending_payment_ids.length + d.validated_payment_ids.length <= 100,
    {
      message: 'Demasiados cobros seleccionados',
      path: ['pending_payment_ids'],
    },
  );

export type AdminReceiveDirectOrContadorBulkInput = z.infer<
  typeof AdminReceiveDirectOrContadorBulkSchema
>;

export type AdminReceiveDirectOrContadorBulkState =
  | { status: 'idle' }
  | {
      status: 'success';
      received: number;
      direct_count: number;
      contador_count: number;
    }
  | {
      status: 'error';
      message: string;
      reason?:
        | 'pin_incorrect'
        | 'pin_missing'
        | 'not_validated'
        | 'already_received'
        | 'concurrent_validation'
        | 'other';
    };

export const initialAdminReceiveDirectOrContadorBulkState: AdminReceiveDirectOrContadorBulkState =
  { status: 'idle' };
