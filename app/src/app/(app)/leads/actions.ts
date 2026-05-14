'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  UpdateLeadColorSchema,
  type UpdateLeadColorState,
} from './schema';

// NB: 'use server' file — solo async functions. Tipos y schemas viven
// en `./schema.ts`.

/**
 * `updateLeadColorAction(_prev, formData)` — el admin asigna (o limpia)
 * el override manual de color de fila para un lead desde el selector
 * inline en /leads o /admin/entregas.
 *
 * Triple defensa de admin:
 *   1. middleware ya bloquea /admin/* a no-admins (pero /leads NO está
 *      bajo /admin — cualquier usuario logueado puede entrar).
 *   2. page-level: /leads no chequea rol porque vendedores también lo
 *      ven (solo lectura).
 *   3. ACTION-level: ACÁ es donde se valida que el caller sea admin.
 *      Sin esto, un vendedor con DevTools podría disparar la action
 *      y cambiar colores ajenos.
 *
 * Si 'sin_color' llega, el UPDATE escribe la string 'sin_color' (que
 * pasa el CHECK constraint). En `getLeadRowColor` ese valor se trata
 * como "no override" y volvemos a las reglas automáticas.
 */
export async function updateLeadColorAction(
  _prev: UpdateLeadColorState,
  formData: FormData,
): Promise<UpdateLeadColorState> {
  try {
    const parsed = UpdateLeadColorSchema.safeParse({
      lead_id: formData.get('lead_id'),
      row_color: formData.get('row_color'),
    });
    if (!parsed.success) {
      const fe = parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >;
      const first =
        fe.row_color?.[0] ?? fe.lead_id?.[0] ?? 'Datos inválidos.';
      return { status: 'error', message: first };
    }
    const { lead_id, row_color } = parsed.data;

    // ── Auth + role admin
    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      return { status: 'error', message: 'Sesión no válida.' };
    }

    const admin = supabaseAdmin();

    const { data: profile, error: profileErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if (profileErr) {
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${profileErr.message}`,
      };
    }
    if (profile?.role !== 'admin' && profile?.role !== 'admin2') {
      return {
        status: 'error',
        message: 'Solo un administrador puede cambiar el color de fila.',
      };
    }

    // ── UPDATE leads.row_color. El CHECK constraint de la migración
    //    rechaza valores fuera de la lista — UpdateLeadColorSchema
    //    valida lo mismo en cliente para que el round-trip no falle
    //    por validación de DB.
    const { error: updErr } = await admin
      .from('leads')
      .update({ row_color })
      .eq('id', lead_id);
    if (updErr) {
      console.error('[updateLeadColorAction] update falló:', updErr);
      return {
        status: 'error',
        message: `No se pudo actualizar el color: ${updErr.message}`,
      };
    }

    // Ambas vistas reflejan colores de fila — invalidamos las dos.
    revalidatePath('/leads');
    revalidatePath('/admin/entregas');
    return { status: 'success' };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al actualizar color';
    console.error('[updateLeadColorAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}
