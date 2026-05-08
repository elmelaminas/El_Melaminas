/**
 * Schemas Zod, tipos y enums DB↔UI para /payments/new.
 *
 * Vive separado de actions.ts porque ese archivo tiene 'use server' y
 * solo puede exportar async functions. Ver
 * `app/(app)/admin/users/schema.ts` y `app/(app)/leads/new/schema.ts`
 * para el contexto del patrón.
 *
 * SUPOSICIONES sobre la DB (sin DDL real):
 *   - `payments.method` enum: 'efectivo' | 'transferencia' | 'clip'
 *   - `payments.payment_type` enum: 'anticipo' | 'liquidacion'
 *   - `payments.status` enum: 'exitoso' | 'pendiente' | 'rechazado'
 * Si los nombres del enum difieren, el INSERT fallará con
 * "invalid input value for enum X" — visible en el banner del modal.
 */

import { z } from 'zod';

// ─── Enums DB ↔ UI ──────────────────────────────────────────────────────

export const METHOD_VALUES = [
  'efectivo',
  'transferencia',
  'clip',
] as const;
export const METHOD_OPTIONS: { value: (typeof METHOD_VALUES)[number]; label: string }[] = [
  { value: 'efectivo', label: 'Efectivo' },
  { value: 'transferencia', label: 'Transferencia' },
  { value: 'clip', label: 'Clip' },
];

// `contra_entrega` agregado en migración manual:
//   ALTER TYPE payment_type_enum ADD VALUE 'contra_entrega';
// Si la migración aún no corrió, el INSERT con este valor fallará con
// "invalid input value for enum payment_type_enum" — error visible en
// el banner del form.
export const PAYMENT_TYPE_VALUES = [
  'anticipo',
  'liquidacion',
  'contra_entrega',
] as const;
export const PAYMENT_TYPE_OPTIONS: { value: (typeof PAYMENT_TYPE_VALUES)[number]; label: string }[] = [
  { value: 'anticipo', label: 'Anticipo' },
  { value: 'liquidacion', label: 'Liquidación' },
  { value: 'contra_entrega', label: 'Contra entrega' },
];

// ─── Deductible row ─────────────────────────────────────────────────────

export const DeductibleSchema = z.object({
  concept: z
    .string()
    .trim()
    .min(2, 'Concepto requerido (mín. 2 caracteres)')
    .max(80, 'Concepto demasiado largo'),
  amount: z
    .number({ invalid_type_error: 'Monto inválido' })
    .nonnegative('Monto debe ser ≥ 0')
    .max(1_000_000, 'Monto demasiado grande'),
});

export type DeductibleInput = z.infer<typeof DeductibleSchema>;

// ─── Payment ────────────────────────────────────────────────────────────

export const PaymentCreateSchema = z.object({
  lead_id: z.string().uuid('Selecciona un lead'),
  amount: z
    .number({ invalid_type_error: 'Monto inválido' })
    .positive('Monto debe ser > 0')
    .max(10_000_000, 'Monto demasiado grande'),
  method: z.enum(METHOD_VALUES, { message: 'Método inválido' }),
  payment_type: z.enum(PAYMENT_TYPE_VALUES, { message: 'Tipo inválido' }),
  // `driver_id` ya no vive en payments — se asigna al crear el lead en
  // /leads/new. La columna `payments.driver_id` puede seguir existiendo
  // en DB; este endpoint la deja siempre null.
  deductibles: z.array(DeductibleSchema).optional().default([]),
});

export type PaymentCreateInput = z.infer<typeof PaymentCreateSchema>;

export type PaymentFormState =
  | { status: 'idle' }
  | { status: 'success'; message: string; paymentId: string }
  | {
      status: 'error';
      message: string;
      // Paths anidados como "deductibles.0.amount" llegan como string keys.
      fieldErrors?: Record<string, string[]>;
    };

export const initialPaymentFormState: PaymentFormState = { status: 'idle' };

// ─── Helpers ────────────────────────────────────────────────────────────

export function emptyToNull(v: string | undefined | null): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}
