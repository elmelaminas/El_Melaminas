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
