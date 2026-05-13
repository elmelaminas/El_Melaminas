/**
 * Schema y tipos compartidos entre cliente (RHF + zodResolver) y servidor
 * (Server Actions con safeParse).
 *
 * **Por qué este archivo existe (en lugar de declarar el schema en
 * `actions.ts`):**
 * Un módulo con `'use server'` solo puede exportar async functions: cada
 * export se transforma en una referencia RPC invocable desde el cliente
 * (ver Next 16 docs `01-app/03-api-reference/01-directives/use-server.md`,
 * y la spec React: https://19.react.dev/reference/rsc/server-functions).
 *
 * Si exportas un objeto Zod desde un archivo `'use server'`, el cliente
 * recibe un stub (no el schema real) y `zodResolver(stub)` cae en
 * `throw new Error('Invalid input: not a Zod schema')`
 * (`@hookform/resolvers/zod/src/zod.ts:314`) porque el stub no pasa
 * `isZod3Schema` ni `isZod4Schema`.
 *
 * Por eso schema, tipos y constantes viven en este módulo neutro y se
 * importan tanto desde `actions.ts` como desde `new-user-modal.tsx`.
 */

import { z } from 'zod';
import type { Role } from '@/data/mock';

export const ROLES = [
  'admin',
  'seller',
  'driver',
  'warehouse',
  'supervisor',
  'contador',
] as const satisfies readonly Role[];

export const CreateUserSchema = z.object({
  full_name: z
    .string()
    .trim()
    .min(2, 'Nombre debe tener al menos 2 caracteres')
    .max(120, 'Nombre demasiado largo'),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Correo inválido'),
  phone: z
    .string()
    .trim()
    .max(20, 'Teléfono demasiado largo')
    .optional()
    .or(z.literal('')),
  role: z.enum(ROLES, { message: 'Rol inválido' }),
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;

export type CreateUserState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | {
      status: 'error';
      message: string;
      fieldErrors?: Partial<Record<keyof CreateUserInput, string[]>>;
    };

export const initialCreateUserState: CreateUserState = { status: 'idle' };

// ─── Edit user ──────────────────────────────────────────────────────────
//
// El correo NO es editable acá — es el identificador de Supabase Auth y
// cambiarlo requiere flujo separado (email change confirm). La contraseña
// tampoco se toca desde acá: para resetear, /forgot-password.

export const EditUserSchema = z.object({
  profile_id: z.string().uuid('profile_id inválido'),
  full_name: z
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
  role: z.enum(ROLES, { message: 'Rol inválido' }),
});

export type EditUserInput = z.infer<typeof EditUserSchema>;

export type EditUserState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | {
      status: 'error';
      message: string;
      // Excluimos profile_id de los fieldErrors mostrables porque es un
      // hidden value en el modal — no hay input al que asociar el error.
      fieldErrors?: Partial<
        Record<Exclude<keyof EditUserInput, 'profile_id'>, string[]>
      >;
    };

export const initialEditUserState: EditUserState = { status: 'idle' };
