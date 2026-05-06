'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { Role } from '@/data/mock';

const ROLES = ['admin', 'seller', 'driver', 'warehouse', 'supervisor'] as const satisfies readonly Role[];

/**
 * Schema compartido entre cliente (RHF + zodResolver) y servidor (validación
 * de defensa en profundidad). Si lo modificas, actualiza también el modal.
 */
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

/**
 * Crea un usuario en Supabase Auth y su profile correspondiente.
 *
 * Flujo:
 *  1. Validamos con Zod (defensa en profundidad — el cliente también valida).
 *  2. `auth.admin.createUser` con email_confirm:true y password temporal
 *     aleatorio. El usuario nunca verá ese password.
 *  3. Hacemos `upsert` sobre profiles con los valores autoritativos. El
 *     trigger `handle_new_user` ya pudo haber creado la fila — el upsert
 *     garantiza que el `role`, `full_name`, `phone` y `is_active` queden
 *     como queremos sin depender de qué metadata leyó el trigger.
 *  4. Disparamos `resetPasswordForEmail` para que el usuario reciba un
 *     correo y elija su propia contraseña.
 *  5. Si el upsert falla, hacemos rollback borrando el usuario de auth.
 */
export async function createUserAction(
  _prev: CreateUserState,
  formData: FormData,
): Promise<CreateUserState> {
  const parsed = CreateUserSchema.safeParse({
    full_name: formData.get('full_name'),
    email: formData.get('email'),
    phone: formData.get('phone'),
    role: formData.get('role'),
  });

  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Datos inválidos',
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const { full_name, email, phone, role } = parsed.data;
  const normalizedPhone = phone && phone.length > 0 ? phone : null;

  const admin = supabaseAdmin();

  // Password temporal — el usuario nunca lo conoce, queda invalidado al
  // completar el flujo de recuperación.
  const tempPassword = generateTempPassword();

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: {
      full_name,
      role,
      phone: normalizedPhone,
    },
  });

  if (createErr || !created.user) {
    return {
      status: 'error',
      message: createErr?.message ?? 'No se pudo crear el usuario en Auth',
    };
  }

  const userId = created.user.id;

  const { error: profileErr } = await admin
    .from('profiles')
    .upsert(
      {
        id: userId,
        full_name,
        role,
        phone: normalizedPhone,
        is_active: true,
      },
      { onConflict: 'id' },
    );

  if (profileErr) {
    // Rollback — si no podemos persistir el profile, eliminamos el auth user
    // para no dejar cuentas huérfanas que luego choquen con email duplicado.
    await admin.auth.admin.deleteUser(userId);
    return {
      status: 'error',
      message: `No se pudo crear el perfil: ${profileErr.message}`,
    };
  }

  // Email para que el usuario configure su propia contraseña. No fallamos
  // toda la operación si esto falla — el admin puede reenviarlo después.
  const { error: resetErr } = await admin.auth.resetPasswordForEmail(email);
  if (resetErr) {
    console.error('[createUserAction] resetPasswordForEmail falló:', resetErr.message);
  }

  revalidatePath('/admin/users');
  return {
    status: 'success',
    message: 'Usuario creado. Se envió correo para configurar contraseña.',
  };
}

/**
 * Activa o desactiva una cuenta. Conservamos el registro y el historial,
 * solo flipeamos `is_active` — la cuenta de auth.users sigue existiendo.
 */
export async function toggleUserActiveAction(
  userId: string,
  nextActive: boolean,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (typeof userId !== 'string' || userId.length === 0) {
    return { ok: false, message: 'userId inválido' };
  }

  const admin = supabaseAdmin();
  const { error } = await admin
    .from('profiles')
    .update({ is_active: nextActive })
    .eq('id', userId);

  if (error) {
    return { ok: false, message: error.message };
  }

  revalidatePath('/admin/users');
  return { ok: true };
}

/**
 * Genera un password temporal de 32 hex chars usando WebCrypto. Disponible
 * globalmente en Node 18+ que es lo que pide Next 16.
 */
function generateTempPassword(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
