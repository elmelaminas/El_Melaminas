'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  SellerCreateSchema,
  SellerUpdateSchema,
  ColorUpdateSchema,
  type SellerFormState,
  type SellerUpdateInput,
  type ColorFormState,
  type ColorUpdateInput,
  normalizeName,
} from './schema';

// NB: este archivo solo puede exportar async functions porque tiene
// `'use server'`. Schema, tipos y constantes viven en `./schema`.

/**
 * Convierte un string opcional a `null` si está vacío o solo whitespace.
 * Evita escribir cadenas vacías a columnas nullable de Postgres.
 */
function emptyToNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

// ─── Sellers ────────────────────────────────────────────────────────────

/**
 * Crea un vendedor en la tabla `sellers`. Política de errores idéntica a
 * `createUserAction`: nunca dejamos escapar un throw — todo se convierte
 * en `SellerFormState` con mensaje legible y se loguea con prefijo
 * `[createSellerAction]` para localizarlo en Vercel Function Logs.
 */
export async function createSellerAction(
  _prev: SellerFormState,
  formData: FormData,
): Promise<SellerFormState> {
  try {
    const parsed = SellerCreateSchema.safeParse({
      name: formData.get('name'),
      phone: formData.get('phone'),
    });

    if (!parsed.success) {
      console.error('[createSellerAction] validación falló:', parsed.error.flatten());
      return {
        status: 'error',
        message: 'Datos inválidos',
        fieldErrors: parsed.error.flatten().fieldErrors as Partial<
          Record<keyof SellerUpdateInput, string[]>
        >,
      };
    }

    const admin = supabaseAdmin();
    const { error } = await admin.from('sellers').insert({
      name: parsed.data.name,
      phone: emptyToNull(parsed.data.phone),
      is_active: true,
    });

    if (error) {
      console.error('[createSellerAction] insert falló:', error);
      return { status: 'error', message: error.message };
    }

    revalidatePath('/admin/catalogs');
    return { status: 'success', message: 'Vendedor creado.' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido al crear vendedor';
    console.error('[createSellerAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}

/**
 * Actualiza name + phone de un vendedor. NO toca `is_active` (eso lo hace
 * `toggleSellerActiveAction`) ni `profile_id` (vínculo a un usuario auth —
 * UI dedicada en otra iteración).
 */
export async function updateSellerAction(
  _prev: SellerFormState,
  formData: FormData,
): Promise<SellerFormState> {
  try {
    const parsed = SellerUpdateSchema.safeParse({
      id: formData.get('id'),
      name: formData.get('name'),
      phone: formData.get('phone'),
    });

    if (!parsed.success) {
      console.error('[updateSellerAction] validación falló:', parsed.error.flatten());
      return {
        status: 'error',
        message: 'Datos inválidos',
        fieldErrors: parsed.error.flatten().fieldErrors as Partial<
          Record<keyof SellerUpdateInput, string[]>
        >,
      };
    }

    const admin = supabaseAdmin();
    const { error } = await admin
      .from('sellers')
      .update({
        name: parsed.data.name,
        phone: emptyToNull(parsed.data.phone),
      })
      .eq('id', parsed.data.id);

    if (error) {
      console.error('[updateSellerAction] update falló:', error);
      return { status: 'error', message: error.message };
    }

    revalidatePath('/admin/catalogs');
    return { status: 'success', message: 'Vendedor actualizado.' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido al actualizar vendedor';
    console.error('[updateSellerAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}

export async function toggleSellerActiveAction(
  id: string,
  nextActive: boolean,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, message: 'id de vendedor inválido' };
    }
    const admin = supabaseAdmin();
    const { error } = await admin
      .from('sellers')
      .update({ is_active: nextActive })
      .eq('id', id);
    if (error) {
      console.error('[toggleSellerActiveAction] update falló:', error);
      return { ok: false, message: error.message };
    }
    revalidatePath('/admin/catalogs');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    console.error('[toggleSellerActiveAction] excepción no controlada:', err);
    return { ok: false, message };
  }
}

// ─── Colors ─────────────────────────────────────────────────────────────

/**
 * Edita el nombre de un color. NO permite crear desde aquí — esa flow vive
 * en `/leads/new` cuando el seller ingresa un color que no existe (módulo B).
 *
 * Mantenemos `normalized_name` sincronizado con `name` para que la búsqueda
 * sea acento-insensitive. Si Postgres tiene un trigger que ya lo calcula,
 * sobrescribimos con el mismo valor — no es un problema.
 */
export async function updateColorAction(
  _prev: ColorFormState,
  formData: FormData,
): Promise<ColorFormState> {
  try {
    const parsed = ColorUpdateSchema.safeParse({
      id: formData.get('id'),
      name: formData.get('name'),
    });

    if (!parsed.success) {
      console.error('[updateColorAction] validación falló:', parsed.error.flatten());
      return {
        status: 'error',
        message: 'Datos inválidos',
        fieldErrors: parsed.error.flatten().fieldErrors as Partial<
          Record<keyof ColorUpdateInput, string[]>
        >,
      };
    }

    const admin = supabaseAdmin();
    const { error } = await admin
      .from('colors')
      .update({
        name: parsed.data.name,
        normalized_name: normalizeName(parsed.data.name),
      })
      .eq('id', parsed.data.id);

    if (error) {
      console.error('[updateColorAction] update falló:', error);
      return { status: 'error', message: error.message };
    }

    revalidatePath('/admin/catalogs');
    return { status: 'success', message: 'Color actualizado.' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido al actualizar color';
    console.error('[updateColorAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}

export async function toggleColorActiveAction(
  id: string,
  nextActive: boolean,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, message: 'id de color inválido' };
    }
    const admin = supabaseAdmin();
    const { error } = await admin
      .from('colors')
      .update({ is_active: nextActive })
      .eq('id', id);
    if (error) {
      console.error('[toggleColorActiveAction] update falló:', error);
      return { ok: false, message: error.message };
    }
    revalidatePath('/admin/catalogs');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido';
    console.error('[toggleColorActiveAction] excepción no controlada:', err);
    return { ok: false, message };
  }
}
