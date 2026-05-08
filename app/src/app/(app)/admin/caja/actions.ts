'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  ValidateTransferSchema,
  type ValidateTransferState,
} from './schema';

// NB: 'use server' file — solo async functions.

/**
 * `validarEfectivoAction` — el admin confirma que el contador le entregó
 * físicamente el efectivo. Marca el cash_transfer como 'validado',
 * anota el admin que validó y el timestamp.
 *
 * Sólo aplica sobre transfers con `status='recibido'`. Si el transfer
 * ya está validado, devolvemos error explícito (idempotencia visible).
 *
 * No emitimos notif tras la validación — el flujo termina aquí y el
 * contador/chofer ya recibieron las notifs anteriores. Si en el futuro
 * quieres cerrar el ciclo con una notif al contador, agrégala aquí
 * con type 'efectivo_validado'.
 */
export async function validarEfectivoAction(
  _prev: ValidateTransferState,
  formData: FormData,
): Promise<ValidateTransferState> {
  try {
    const parsed = ValidateTransferSchema.safeParse({
      transfer_id: formData.get('transfer_id'),
    });
    if (!parsed.success) {
      return { status: 'error', message: 'Datos inválidos' };
    }

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

    // Verificar que el transfer existe y está en estado 'recibido'.
    const { data: tf, error: tErr } = await admin
      .from('cash_transfers')
      .select('id, status')
      .eq('id', parsed.data.transfer_id)
      .maybeSingle();
    if (tErr) {
      return {
        status: 'error',
        message: `No se pudo leer la transferencia: ${tErr.message}`,
      };
    }
    if (!tf) {
      return { status: 'error', message: 'Transferencia no encontrada.' };
    }
    if (tf.status === 'validado') {
      return { status: 'error', message: 'Esta transferencia ya está validada.' };
    }
    if (tf.status !== 'recibido') {
      return {
        status: 'error',
        message: `No se puede validar un transfer en estado "${tf.status}".`,
      };
    }

    const { error: updErr } = await admin
      .from('cash_transfers')
      .update({
        status: 'validado',
        admin_validated_at: new Date().toISOString(),
        admin_id: user.id,
      })
      .eq('id', parsed.data.transfer_id);
    if (updErr) {
      console.error('[validarEfectivoAction] update falló:', updErr);
      return {
        status: 'error',
        message: `No se pudo validar: ${updErr.message}`,
      };
    }

    revalidatePath('/admin/caja');
    return { status: 'success' };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al validar';
    console.error('[validarEfectivoAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}
