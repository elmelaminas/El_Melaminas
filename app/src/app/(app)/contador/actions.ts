'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  ReceiveAdminCashSchema,
  type ReceiveAdminCashState,
} from './schema';

// NB: 'use server' file — solo async functions.

/**
 * `receiveAdminCashAction` — el contador valida (recibe) el efectivo
 * acumulado en la caja personal de un admin.
 *
 * Refactor (2026-05): este es el único punto de cobro del contador
 * en el nuevo flujo. Antes existía también `recibirEfectivoAction`
 * para recibir del chofer; ese rol pasó al admin
 * (`adminReceivesDriverCashAction` en /admin/caja).
 *
 * Diseño contra race conditions: NO confiamos en el monto del cliente.
 * Calculamos el saldo del admin FRESCO en el servidor (sum ingresos −
 * sum egresos) y registramos UN egreso por exactamente ese saldo. Si
 * entre el SELECT y el INSERT el chofer entrega más efectivo al admin,
 * ese ingreso queda para la siguiente recepción.
 *
 * INSERT en `admin_cash_register`:
 *   admin_id:       el admin del que se recibe
 *   amount:         saldo recalculado server-side
 *   operation_type: 'egreso'
 *   source:         'validado_contador'
 *   registered_by:  el contador (auth.uid())
 *
 * Notif al admin (`type='efectivo_validado_contador'`) tras el insert.
 * Errores de notif son non-fatal.
 *
 * Acceso: solo rol contador (o admin2 que mantiene acceso a /contador
 * como herramienta secundaria). El middleware ya filtra la ruta; este
 * check es defensa en profundidad.
 */
export async function receiveAdminCashAction(
  _prev: ReceiveAdminCashState,
  formData: FormData,
): Promise<ReceiveAdminCashState> {
  try {
    const parsed = ReceiveAdminCashSchema.safeParse({
      admin_id: formData.get('admin_id'),
    });
    if (!parsed.success) {
      return { status: 'error', message: 'admin_id inválido.' };
    }
    const { admin_id: targetAdminId } = parsed.data;

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
    const contadorId = user.id;

    const admin = supabaseAdmin();

    // Defense-in-depth: solo contador o admin2 puede validar.
    const { data: callerProfile, error: callerErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', contadorId)
      .maybeSingle();
    if (callerErr) {
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${callerErr.message}`,
      };
    }
    if (
      callerProfile?.role !== 'contador' &&
      callerProfile?.role !== 'admin2'
    ) {
      return {
        status: 'error',
        message: 'Solo el contador (o admin2) puede validar caja del admin.',
      };
    }

    // Saldo fresco: sum(ingresos) − sum(egresos) sobre TODA la historia.
    const { data: balanceRows, error: balErr } = await admin
      .from('admin_cash_register')
      .select('amount, operation_type')
      .eq('admin_id', targetAdminId);
    if (balErr) {
      return {
        status: 'error',
        message: `No se pudo leer la caja del admin: ${balErr.message}`,
      };
    }
    const balance = (balanceRows ?? []).reduce((s, r) => {
      const amt = Number(r.amount ?? 0);
      return r.operation_type === 'ingreso' ? s + amt : s - amt;
    }, 0);

    if (balance <= 0) {
      return {
        status: 'error',
        message: 'Ese admin no tiene efectivo pendiente.',
      };
    }

    const { error: insErr } = await admin
      .from('admin_cash_register')
      .insert({
        admin_id: targetAdminId,
        amount: balance,
        operation_type: 'egreso',
        source: 'validado_contador',
        registered_by: contadorId,
      });
    if (insErr) {
      console.error('[receiveAdminCashAction] insert egreso falló:', insErr);
      return {
        status: 'error',
        message: `No se pudo registrar la recepción: ${insErr.message}`,
      };
    }

    // Notif al admin (non-fatal).
    try {
      const amountFmt = new Intl.NumberFormat('es-MX', {
        style: 'currency',
        currency: 'MXN',
        minimumFractionDigits: 0,
      }).format(balance);
      const { error: notifErr } = await admin.from('notifications').insert({
        recipient_id: targetAdminId,
        type: 'efectivo_validado_contador',
        message: `El contador validó ${amountFmt} de tu caja de efectivo`,
      });
      if (notifErr) {
        console.error(
          '[receiveAdminCashAction] notif falló (no fatal):',
          notifErr,
        );
      }
    } catch (e) {
      console.error(
        '[receiveAdminCashAction] notif excepción (no fatal):',
        e,
      );
    }

    revalidatePath('/contador');
    revalidatePath('/admin/caja');
    revalidatePath('/dashboard');
    return { status: 'success', received: balance };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al recibir efectivo del admin';
    console.error('[receiveAdminCashAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}
