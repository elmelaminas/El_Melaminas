'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { LeadEditSchema, type LeadEditState } from './schema';

// NB: 'use server' file — solo async functions. Schemas/types en ./schema.

/**
 * `updateLeadAction(leadId, _prev, formData)` — admin edita fecha y chofer
 * de un lead. Defensa en profundidad triple:
 *   1. middleware bloquea la ruta a no-admin.
 *   2. el page.tsx valida role antes de renderizar el form.
 *   3. esta action vuelve a chequear el role y rechaza si no es admin.
 *
 * El lead_id se pasa como argumento separado (no por FormData) para que
 * la signature deje claro a futuro lectores que es parte del contrato
 * y no un dato del cliente. El cliente lo bindea con `.bind(null, id)`.
 */
export async function updateLeadAction(
  leadId: string,
  _prev: LeadEditState,
  formData: FormData,
): Promise<LeadEditState> {
  try {
    if (typeof leadId !== 'string' || leadId.length === 0) {
      return { status: 'error', message: 'ID de lead inválido.' };
    }

    // Auth + role check.
    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      return { status: 'error', message: 'Sesión no válida. Vuelve a iniciar sesión.' };
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
    if (profile?.role !== 'admin') {
      return {
        status: 'error',
        message: 'Solo un administrador puede editar leads.',
      };
    }

    // Validación con Zod.
    const parsed = LeadEditSchema.safeParse({
      sale_date: formData.get('sale_date'),
      driver_id: formData.get('driver_id'),
    });
    if (!parsed.success) {
      console.error('[updateLeadAction] validación falló:', parsed.error.flatten());
      return {
        status: 'error',
        message: 'Datos inválidos',
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      };
    }

    const { sale_date, driver_id } = parsed.data;
    const driverIdToSet =
      driver_id && driver_id.length > 0 ? driver_id : null;

    const { error: updErr } = await admin
      .from('leads')
      .update({ sale_date, driver_id: driverIdToSet })
      .eq('id', leadId);
    if (updErr) {
      console.error('[updateLeadAction] update falló:', updErr);
      return {
        status: 'error',
        message: `No se pudo actualizar: ${updErr.message}`,
      };
    }

    // Refrescar las vistas que muestran este lead. /admin/entregas y
    // /leads son las dos pantallas que listan; /driver no se invalida
    // porque solo refleja sus propias entregas y el chofer ve cambios
    // en el siguiente refresh natural.
    revalidatePath('/leads');
    revalidatePath('/admin/entregas');
    return { status: 'success' };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al actualizar lead';
    console.error('[updateLeadAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}
