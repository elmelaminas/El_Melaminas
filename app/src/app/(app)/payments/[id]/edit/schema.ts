/**
 * Schema Zod + tipos para `updatePaymentAction` (/payments/[id]/edit).
 *
 * Comparte enums (METHOD_VALUES, PAYMENT_TYPE_VALUES, DeductibleSchema)
 * con `/payments/new/schema.ts` — la edición tiene exactamente el mismo
 * shape de datos persistibles, sólo cambia el lead_id (immutable acá) y
 * la presencia de un payment_id.
 */

import { z } from 'zod';
import {
  METHOD_VALUES,
  PAYMENT_TYPE_VALUES,
  DeductibleSchema,
} from '../../new/schema';

export const PaymentUpdateSchema = z.object({
  amount: z
    .number({ invalid_type_error: 'Monto inválido' })
    .positive('Monto debe ser > 0')
    .max(10_000_000, 'Monto demasiado grande'),
  method: z.enum(METHOD_VALUES, { message: 'Método inválido' }),
  payment_type: z.enum(PAYMENT_TYPE_VALUES, { message: 'Tipo inválido' }),
  deductibles: z.array(DeductibleSchema).optional().default([]),
  /** Si el admin marcó "quitar evidencia actual" desde el formulario.
   *  Cuando es true Y no se subió un archivo nuevo, dejamos
   *  `evidence_photo_url = null` en el UPDATE. */
  remove_evidence: z.boolean().optional().default(false),
});

export type PaymentUpdateInput = z.infer<typeof PaymentUpdateSchema>;

export type PaymentUpdateState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | {
      status: 'error';
      message: string;
      fieldErrors?: Record<string, string[]>;
    };

export const initialPaymentUpdateState: PaymentUpdateState = {
  status: 'idle',
};
