'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  CreateUserSchema,
  EditUserSchema,
  type CreateUserState,
  type EditUserState,
} from './schema';

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
 * Edita los campos editables del profile (full_name, phone, role).
 *
 * Triple defensa de admin:
 *   1. middleware ya bloquea /admin/* a no-admins.
 *   2. /admin/users/page ya verifica el rol antes de renderizar.
 *   3. acá lo verificamos también — la action puede invocarse fuera
 *      del flujo normal (curl, devtools, otro front).
 *
 * Regla anti-self-demote: si el `profile_id` editado es el del usuario
 * autenticado, NO permitimos cambiar `role` a algo distinto de 'admin'.
 * Sin esto, el último admin podría dejarse fuera del sistema y nadie
 * podría restaurarlo sin acceso directo a DB. Otros admins SÍ pueden
 * demovernos — la consigna explícita del spec es "no se quite a sí
 * mismo el rol".
 *
 * NO se editan: email (identifier de auth) ni password (existe el
 * flujo de /forgot-password). Mismo patrón de error handling que
 * createUserAction.
 */
export async function updateUserAction(
  _prev: EditUserState,
  formData: FormData,
): Promise<EditUserState> {
  try {
    const parsed = EditUserSchema.safeParse({
      profile_id: formData.get('profile_id'),
      full_name: formData.get('full_name'),
      phone: formData.get('phone'),
      role: formData.get('role'),
    });

    if (!parsed.success) {
      console.error(
        '[updateUserAction] validación falló:',
        parsed.error.flatten(),
      );
      // `profile_id` no tiene input visible (es hidden en el modal);
      // omitimos su error de la lista para no enviar errores que el
      // cliente no puede pintar.
      const flat = parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >;
      const { profile_id: _omit, ...visible } = flat;
      void _omit; // suprimir noUnusedLocals
      return {
        status: 'error',
        message: 'Datos inválidos',
        fieldErrors: visible,
      };
    }

    const { profile_id, full_name, phone, role } = parsed.data;
    const normalizedPhone = phone && phone.length > 0 ? phone : null;

    // ── Auth: necesitamos auth.uid() para anti-self-demote y el role
    //    check. supabaseServer() lee de cookies; supabaseAdmin() es
    //    service_role para bypassear RLS al hacer el SELECT/UPDATE.
    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      return {
        status: 'error',
        message: 'Sesión no válida. Vuelve a iniciar sesión.',
      };
    }

    const admin = supabaseAdmin();

    // Role check del caller. Si no es admin, rechazamos sin tocar nada.
    const { data: callerProfile, error: callerErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if (callerErr) {
      console.error(
        '[updateUserAction] no se pudo leer rol del caller:',
        callerErr,
      );
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${callerErr.message}`,
      };
    }
    if (callerProfile?.role !== 'admin' && callerProfile?.role !== 'admin2') {
      return {
        status: 'error',
        message: 'Solo un administrador puede editar usuarios.',
      };
    }

    // Anti-self-demote: si te estás editando a ti mismo, role debe
    // seguir siendo admin o admin2 (ambos son roles administrativos).
    // Antes de leer la fila del target chequeamos los uuids para evitar
    // un round-trip cuando no aplica.
    if (profile_id === user.id && role !== 'admin' && role !== 'admin2') {
      return {
        status: 'error',
        message:
          'No puedes quitarte el rol de administrador a ti mismo. ' +
          'Pide a otro admin que lo haga.',
      };
    }

    const { error: updErr } = await admin
      .from('profiles')
      .update({
        full_name,
        phone: normalizedPhone,
        role,
        // updated_at: now() en el server. Si la columna tiene un
        // trigger BEFORE UPDATE que lo maneja, este valor lo
        // sobreescribe el trigger con el suyo — sin daño. Si no hay
        // trigger, queda el nuestro.
        updated_at: new Date().toISOString(),
      })
      .eq('id', profile_id);

    if (updErr) {
      console.error('[updateUserAction] update falló:', updErr);
      return {
        status: 'error',
        message: `No se pudo actualizar el usuario: ${updErr.message}`,
      };
    }

    revalidatePath('/admin/users');
    return {
      status: 'success',
      message: 'Usuario actualizado.',
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al actualizar usuario';
    console.error('[updateUserAction] excepción no controlada:', err);
    return { status: 'error', message };
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
