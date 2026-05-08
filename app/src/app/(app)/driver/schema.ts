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
