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
 *
 * Tabla `delivery_issues` (creada en migración manual, ver SQL en commit
 * de la feature): id, lead_id, driver_id, issue_type ('faltante'|'detalle'),
 * description, photo_url, resolved, created_at. Permite al chofer
 * reportar problemas durante la entrega — admin los ve en
 * /admin/entregas y los resuelve.
 */

import { z } from 'zod';

// Métodos de pago aceptados al confirmar una entrega. Mismo enum que
// /payments/new (payment_method_enum en DB). Cuando el adeudo es 0
// el chofer NO selecciona método — el campo viene como null.
export const DRIVER_PAYMENT_METHOD_VALUES = [
  'efectivo',
  'transferencia',
  'clip',
] as const;
export const DRIVER_PAYMENT_METHOD_OPTIONS: {
  value: (typeof DRIVER_PAYMENT_METHOD_VALUES)[number];
  label: string;
  emoji: string;
}[] = [
  { value: 'efectivo', label: 'Efectivo', emoji: '💵' },
  { value: 'transferencia', label: 'Transferencia', emoji: '💳' },
  { value: 'clip', label: 'Clip', emoji: '📱' },
];

/**
 * Roles posibles a los que el chofer puede entregar el efectivo
 * cobrado en una entrega. Se usa para gatear el dropdown de
 * destinatarios y para alimentar `cash_transfers.receiver_role`.
 */
export const RECEIVER_ROLE_VALUES = ['admin', 'contador'] as const;
export type ReceiverRole = (typeof RECEIVER_ROLE_VALUES)[number];

export const ConfirmDeliverySchema = z
  .object({
    lead_id: z.string().uuid('lead_id inválido'),
    receiver_id: z
      .string()
      .uuid('Selecciona la persona que recibirá el efectivo')
      .optional()
      .or(z.literal('')),
    /** Rol del destinatario del efectivo — 'admin' o 'contador'.
     *  Required cuando se cobra en efectivo. Se persiste como
     *  `cash_transfers.receiver_role` para que el receptor correcto
     *  vea la transferencia en su panel. */
    receiver_role: z
      .enum(RECEIVER_ROLE_VALUES, { message: 'Destinatario inválido' })
      .optional()
      .nullable(),
    amount_collected: z
      .number({ invalid_type_error: 'Monto inválido' })
      .nonnegative('Monto debe ser ≥ 0')
      .max(10_000_000, 'Monto demasiado grande'),
    /** Método de pago. Required cuando `amount_collected > 0`.
     *  El refine cross-field abajo aplica esa regla. */
    payment_method: z
      .enum(DRIVER_PAYMENT_METHOD_VALUES, {
        message: 'Método de pago inválido',
      })
      .optional()
      .nullable(),
  })
  .refine(
    (d) => {
      // Si hay cobro, el método es obligatorio.
      if (d.amount_collected > 0) {
        return d.payment_method != null;
      }
      return true;
    },
    {
      message: 'Selecciona el método de pago.',
      path: ['payment_method'],
    },
  )
  .refine(
    (d) => {
      // Si pagó en efectivo, el chofer debe escoger el rol de la
      // persona que recibirá ese cash (admin o contador).
      if (d.amount_collected > 0 && d.payment_method === 'efectivo') {
        return d.receiver_role != null;
      }
      return true;
    },
    {
      message: 'Selecciona a quién entregas el efectivo.',
      path: ['receiver_role'],
    },
  )
  .refine(
    (d) => {
      // Si pagó en efectivo, el receiver_id (persona específica con
      // ese rol) también es requerido.
      if (d.amount_collected > 0 && d.payment_method === 'efectivo') {
        return typeof d.receiver_id === 'string' && d.receiver_id.length > 0;
      }
      return true;
    },
    {
      message: 'Selecciona la persona que recibirá el efectivo.',
      path: ['receiver_id'],
    },
  );

export type ConfirmDeliveryInput = z.infer<typeof ConfirmDeliverySchema>;

export type ConfirmDeliveryState =
  | { status: 'idle' }
  | { status: 'success'; message: string; deliveryId: string }
  | { status: 'error'; message: string; fieldErrors?: Record<string, string[]> };

export const initialConfirmDeliveryState: ConfirmDeliveryState = {
  status: 'idle',
};

// ─── Issue reporting (faltantes / detalles) ──────────────────────────

export const ISSUE_TYPE_VALUES = ['faltante', 'detalle'] as const;
export const ISSUE_TYPE_OPTIONS: {
  value: (typeof ISSUE_TYPE_VALUES)[number];
  label: string;
}[] = [
  { value: 'faltante', label: 'Faltante' },
  { value: 'detalle', label: 'Detalle' },
];

/**
 * El chofer reporta un problema durante la entrega: una pieza faltante
 * o un detalle (rayón, golpe, color equivocado, etc.). La foto es
 * opcional pero altamente recomendada para que el admin pueda valorar
 * sin volver a la dirección.
 */
export const ReportIssueSchema = z.object({
  lead_id: z.string().uuid('lead_id inválido'),
  issue_type: z.enum(ISSUE_TYPE_VALUES, { message: 'Tipo inválido' }),
  description: z
    .string()
    .trim()
    .min(3, 'Descripción requerida (mín. 3 caracteres)')
    .max(500, 'Descripción demasiado larga'),
});

export type ReportIssueInput = z.infer<typeof ReportIssueSchema>;

export type ReportIssueState =
  | { status: 'idle' }
  | { status: 'success' }
  | {
      status: 'error';
      message: string;
      fieldErrors?: Record<string, string[]>;
    };

export const initialReportIssueState: ReportIssueState = { status: 'idle' };

// ─── Failed delivery (Grupo 2) ───────────────────────────────────────

/**
 * El chofer no pudo entregar una pieza (cliente ausente, dirección
 * inaccesible, rechazo, etc.). Registramos el motivo + foto del lugar.
 *
 * El lead queda en `delivery_status='pendiente'` (NO 'cancelado'): la
 * entrega se reintenta en otro día. Las columnas
 * `failed_delivery_reason` y `failed_delivery_photo_url` se llenan
 * para que el admin vea el badge naranja "No entregado" en
 * /admin/entregas.
 *
 * Migración manual previa en Supabase:
 *   ALTER TABLE leads ADD COLUMN IF NOT EXISTS failed_delivery_reason text;
 *   ALTER TABLE leads ADD COLUMN IF NOT EXISTS failed_delivery_photo_url text;
 */
export const MarkFailedDeliverySchema = z.object({
  lead_id: z.string().uuid('lead_id inválido'),
  reason: z
    .string()
    .trim()
    .min(10, 'El motivo debe tener al menos 10 caracteres')
    .max(1000, 'El motivo es demasiado largo'),
});

export type MarkFailedDeliveryInput = z.infer<typeof MarkFailedDeliverySchema>;

export type MarkFailedDeliveryState =
  | { status: 'idle' }
  | { status: 'success' }
  | {
      status: 'error';
      message: string;
      fieldErrors?: Record<string, string[]>;
    };

export const initialMarkFailedDeliveryState: MarkFailedDeliveryState = {
  status: 'idle',
};
