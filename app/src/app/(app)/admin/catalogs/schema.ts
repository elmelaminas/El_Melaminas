/**
 * Schemas Zod, tipos y constantes del módulo /admin/catalogs.
 *
 * Vive separado de `actions.ts` porque ese archivo tiene `'use server'` y
 * solo puede exportar async functions: cualquier export de objeto Zod desde
 * un módulo Server Action llega como stub al cliente y `zodResolver(stub)`
 * lanza "Invalid input: not a Zod schema". Ver
 * `app/(app)/admin/users/schema.ts` para el contexto completo.
 */

import { z } from 'zod';

// ─── Sellers ────────────────────────────────────────────────────────────

export const SellerCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Nombre debe tener al menos 2 caracteres')
    .max(120, 'Nombre demasiado largo'),
  phone: z
    .string()
    .trim()
    .max(20, 'Teléfono demasiado largo')
    .optional()
    .or(z.literal('')),
});

export const SellerUpdateSchema = SellerCreateSchema.extend({
  id: z.string().uuid('id de vendedor inválido'),
});

export type SellerCreateInput = z.infer<typeof SellerCreateSchema>;
export type SellerUpdateInput = z.infer<typeof SellerUpdateSchema>;

export type SellerFormState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | {
      status: 'error';
      message: string;
      fieldErrors?: Partial<Record<keyof SellerUpdateInput, string[]>>;
    };

export const initialSellerFormState: SellerFormState = { status: 'idle' };

// ─── Colors ─────────────────────────────────────────────────────────────

export const ColorUpdateSchema = z.object({
  id: z.string().uuid('id de color inválido'),
  name: z
    .string()
    .trim()
    .min(2, 'Nombre debe tener al menos 2 caracteres')
    .max(60, 'Nombre demasiado largo'),
});

export type ColorUpdateInput = z.infer<typeof ColorUpdateSchema>;

export type ColorFormState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | {
      status: 'error';
      message: string;
      fieldErrors?: Partial<Record<keyof ColorUpdateInput, string[]>>;
    };

export const initialColorFormState: ColorFormState = { status: 'idle' };

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Normaliza un nombre para deduplicación: NFD + strip diacríticos + lower
 * + trim. Lo usamos para `colors.normalized_name` (la columna existe en la
 * tabla y es nullable; la rellenamos en cada insert/update). Si la DB tuviera
 * un trigger BEFORE INSERT/UPDATE que la calcule, este valor se sobrescribe
 * — no rompe nada.
 *
 *   normalizeName('Parotá ')   === 'parota'
 *   normalizeName('  Wengué ') === 'wengue'
 */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}
