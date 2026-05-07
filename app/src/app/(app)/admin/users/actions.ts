'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { CreateUserSchema, type CreateUserState } from './schema';

// NB: este archivo solo puede exportar async functions porque tiene
// `'use server'`. Schema, tipos y constantes viven en `./schema`. Ver el
// docblock de ese archivo para el por qué.

/**
 * Crea un usuario en Supabase Auth y su profile correspondiente.
 *
 * **Política de errores:** TODO error (incluyendo throws síncronos en
 * `supabaseAdmin()` por env vars faltantes) se convierte en `CreateUserState`
 * con mensaje legible. Nunca dejamos escapar una excepción al cliente porque
 * en producción Next.js sanitiza el mensaje a "An error occurred…" y el
 * usuario no ve nada útil. También logueamos a `console.error` con prefijo
 * `[createUserAction]` para que aparezca en Vercel Function Logs.
 *
 * Flujo:
 *  1. Validar con Zod (defensa en profundidad).
 *  2. `auth.admin.createUser` con email_confirm:true y password temporal.
 *  3. Upsert profile con valores autoritativos (no dependemos del trigger).
 *  4. Disparar email de reset para que el usuario elija contraseña.
 *  5. Rollback (delete auth user) si el upsert falla.
 */
export async function createUserAction(
  _prev: CreateUserState,
  formData: FormData,
): Promise<CreateUserState> {
  try {
    const parsed = CreateUserSchema.safeParse({
      full_name: formData.get('full_name'),
      email: formData.get('email'),
      phone: formData.get('phone'),
      role: formData.get('role'),
    });

    if (!parsed.success) {
      console.error('[createUserAction] validación falló:', parsed.error.flatten());
      return {
        status: 'error',
        message: 'Datos inválidos',
        fieldErrors: parsed.error.flatten().fieldErrors,
      };
    }

    const { full_name, email, phone, role } = parsed.data;
    const normalizedPhone = phone && phone.length > 0 ? phone : null;

    // Si las env vars faltan, esto lanza — el catch de abajo lo convierte en
    // un CreateUserState con mensaje legible.
    const admin = supabaseAdmin();

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

    if (createErr || !created?.user) {
      console.error('[createUserAction] auth.admin.createUser falló:', createErr);
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
      console.error('[createUserAction] profiles.upsert falló:', profileErr);
      // Rollback — evita cuentas huérfanas en auth.users.
      await admin.auth.admin.deleteUser(userId).catch((rollbackErr) => {
        console.error('[createUserAction] rollback deleteUser falló:', rollbackErr);
      });
      return {
        status: 'error',
        message: `No se pudo crear el perfil: ${profileErr.message}`,
      };
    }

    const { error: resetErr } = await admin.auth.resetPasswordForEmail(email);
    if (resetErr) {
      // No fallamos toda la operación: el admin puede re-enviar después.
      console.error('[createUserAction] resetPasswordForEmail falló:', resetErr.message);
    }

    revalidatePath('/admin/users');
    return {
      status: 'success',
      message: 'Usuario creado. Se envió correo para configurar contraseña.',
    };
  } catch (err) {
    // Cualquier throw inesperado (env vars faltantes, network, etc.)
    const message = err instanceof Error ? err.message : 'Error desconocido al crear usuario';
    console.error('[createUserAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}

/**
 * Activa o desactiva una cuenta. Misma política de errores que createUser.
 */
export async function toggleUserActiveAction(
  userId: string,
  nextActive: boolean,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    if (typeof userId !== 'string' || userId.length === 0) {
      return { ok: false, message: 'userId inválido' };
    }

    const admin = supabaseAdmin();
    const { error } = await admin
      .from('profiles')
      .update({ is_active: nextActive })
      .eq('id', userId);

    if (error) {
      console.error('[toggleUserActiveAction] update falló:', error);
      return { ok: false, message: error.message };
    }

    revalidatePath('/admin/users');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    console.error('[toggleUserActiveAction] excepción no controlada:', err);
    return { ok: false, message };
  }
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
