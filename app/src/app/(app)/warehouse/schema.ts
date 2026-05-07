/**
 * Zod schema y tipos para /warehouse — entrada de material.
 *
 * Vive separado de actions.ts ('use server'). Mismo patrón que el resto.
 */

import { z } from 'zod';

export const RegisterEntrySchema = z.object({
  color_id: z.string().uuid('Selecciona un material'),
  quantity: z
    .number({ invalid_type_error: 'Cantidad inválida' })
    .int('Cantidad debe ser entera')
    .positive('Cantidad debe ser ≥ 1')
    .max(100_000, 'Cantidad demasiado grande'),
  reference: z
    .string()
    .trim()
    .max(120, 'Referencia demasiado larga')
    .optional()
    .or(z.literal('')),
  unit_cost: z
    .number({ invalid_type_error: 'Costo inválido' })
    .nonnegative('Costo debe ser ≥ 0')
    .max(10_000_000, 'Costo demasiado grande')
    .optional(),
});

export type RegisterEntryInput = z.infer<typeof RegisterEntrySchema>;

export type RegisterEntryState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | {
      status: 'error';
      message: string;
      fieldErrors?: Record<string, string[]>;
    };

export const initialRegisterEntryState: RegisterEntryState = { status: 'idle' };

/**
 * Movement types soportados por la DB. Los confirmamos del DDL del usuario:
 * entrada, salida, compromiso, liberacion, ajuste.
 */
export const MOVEMENT_TYPE_VALUES = [
  'entrada',
  'salida',
  'compromiso',
  'liberacion',
  'ajuste',
] as const;
export type MovementType = (typeof MOVEMENT_TYPE_VALUES)[number];

export const MOVEMENT_TYPE_LABEL: Record<MovementType, string> = {
  entrada: 'Entrada',
  salida: 'Salida',
  compromiso: 'Compromiso',
  liberacion: 'Liberación',
  ajuste: 'Ajuste',
};
