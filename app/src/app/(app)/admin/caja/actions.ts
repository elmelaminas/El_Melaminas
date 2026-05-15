'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  ReceiveDriverCashSchema,
  type ReceiveDriverCashState,
} from './schema';

// NB: 'use server' file — solo async functions.

/**
 * `adminReceivesDriverCashAction` — el ADMIN (o admin2) recibe el
 * efectivo que un chofer trae de una entrega.
 *
 * Refactor (2026-05): este flujo antes lo hacía el contador
 * (`recibirEfectivoAction`). Ahora el admin lo recibe directamente y
 * el contador valida después la caja del admin (egreso en
 * `admin_cash_register`).
 *
 * Efectos:
 *   1. UPDATE cash_transfers SET status='recibido', contador_id=auth.uid()
 *      (reusamos la columna `contador_id` para guardar el id del admin
 *      que recibió; renombrarla a `received_by_id` sería más fiel pero
 *      requiere migración y no aporta funcionalidad).
 *   2. INSERT admin_cash_register {
 *        admin_id: auth.uid(),
 *        amount: transfer.amount,
 *        operation_type: 'ingreso',
 *        source: 'chofer',
 *        cash_transfer_id: transfer_id
 *      }
 *      Esto suma el efectivo a la caja personal del admin para que el
 *      contador lo vea pendiente de validar.
 *   3. Notif a contadores activos ('efectivo_chofer_recibido') — para
 *      que sepan que la caja del admin acaba de subir.
 *
 * Defensa: solo admin/admin2 pueden ejecutarla. El middleware ya
 * restringe /admin/caja a admin+admin2+contador; añadimos role-check
 * acá para que un contador con la URL directa no pueda llamarla.
 *
 * Política de errores: si paso 1 falla → abortamos. Si paso 2 falla,
 * revertimos paso 1. Si la notif (paso 3) falla, loguamos pero no
 * revertimos — el evento financiero ya quedó consistente.
 */
export async function adminReceivesDriverCashAction(
  _prev: ReceiveDriverCashState,
  formData: FormData,
): Promise<ReceiveDriverCashState> {
  try {
    const parsed = ReceiveDriverCashSchema.safeParse({
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
    const adminId = user.id;

    const admin = supabaseAdmin();

    // Defense-in-depth: solo admin o admin2 reciben de choferes.
    const { data: caller, error: callerErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', adminId)
      .maybeSingle();
    if (callerErr) {
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${callerErr.message}`,
      };
    }
    if (caller?.role !== 'admin' && caller?.role !== 'admin2') {
      return {
        status: 'error',
        message: 'Solo un administrador puede recibir efectivo del chofer.',
      };
    }

    // Snapshot del transfer (necesitamos amount + driver_id para el
    // ingreso a admin_cash_register y para el mensaje de la notif).
    const { data: tf, error: tErr } = await admin
      .from('cash_transfers')
      .select('id, status, amount, driver_id')
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
    if (tf.status !== 'pendiente') {
      return {
        status: 'error',
        message: `Esta transferencia ya está en estado "${tf.status}".`,
      };
    }

    const amount = Number(tf.amount ?? 0);

    // Paso 1: marcar el cash_transfer como recibido por el admin.
    const { error: updErr } = await admin
      .from('cash_transfers')
      .update({
        status: 'recibido',
        contador_id: adminId,
      })
      .eq('id', tf.id)
      .eq('status', 'pendiente'); // optimistic concurrency: solo si sigue pendiente
    if (updErr) {
      return {
        status: 'error',
        message: `No se pudo marcar la transferencia: ${updErr.message}`,
      };
    }

    // Paso 2: INSERT ingreso en admin_cash_register. Si falla,
    // revertimos el UPDATE para mantener consistencia (mejor que el
    // admin "perdió" el efectivo en su caja).
    const { error: cashErr } = await admin
      .from('admin_cash_register')
      .insert({
        admin_id: adminId,
        amount,
        operation_type: 'ingreso',
        source: 'chofer',
        cash_transfer_id: tf.id,
        registered_by: adminId,
      });
    if (cashErr) {
      console.error(
        '[adminReceivesDriverCashAction] admin_cash_register insert falló:',
        cashErr,
      );
      // Rollback del status del transfer.
      const { error: revErr } = await admin
        .from('cash_transfers')
        .update({ status: 'pendiente', contador_id: null })
        .eq('id', tf.id);
      if (revErr) {
        console.error(
          '[adminReceivesDriverCashAction] rollback status falló (no fatal):',
          revErr,
        );
      }
      return {
        status: 'error',
        message: `No se pudo registrar en tu caja: ${cashErr.message}`,
      };
    }

    // Paso 3 (non-fatal): notif a contadores activos. El admin se
    // siente avisado por la UI; los contadores quieren saber que hay
    // efectivo en la caja del admin pendiente de validar.
    try {
      const { data: adminProfile } = await admin
        .from('profiles')
        .select('full_name')
        .eq('id', adminId)
        .maybeSingle();
      const { data: driverProfile } = tf.driver_id
        ? await admin
            .from('profiles')
            .select('full_name')
            .eq('id', tf.driver_id)
            .maybeSingle()
        : { data: null };
      const driverName = driverProfile?.full_name ?? 'Chofer';
      const adminName = adminProfile?.full_name ?? 'Admin';

      const { data: contadores } = await admin
        .from('profiles')
        .select('id')
        .eq('role', 'contador')
        .eq('is_active', true);
      if (contadores && contadores.length > 0) {
        const amountFmt = new Intl.NumberFormat('es-MX', {
          style: 'currency',
          currency: 'MXN',
          minimumFractionDigits: 0,
        }).format(amount);
        const message = `${adminName} recibió ${amountFmt} del chofer ${driverName}`;
        const inserts = contadores.map((c) => ({
          recipient_id: c.id,
          type: 'efectivo_chofer_recibido',
          message,
        }));
        const { error: notifErr } = await admin
          .from('notifications')
          .insert(inserts);
        if (notifErr) {
          console.error(
            '[adminReceivesDriverCashAction] notif insert falló (no fatal):',
            notifErr,
          );
        }
      }
    } catch (e) {
      console.error(
        '[adminReceivesDriverCashAction] notif excepción (no fatal):',
        e,
      );
    }

    revalidatePath('/admin/caja');
    revalidatePath('/contador');
    revalidatePath('/dashboard');
    revalidatePath('/driver'); // banner del chofer baja a 0
    return { status: 'success', received: amount };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al recibir efectivo';
    console.error(
      '[adminReceivesDriverCashAction] excepción no controlada:',
      err,
    );
    return { status: 'error', message };
  }
}
