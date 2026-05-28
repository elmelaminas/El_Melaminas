'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  ReceiveAdminCashSchema,
  ReceiveIndividualCashSchema,
  type ReceiveAdminCashState,
  type ReceiveIndividualCashState,
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

    // Defense-in-depth: contador, admin2 o admin pueden validar caja.
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
      callerProfile?.role !== 'admin2' &&
      callerProfile?.role !== 'admin'
    ) {
      return {
        status: 'error',
        message: 'Solo contador, admin o admin2 pueden validar caja del admin.',
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

/**
 * `receiveIndividualCashAction(payment_id, pin)` — el contador valida
 * UN cobro en efectivo específico (granularidad por cliente, no por
 * admin como `receiveAdminCashAction`).
 *
 * Flujo:
 *   1. Auth + role contador/admin2.
 *   2. Comparar `pin` contra `profiles.confirmation_pin` del caller.
 *      Si el contador no tiene PIN configurado, retornamos error
 *      con reason='pin_missing' para que la UI muestre el mensaje
 *      "Contacta al administrador".
 *   3. Buscar el ingreso original en `admin_cash_register` por
 *      payment_id. Si no existe o no es `source='pago_efectivo'`,
 *      error.
 *   4. Verificar idempotencia: si ya existe un egreso
 *      `source='validado_contador'` para ese payment_id, regresar
 *      reason='already_validated' (no insertamos doble).
 *   5. INSERT egreso vinculado a `payment_id`.
 *   6. Notif al admin con monto + nombre del cliente.
 *   7. revalidatePath('/contador').
 *
 * Política PIN: comparación string directa (sin hash). Mejora futura
 * pendiente — el spec así lo indica explícitamente.
 */
export async function receiveIndividualCashAction(
  paymentId: string,
  pin: string,
): Promise<ReceiveIndividualCashState> {
  try {
    const parsed = ReceiveIndividualCashSchema.safeParse({
      payment_id: paymentId,
      pin,
    });
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      const first =
        flat.pin?.[0] ?? flat.payment_id?.[0] ?? 'Datos inválidos.';
      return { status: 'error', message: first, reason: 'other' };
    }
    const { payment_id, pin: providedPin } = parsed.data;

    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      return {
        status: 'error',
        message: 'Sesión no válida. Vuelve a iniciar sesión.',
        reason: 'other',
      };
    }
    const contadorId = user.id;

    const admin = supabaseAdmin();

    // Cargar perfil + PIN del caller. Defense-in-depth role check
    // + obtener PIN almacenado en la misma query (single round-trip).
    const { data: callerProfile, error: callerErr } = await admin
      .from('profiles')
      .select('role, confirmation_pin')
      .eq('id', contadorId)
      .maybeSingle();
    if (callerErr) {
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${callerErr.message}`,
        reason: 'other',
      };
    }
    if (
      callerProfile?.role !== 'contador' &&
      callerProfile?.role !== 'admin2' &&
      callerProfile?.role !== 'admin'
    ) {
      return {
        status: 'error',
        message: 'Solo contador, admin o admin2 pueden validar cobros.',
        reason: 'other',
      };
    }
    const storedPin =
      typeof callerProfile.confirmation_pin === 'string'
        ? callerProfile.confirmation_pin.trim()
        : '';
    if (storedPin === '') {
      return {
        status: 'error',
        message:
          'No tienes PIN configurado. Contacta al administrador para que te lo asigne.',
        reason: 'pin_missing',
      };
    }
    if (storedPin !== providedPin) {
      return {
        status: 'error',
        message: 'PIN incorrecto. Intenta de nuevo.',
        reason: 'pin_incorrect',
      };
    }

    // Buscar el ingreso original. Esperamos UN ingreso por payment_id
    // (el flujo del admin lo registra una vez). Si hay duplicados por
    // alguna razón histórica, tomamos el más reciente.
    const { data: ingresoRows, error: ingErr } = await admin
      .from('admin_cash_register')
      .select('id, admin_id, amount, created_at, payment_id')
      .eq('payment_id', payment_id)
      .eq('operation_type', 'ingreso')
      .eq('source', 'pago_efectivo')
      .order('created_at', { ascending: false })
      .limit(1);
    if (ingErr) {
      return {
        status: 'error',
        message: `No se pudo leer el cobro: ${ingErr.message}`,
        reason: 'other',
      };
    }
    const ingreso = ingresoRows?.[0];
    if (!ingreso) {
      return {
        status: 'error',
        message: 'No se encontró el cobro en efectivo asociado a este pago.',
        reason: 'other',
      };
    }
    const amount = Number(ingreso.amount ?? 0);
    const targetAdminId = ingreso.admin_id as string | null;

    // Idempotencia: si ya hay un egreso con source='validado_contador'
    // para este payment_id, no insertamos otro.
    const { data: priorEgreso } = await admin
      .from('admin_cash_register')
      .select('id')
      .eq('payment_id', payment_id)
      .eq('operation_type', 'egreso')
      .eq('source', 'validado_contador')
      .limit(1);
    if (priorEgreso && priorEgreso.length > 0) {
      return {
        status: 'error',
        message: 'Este cobro ya fue validado anteriormente.',
        reason: 'already_validated',
      };
    }

    // INSERT egreso por exactamente el monto del ingreso original.
    // `payment_id` es la llave que une los dos movimientos.
    const { error: insErr } = await admin
      .from('admin_cash_register')
      .insert({
        admin_id: targetAdminId,
        amount,
        operation_type: 'egreso',
        source: 'validado_contador',
        payment_id,
        registered_by: contadorId,
      });
    if (insErr) {
      console.error(
        '[receiveIndividualCashAction] insert egreso falló:',
        insErr,
      );
      return {
        status: 'error',
        message: `No se pudo registrar la validación: ${insErr.message}`,
        reason: 'other',
      };
    }

    // Notif al admin (non-fatal). Resolvemos client_name vía payment →
    // lead. Si alguno falla caemos a "un cliente" — la notif sigue.
    try {
      let clientName = 'un cliente';
      const { data: payRow } = await admin
        .from('payments')
        .select('lead_id')
        .eq('id', payment_id)
        .maybeSingle();
      const leadId = payRow?.lead_id ?? null;
      if (leadId) {
        const { data: leadRow } = await admin
          .from('leads')
          .select('client_name')
          .eq('id', leadId)
          .maybeSingle();
        if (leadRow?.client_name) clientName = leadRow.client_name;
      }
      if (targetAdminId) {
        const amountFmt = new Intl.NumberFormat('es-MX', {
          style: 'currency',
          currency: 'MXN',
          minimumFractionDigits: 0,
        }).format(amount);
        const { error: notifErr } = await admin
          .from('notifications')
          .insert({
            recipient_id: targetAdminId,
            type: 'efectivo_validado_contador',
            message: `✅ El contador validó ${amountFmt} de ${clientName}`,
          });
        if (notifErr) {
          console.error(
            '[receiveIndividualCashAction] notif falló (no fatal):',
            notifErr,
          );
        }
      }
    } catch (e) {
      console.error(
        '[receiveIndividualCashAction] notif excepción (no fatal):',
        e,
      );
    }

    revalidatePath('/contador');
    revalidatePath('/admin/caja');
    revalidatePath('/dashboard');
    return { status: 'success', received: amount };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al validar cobro individual';
    console.error(
      '[receiveIndividualCashAction] excepción no controlada:',
      err,
    );
    return { status: 'error', message, reason: 'other' };
  }
}
