'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  ReceiveAdminCashSchema,
  ReceiveIndividualCashSchema,
  ReceiveFromContadorSchema,
  ReceiveIndividualFromContadorSchema,
  ReceiveBulkFromContadorSchema,
  BulkReceiveCashContadorSchema,
  AdminReceiveDirectOrContadorBulkSchema,
  type ReceiveAdminCashState,
  type ReceiveIndividualCashState,
  type ReceiveFromContadorState,
  type ReceiveIndividualFromContadorState,
  type ReceiveBulkFromContadorState,
  type BulkReceiveCashContadorState,
  type AdminReceiveDirectOrContadorBulkState,
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

/**
 * `receiveFromContadorAction(contador_id, amount, pin)` — un admin
 * recibe efectivo físico que el contador acumuló en su caja (sumas
 * de validaciones previas). Inserta una fila en
 * `contador_to_admin_transfers` + una INGRESO en `admin_cash_register`
 * con `source='recibido_contador'`.
 *
 * Nota sobre el `source`: la spec original sugirió 'validado_contador'
 * pero ese valor ya significa "el contador validó la caja del admin"
 * cuando aparece como EGRESO. Usar la misma string para una INGRESO
 * confundiría el label de /admin/mi-caja (`sourceLabel` mapea esa
 * string a "Entregado al contador"). Usamos un valor distinto
 * (`recibido_contador`) para preservar la semántica unidireccional.
 *
 * Política contra race conditions: el balance del contador se
 * recalcula server-side justo antes del INSERT. Si entre el cliente
 * pide $X y la action corre el contador hizo más validaciones (subió
 * su saldo) o ya transfirió (bajó su saldo), validamos al instante.
 *
 * Acceso: solo rol 'admin' (no admin2 ni contador). El PIN va contra
 * `profiles.confirmation_pin` del admin que ejecuta la acción.
 */
export async function receiveFromContadorAction(
  contadorIdInput: string,
  amountInput: number,
  pinInput: string,
): Promise<ReceiveFromContadorState> {
  try {
    const parsed = ReceiveFromContadorSchema.safeParse({
      contador_id: contadorIdInput,
      amount: amountInput,
      pin: pinInput,
    });
    if (!parsed.success) {
      return {
        status: 'error',
        message:
          parsed.error.flatten().formErrors.join(' ') ||
          'Datos inválidos para recibir efectivo.',
        reason: 'other',
      };
    }
    const { contador_id: contadorId, amount, pin: providedPin } = parsed.data;

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
    const adminId = user.id;

    const admin = supabaseAdmin();

    // Defense-in-depth: solo rol 'admin' (no admin2 ni contador). El PIN
    // se valida contra el perfil del admin que ejecuta.
    const { data: callerProfile, error: callerErr } = await admin
      .from('profiles')
      .select('role, confirmation_pin, full_name')
      .eq('id', adminId)
      .maybeSingle();
    if (callerErr) {
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${callerErr.message}`,
        reason: 'other',
      };
    }
    if (
      callerProfile?.role !== 'admin' &&
      callerProfile?.role !== 'admin2'
    ) {
      return {
        status: 'error',
        message:
          'Solo un administrador (admin o admin2) puede recibir efectivo del contador.',
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

    // Balance del contador = SUM(egresos source='validado_contador'
    // registered_by=contadorId) - SUM(transferencias previas). Dos
    // queries paralelas; el server-side recalc evita over-spending.
    const [validatedRes, transfersRes] = await Promise.all([
      admin
        .from('admin_cash_register')
        .select('amount')
        .eq('operation_type', 'egreso')
        .eq('source', 'validado_contador')
        .eq('registered_by', contadorId),
      admin
        .from('contador_to_admin_transfers')
        .select('amount')
        .eq('contador_id', contadorId),
    ]);
    if (validatedRes.error) {
      return {
        status: 'error',
        message: `No se pudo leer el saldo del contador: ${validatedRes.error.message}`,
        reason: 'other',
      };
    }
    if (transfersRes.error) {
      return {
        status: 'error',
        message: `No se pudo leer las transferencias previas: ${transfersRes.error.message}`,
        reason: 'other',
      };
    }
    const validated = (validatedRes.data ?? []).reduce(
      (s, r) => s + Number(r.amount ?? 0),
      0,
    );
    const transferred = (transfersRes.data ?? []).reduce(
      (s, r) => s + Number(r.amount ?? 0),
      0,
    );
    const availableBalance = Math.max(0, validated - transferred);
    if (amount > availableBalance) {
      const fmt = new Intl.NumberFormat('es-MX', {
        style: 'currency',
        currency: 'MXN',
        minimumFractionDigits: 0,
      });
      return {
        status: 'error',
        message: `El contador solo tiene ${fmt.format(
          availableBalance,
        )} disponibles.`,
        reason: 'insufficient_balance',
      };
    }

    // Lookup nombre del contador (para notas + notifs).
    let contadorName = 'Contador';
    try {
      const { data: cp } = await admin
        .from('profiles')
        .select('full_name')
        .eq('id', contadorId)
        .maybeSingle();
      if (cp?.full_name) contadorName = cp.full_name;
    } catch {
      // Best-effort: el flujo no depende de esto.
    }
    const adminName = callerProfile.full_name ?? 'Administrador';
    const notes = `Recibido del contador ${contadorName}`;

    // INSERT en contador_to_admin_transfers — fuente de verdad del
    // flujo. Si falla acá, abortamos sin tocar admin_cash_register.
    const { data: transferRow, error: transferErr } = await admin
      .from('contador_to_admin_transfers')
      .insert({
        contador_id: contadorId,
        admin_id: adminId,
        amount,
        pin_validated: true,
        validated_at: new Date().toISOString(),
        notes,
      })
      .select('id')
      .single();
    if (transferErr || !transferRow) {
      console.error(
        '[receiveFromContadorAction] insert transfer falló:',
        transferErr,
      );
      return {
        status: 'error',
        message: `No se pudo registrar la transferencia: ${
          transferErr?.message ?? 'sin datos'
        }`,
        reason: 'other',
      };
    }
    const transferId: string = transferRow.id;

    // INSERT INGRESO en admin_cash_register para la caja del admin.
    // Si falla, rollback de la transferencia recién creada.
    const { error: cashErr } = await admin
      .from('admin_cash_register')
      .insert({
        admin_id: adminId,
        amount,
        operation_type: 'ingreso',
        source: 'recibido_contador',
        registered_by: adminId,
        notes,
      });
    if (cashErr) {
      console.error(
        '[receiveFromContadorAction] insert ingreso admin_cash_register falló:',
        cashErr,
      );
      // Rollback de la transferencia para no dejar saldo "fantasma".
      try {
        await admin
          .from('contador_to_admin_transfers')
          .delete()
          .eq('id', transferId);
      } catch (rollbackErr) {
        console.error(
          '[receiveFromContadorAction] rollback transfer falló:',
          rollbackErr,
        );
      }
      return {
        status: 'error',
        message: `No se pudo registrar en tu caja: ${cashErr.message}`,
        reason: 'other',
      };
    }

    // Notif al contador (non-fatal).
    try {
      const amountFmt = new Intl.NumberFormat('es-MX', {
        style: 'currency',
        currency: 'MXN',
        minimumFractionDigits: 0,
      }).format(amount);
      const { error: notifContErr } = await admin
        .from('notifications')
        .insert({
          recipient_id: contadorId,
          type: 'efectivo_transferido_admin',
          message: `✅ El admin ${adminName} recibió ${amountFmt} de tu caja.`,
        });
      if (notifContErr) {
        console.error(
          '[receiveFromContadorAction] notif contador falló (no fatal):',
          notifContErr,
        );
      }
    } catch (e) {
      console.error(
        '[receiveFromContadorAction] notif contador excepción (no fatal):',
        e,
      );
    }

    // Notif a todos los admins (broadcast, non-fatal).
    try {
      const { data: admins } = await admin
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .eq('is_active', true);
      if (admins && admins.length > 0) {
        const amountFmt = new Intl.NumberFormat('es-MX', {
          style: 'currency',
          currency: 'MXN',
          minimumFractionDigits: 0,
        }).format(amount);
        const inserts = admins.map((a) => ({
          recipient_id: a.id,
          type: 'efectivo_recibido_contador',
          message: `💰 ${adminName} recibió ${amountFmt} del contador ${contadorName}.`,
        }));
        const { error: notifAdminErr } = await admin
          .from('notifications')
          .insert(inserts);
        if (notifAdminErr) {
          console.error(
            '[receiveFromContadorAction] notif admins falló (no fatal):',
            notifAdminErr,
          );
        }
      }
    } catch (e) {
      console.error(
        '[receiveFromContadorAction] notif admins excepción (no fatal):',
        e,
      );
    }

    revalidatePath('/contador');
    revalidatePath('/admin/mi-caja');
    revalidatePath('/admin/caja');
    revalidatePath('/dashboard');
    return { status: 'success', received: amount };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al recibir efectivo del contador';
    console.error(
      '[receiveFromContadorAction] excepción no controlada:',
      err,
    );
    return { status: 'error', message, reason: 'other' };
  }
}

/**
 * `receiveIndividualFromContadorAction(payment_id, pin)` — un admin
 * recibe del contador UN cobro específico (a nivel cliente). Es la
 * versión por-fila de `receiveFromContadorAction`: en lugar de
 * agarrar todo el saldo del contador, el admin valida pago por pago
 * desde la tabla "Cobros en efectivo registrados".
 *
 * Flujo (cadena del efectivo):
 *   driver → admin (pago_efectivo)        ← step 1 (ya hecho)
 *   admin  → contador (validado_contador) ← step 2 (contador valida)
 *   contador → admin (recibido_contador)  ← step 3 (este action)
 *
 * Pre-condiciones obligatorias:
 *   - Existe egreso `validado_contador` con el mismo payment_id (el
 *     contador ya validó; el dinero está en su caja).
 *   - NO existe ya un ingreso `recibido_contador` con ese payment_id
 *     (idempotencia: cada fila se recibe una vez).
 *
 * Side effects:
 *   - INSERT admin_cash_register {ingreso, source='recibido_contador'}
 *     en la caja del admin que recibe.
 *   - INSERT contador_to_admin_transfers para que el balance del
 *     contador se decremente correctamente en /contador.
 *   - Notif al contador.
 *
 * Acceso: admin o admin2. PIN se valida contra
 * `profiles.confirmation_pin` del que ejecuta.
 */
export async function receiveIndividualFromContadorAction(
  paymentIdInput: string,
  pinInput: string,
): Promise<ReceiveIndividualFromContadorState> {
  try {
    const parsed = ReceiveIndividualFromContadorSchema.safeParse({
      payment_id: paymentIdInput,
      pin: pinInput,
    });
    if (!parsed.success) {
      return {
        status: 'error',
        message:
          parsed.error.flatten().formErrors.join(' ') ||
          'Datos inválidos para recibir el cobro.',
        reason: 'other',
      };
    }
    const { payment_id: paymentId, pin: providedPin } = parsed.data;

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
    const adminId = user.id;

    const admin = supabaseAdmin();

    // Role + PIN check del admin.
    const { data: callerProfile, error: callerErr } = await admin
      .from('profiles')
      .select('role, confirmation_pin, full_name')
      .eq('id', adminId)
      .maybeSingle();
    if (callerErr) {
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${callerErr.message}`,
        reason: 'other',
      };
    }
    if (
      callerProfile?.role !== 'admin' &&
      callerProfile?.role !== 'admin2'
    ) {
      return {
        status: 'error',
        message:
          'Solo un administrador (admin o admin2) puede recibir cobros del contador.',
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

    // Buscar el egreso 'validado_contador' que corresponde a este
    // payment_id. Si no existe, el contador aún no ha validado y el
    // admin no puede recibir (el dinero sigue físicamente en manos del
    // admin original). Tomamos el más reciente por defecto.
    const { data: egresoRows, error: egresoErr } = await admin
      .from('admin_cash_register')
      .select('id, amount, registered_by')
      .eq('payment_id', paymentId)
      .eq('operation_type', 'egreso')
      .eq('source', 'validado_contador')
      .order('created_at', { ascending: false })
      .limit(1);
    if (egresoErr) {
      return {
        status: 'error',
        message: `No se pudo leer el cobro: ${egresoErr.message}`,
        reason: 'other',
      };
    }
    const egreso = egresoRows?.[0];
    if (!egreso) {
      return {
        status: 'error',
        message:
          'El contador aún no ha validado este cobro. Pídele que lo valide antes de recibirlo.',
        reason: 'not_validated',
      };
    }
    const contadorId =
      typeof egreso.registered_by === 'string' ? egreso.registered_by : null;
    const amount = Number(egreso.amount ?? 0);

    // Idempotencia: si ya hay un ingreso 'recibido_contador' para este
    // payment_id, no creamos otro (sea quien sea el receptor).
    const { data: priorIngreso } = await admin
      .from('admin_cash_register')
      .select('id')
      .eq('payment_id', paymentId)
      .eq('operation_type', 'ingreso')
      .eq('source', 'recibido_contador')
      .limit(1);
    if (priorIngreso && priorIngreso.length > 0) {
      return {
        status: 'error',
        message: 'Este cobro ya fue recibido por un admin anteriormente.',
        reason: 'already_received',
      };
    }

    // Resolver nombres para notas/notifs. Best-effort.
    let contadorName = 'Contador';
    let clientName = '(sin cliente)';
    try {
      if (contadorId) {
        const { data: cp } = await admin
          .from('profiles')
          .select('full_name')
          .eq('id', contadorId)
          .maybeSingle();
        if (cp?.full_name) contadorName = cp.full_name;
      }
      const { data: pmt } = await admin
        .from('payments')
        .select('lead_id')
        .eq('id', paymentId)
        .maybeSingle();
      if (pmt?.lead_id) {
        const { data: lead } = await admin
          .from('leads')
          .select('client_name')
          .eq('id', pmt.lead_id)
          .maybeSingle();
        if (lead?.client_name) clientName = lead.client_name;
      }
    } catch (e) {
      console.error(
        '[receiveIndividualFromContadorAction] name lookups fallaron (no fatal):',
        e,
      );
    }
    const adminName = callerProfile.full_name ?? 'Administrador';
    const notes = `Recibido del contador ${contadorName} (cliente ${clientName})`;

    // INSERT ingreso en la caja del admin. Fuente de verdad de que el
    // admin ya tiene el dinero en su caja. Si falla, abortamos sin
    // tocar transfers.
    const { error: ingresoErr } = await admin
      .from('admin_cash_register')
      .insert({
        admin_id: adminId,
        amount,
        operation_type: 'ingreso',
        source: 'recibido_contador',
        payment_id: paymentId,
        registered_by: adminId,
        notes,
      });
    if (ingresoErr) {
      console.error(
        '[receiveIndividualFromContadorAction] insert ingreso falló:',
        ingresoErr,
      );
      return {
        status: 'error',
        message: `No se pudo registrar en tu caja: ${ingresoErr.message}`,
        reason: 'other',
      };
    }

    // INSERT contador_to_admin_transfers — para que el balance vivo
    // del contador en la sección "Recibir efectivo del contador" baje
    // por el mismo monto. Non-fatal: si la tabla aún no existe
    // (migración pendiente), el balance del contador no se ajusta
    // pero la transferencia en admin_cash_register sí queda, así que
    // el ingreso del admin no se pierde. Se loguea para auditoría.
    if (contadorId) {
      try {
        const { error: transferErr } = await admin
          .from('contador_to_admin_transfers')
          .insert({
            contador_id: contadorId,
            admin_id: adminId,
            amount,
            pin_validated: true,
            validated_at: new Date().toISOString(),
            notes,
          });
        if (transferErr) {
          console.error(
            '[receiveIndividualFromContadorAction] transfer insert falló (no fatal):',
            transferErr,
          );
        }
      } catch (e) {
        console.error(
          '[receiveIndividualFromContadorAction] transfer excepción (no fatal):',
          e,
        );
      }
    }

    // Notif al contador (non-fatal).
    try {
      if (contadorId) {
        const amountFmt = new Intl.NumberFormat('es-MX', {
          style: 'currency',
          currency: 'MXN',
          minimumFractionDigits: 0,
        }).format(amount);
        const { error: notifErr } = await admin
          .from('notifications')
          .insert({
            recipient_id: contadorId,
            type: 'efectivo_transferido_admin',
            message: `✅ ${adminName} recibió ${amountFmt} de ${clientName} de tu caja.`,
          });
        if (notifErr) {
          console.error(
            '[receiveIndividualFromContadorAction] notif falló (no fatal):',
            notifErr,
          );
        }
      }
    } catch (e) {
      console.error(
        '[receiveIndividualFromContadorAction] notif excepción (no fatal):',
        e,
      );
    }

    revalidatePath('/contador');
    revalidatePath('/admin/mi-caja');
    revalidatePath('/admin/caja');
    revalidatePath('/dashboard');
    return { status: 'success', received: amount };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al recibir cobro del contador';
    console.error(
      '[receiveIndividualFromContadorAction] excepción no controlada:',
      err,
    );
    return { status: 'error', message, reason: 'other' };
  }
}

/**
 * `receiveBulkFromContadorAction(payment_ids, pin)` — versión bulk de
 * la recepción individual. El admin selecciona varias filas en la
 * tabla "Cobros en efectivo registrados" y las confirma una sola vez
 * con su PIN.
 *
 * Comportamiento atómico: si cualquier payment_id falla las
 * pre-condiciones (no validado por contador, ya recibido por otro
 * admin, falla de DB), abortamos y revertimos los inserts ya hechos
 * para no dejar la cadena del efectivo en estado parcial. El rollback
 * es best-effort — loggeamos los fallos individuales sin reintentar.
 *
 * Notif al contador: una sola notificación agregada con el total y la
 * cantidad de cobros (no spam de N notificaciones).
 */
export async function receiveBulkFromContadorAction(
  paymentIdsInput: string[],
  pinInput: string,
): Promise<ReceiveBulkFromContadorState> {
  // Inserts ya realizados; usados para rollback si algo falla más
  // adelante en el bucle. Cada entry guarda lo necesario para
  // borrar la fila correspondiente.
  const inserted: {
    ingresoId: string;
    transferId: string | null;
  }[] = [];

  async function rollbackInserts(
    admin: ReturnType<typeof supabaseAdmin>,
  ): Promise<void> {
    for (const e of inserted) {
      try {
        await admin
          .from('admin_cash_register')
          .delete()
          .eq('id', e.ingresoId);
      } catch (rollErr) {
        console.error(
          '[receiveBulkFromContadorAction] rollback ingreso falló:',
          rollErr,
        );
      }
      if (e.transferId) {
        try {
          await admin
            .from('contador_to_admin_transfers')
            .delete()
            .eq('id', e.transferId);
        } catch (rollErr) {
          console.error(
            '[receiveBulkFromContadorAction] rollback transfer falló:',
            rollErr,
          );
        }
      }
    }
  }

  try {
    const parsed = ReceiveBulkFromContadorSchema.safeParse({
      payment_ids: paymentIdsInput,
      pin: pinInput,
    });
    if (!parsed.success) {
      return {
        status: 'error',
        message:
          parsed.error.flatten().formErrors.join(' ') ||
          'Datos inválidos para recibir cobros del contador.',
        reason: 'other',
      };
    }
    const { payment_ids: paymentIds, pin: providedPin } = parsed.data;

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
    const adminId = user.id;

    const admin = supabaseAdmin();

    // Role + PIN check del admin.
    const { data: callerProfile, error: callerErr } = await admin
      .from('profiles')
      .select('role, confirmation_pin, full_name')
      .eq('id', adminId)
      .maybeSingle();
    if (callerErr) {
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${callerErr.message}`,
        reason: 'other',
      };
    }
    if (
      callerProfile?.role !== 'admin' &&
      callerProfile?.role !== 'admin2'
    ) {
      return {
        status: 'error',
        message:
          'Solo un administrador (admin o admin2) puede recibir cobros del contador.',
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

    const adminName = callerProfile.full_name ?? 'Administrador';
    // Acumulamos por contador para la notif final agregada.
    const totalsByContador = new Map<string, number>();
    let totalReceived = 0;

    for (const paymentId of paymentIds) {
      // 1. Egreso source='validado_contador' para este payment_id.
      const { data: egresoRows, error: egresoErr } = await admin
        .from('admin_cash_register')
        .select('id, amount, registered_by')
        .eq('payment_id', paymentId)
        .eq('operation_type', 'egreso')
        .eq('source', 'validado_contador')
        .order('created_at', { ascending: false })
        .limit(1);
      if (egresoErr) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: `No se pudo leer un cobro: ${egresoErr.message}`,
          reason: 'other',
        };
      }
      const egreso = egresoRows?.[0];
      if (!egreso) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message:
            'Uno de los cobros seleccionados aún no fue validado por el contador.',
          reason: 'not_validated',
        };
      }
      const contadorId =
        typeof egreso.registered_by === 'string'
          ? egreso.registered_by
          : null;
      const amount = Number(egreso.amount ?? 0);

      // 2. Idempotencia: nadie recibió ya este cobro del contador.
      const { data: priorIngreso, error: priorErr } = await admin
        .from('admin_cash_register')
        .select('id')
        .eq('payment_id', paymentId)
        .eq('operation_type', 'ingreso')
        .eq('source', 'recibido_contador')
        .limit(1);
      if (priorErr) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: `No se pudo verificar duplicados: ${priorErr.message}`,
          reason: 'other',
        };
      }
      if (priorIngreso && priorIngreso.length > 0) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message:
            'Uno de los cobros seleccionados ya fue recibido por un admin.',
          reason: 'already_received',
        };
      }

      // 3. INSERT ingreso en la caja del admin.
      const { data: ingresoRow, error: ingresoErr } = await admin
        .from('admin_cash_register')
        .insert({
          admin_id: adminId,
          amount,
          operation_type: 'ingreso',
          source: 'recibido_contador',
          payment_id: paymentId,
          registered_by: adminId,
          notes: 'Recibido del contador (bulk)',
        })
        .select('id')
        .single();
      if (ingresoErr || !ingresoRow) {
        console.error(
          '[receiveBulkFromContadorAction] insert ingreso falló:',
          ingresoErr,
        );
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: `No se pudo registrar en tu caja: ${
            ingresoErr?.message ?? 'sin datos'
          }`,
          reason: 'other',
        };
      }
      const ingresoId: string = ingresoRow.id;

      // 4. INSERT contador_to_admin_transfers (non-fatal aislado:
      //    si falla solo este, NO abortamos todo el bulk — el
      //    ingreso del admin ya quedó registrado y eso es lo crítico).
      let transferId: string | null = null;
      if (contadorId) {
        try {
          const { data: transferRow, error: transferErr } = await admin
            .from('contador_to_admin_transfers')
            .insert({
              contador_id: contadorId,
              admin_id: adminId,
              amount,
              pin_validated: true,
              validated_at: new Date().toISOString(),
              notes: 'Recepción bulk',
            })
            .select('id')
            .single();
          if (transferErr) {
            console.error(
              '[receiveBulkFromContadorAction] transfer insert falló (no fatal):',
              transferErr,
            );
          } else if (transferRow) {
            transferId = transferRow.id;
          }
        } catch (e) {
          console.error(
            '[receiveBulkFromContadorAction] transfer excepción (no fatal):',
            e,
          );
        }
      }

      inserted.push({ ingresoId, transferId });
      totalReceived += amount;
      if (contadorId) {
        totalsByContador.set(
          contadorId,
          (totalsByContador.get(contadorId) ?? 0) + amount,
        );
      }
    }

    // Notif al/los contador(es). Una notif agregada por contador con
    // total y cantidad. Best-effort.
    try {
      const amountFmt = (n: number) =>
        new Intl.NumberFormat('es-MX', {
          style: 'currency',
          currency: 'MXN',
          minimumFractionDigits: 0,
        }).format(n);
      const count = paymentIds.length;
      const inserts: {
        recipient_id: string;
        type: string;
        message: string;
      }[] = [];
      for (const [contadorId, total] of totalsByContador.entries()) {
        inserts.push({
          recipient_id: contadorId,
          type: 'efectivo_transferido_admin',
          message: `✅ ${adminName} recibió ${amountFmt(total)} de ${
            count === 1 ? '1 cliente' : `${count} clientes`
          } de tu caja.`,
        });
      }
      if (inserts.length > 0) {
        const { error: notifErr } = await admin
          .from('notifications')
          .insert(inserts);
        if (notifErr) {
          console.error(
            '[receiveBulkFromContadorAction] notif falló (no fatal):',
            notifErr,
          );
        }
      }
    } catch (e) {
      console.error(
        '[receiveBulkFromContadorAction] notif excepción (no fatal):',
        e,
      );
    }

    revalidatePath('/contador');
    revalidatePath('/admin/mi-caja');
    revalidatePath('/admin/caja');
    revalidatePath('/dashboard');
    return {
      status: 'success',
      received: totalReceived,
      count: paymentIds.length,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al recibir cobros del contador';
    console.error(
      '[receiveBulkFromContadorAction] excepción no controlada:',
      err,
    );
    // Intento de rollback: el admin admin se inicializa una vez antes
    // del try; recreamos para el rollback en este catch externo. Si
    // ya fue inicializado dentro del try, los inserts ya fueron
    // revertidos en sus puntos respectivos. Acá es safety-net.
    try {
      await rollbackInserts(supabaseAdmin());
    } catch (rollErr) {
      console.error(
        '[receiveBulkFromContadorAction] rollback final falló:',
        rollErr,
      );
    }
    return { status: 'error', message, reason: 'other' };
  }
}

/**
 * `bulkReceiveCashContadorAction(payment_ids, pin)` — versión bulk de
 * la validación per-row del contador. El contador selecciona varias
 * filas en la tabla "Cobros en efectivo registrados" y confirma una
 * sola vez con su PIN. Reemplaza la UI del flujo individual.
 *
 * Por cada payment_id inserta un egreso `validado_contador` en la
 * caja del admin original (admin_id del pago_efectivo ingreso). Si
 * algo falla a mitad del bucle, rollback de los inserts ya hechos.
 *
 * Notif: una notif por admin afectado con el subtotal de SU caja.
 */
export async function bulkReceiveCashContadorAction(
  paymentIdsInput: string[],
  pinInput: string,
): Promise<BulkReceiveCashContadorState> {
  const inserted: { id: string }[] = [];
  async function rollbackInserts(
    admin: ReturnType<typeof supabaseAdmin>,
  ): Promise<void> {
    for (const e of inserted) {
      try {
        await admin
          .from('admin_cash_register')
          .delete()
          .eq('id', e.id);
      } catch (rollErr) {
        console.error(
          '[bulkReceiveCashContadorAction] rollback falló:',
          rollErr,
        );
      }
    }
  }

  try {
    const parsed = BulkReceiveCashContadorSchema.safeParse({
      payment_ids: paymentIdsInput,
      pin: pinInput,
    });
    if (!parsed.success) {
      return {
        status: 'error',
        message:
          parsed.error.flatten().formErrors.join(' ') ||
          'Datos inválidos para validación bulk.',
        reason: 'other',
      };
    }
    const { payment_ids: paymentIds, pin: providedPin } = parsed.data;

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

    // Solo el rol contador puede ejecutar esta acción (mantiene la
    // semántica del flujo: el contador es quien "recibe" del admin).
    const { data: callerProfile, error: callerErr } = await admin
      .from('profiles')
      .select('role, confirmation_pin, full_name')
      .eq('id', contadorId)
      .maybeSingle();
    if (callerErr) {
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${callerErr.message}`,
        reason: 'other',
      };
    }
    if (callerProfile?.role !== 'contador') {
      return {
        status: 'error',
        message:
          'Solo el contador puede validar cobros con este flujo.',
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
        message: 'No tienes PIN configurado.',
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

    const contadorName = callerProfile.full_name ?? 'Contador';
    // amountByAdmin: subtotal por admin para notifs individuales.
    const amountByAdmin = new Map<string, number>();
    let totalReceived = 0;

    for (const paymentId of paymentIds) {
      // 1. Encontrar el ingreso pago_efectivo (origen del cash).
      const { data: ingresoRows, error: ingresoErr } = await admin
        .from('admin_cash_register')
        .select('id, admin_id, amount')
        .eq('payment_id', paymentId)
        .eq('operation_type', 'ingreso')
        .eq('source', 'pago_efectivo')
        .order('created_at', { ascending: false })
        .limit(1);
      if (ingresoErr) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: `No se pudo leer el cobro: ${ingresoErr.message}`,
          reason: 'other',
        };
      }
      const ingreso = ingresoRows?.[0];
      if (!ingreso) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message:
            'Uno de los cobros seleccionados no es un pago en efectivo válido.',
          reason: 'not_pago_efectivo',
        };
      }
      const adminId =
        typeof ingreso.admin_id === 'string' ? ingreso.admin_id : null;
      const amount = Number(ingreso.amount ?? 0);

      // 2. Idempotencia: nadie ya validó este cobro.
      const { data: priorEgreso, error: priorErr } = await admin
        .from('admin_cash_register')
        .select('id')
        .eq('payment_id', paymentId)
        .eq('operation_type', 'egreso')
        .eq('source', 'validado_contador')
        .limit(1);
      if (priorErr) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: `No se pudo verificar duplicados: ${priorErr.message}`,
          reason: 'other',
        };
      }
      if (priorEgreso && priorEgreso.length > 0) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: 'Uno de los cobros seleccionados ya fue validado.',
          reason: 'already_validated',
        };
      }

      // 3. INSERT egreso en la caja del admin original.
      const { data: egresoRow, error: egresoErr } = await admin
        .from('admin_cash_register')
        .insert({
          admin_id: adminId,
          amount,
          operation_type: 'egreso',
          source: 'validado_contador',
          payment_id: paymentId,
          registered_by: contadorId,
          notes: 'Validación bulk del contador',
        })
        .select('id')
        .single();
      if (egresoErr || !egresoRow) {
        console.error(
          '[bulkReceiveCashContadorAction] insert egreso falló:',
          egresoErr,
        );
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: `No se pudo registrar la validación: ${
            egresoErr?.message ?? 'sin datos'
          }`,
          reason: 'other',
        };
      }
      inserted.push({ id: egresoRow.id });
      totalReceived += amount;
      if (adminId) {
        amountByAdmin.set(
          adminId,
          (amountByAdmin.get(adminId) ?? 0) + amount,
        );
      }
    }

    // Notif: una por admin afectado con SU subtotal. Best-effort.
    try {
      const fmt = (n: number) =>
        new Intl.NumberFormat('es-MX', {
          style: 'currency',
          currency: 'MXN',
          minimumFractionDigits: 0,
        }).format(n);
      const inserts: {
        recipient_id: string;
        type: string;
        message: string;
      }[] = [];
      for (const [adminId, subtotal] of amountByAdmin.entries()) {
        inserts.push({
          recipient_id: adminId,
          type: 'efectivo_validado_contador',
          message: `El contador ${contadorName} validó ${fmt(subtotal)} de tu caja.`,
        });
      }
      if (inserts.length > 0) {
        const { error: notifErr } = await admin
          .from('notifications')
          .insert(inserts);
        if (notifErr) {
          console.error(
            '[bulkReceiveCashContadorAction] notif falló (no fatal):',
            notifErr,
          );
        }
      }
    } catch (e) {
      console.error(
        '[bulkReceiveCashContadorAction] notif excepción (no fatal):',
        e,
      );
    }

    revalidatePath('/contador');
    revalidatePath('/admin/caja');
    revalidatePath('/admin/mi-caja');
    revalidatePath('/dashboard');
    return {
      status: 'success',
      received: totalReceived,
      count: paymentIds.length,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al validar cobros en bulk';
    console.error(
      '[bulkReceiveCashContadorAction] excepción no controlada:',
      err,
    );
    try {
      await rollbackInserts(supabaseAdmin());
    } catch (rollErr) {
      console.error(
        '[bulkReceiveCashContadorAction] rollback final falló:',
        rollErr,
      );
    }
    return { status: 'error', message, reason: 'other' };
  }
}

/**
 * `adminReceiveDirectOrContadorBulkAction(pending_ids, validated_ids, pin)`
 * — el admin recibe en bulk una mezcla de cobros: pendientes (bypass
 * del contador, source `recibido_directo_admin`) y validados (vía
 * contador, source `recibido_contador` + transfer). Reemplaza el flujo
 * solo-validados de `receiveBulkFromContadorAction` en la UI.
 *
 * Para cada pending_payment_id se insertan DOS rows en
 * admin_cash_register: egreso en la caja del admin original e ingreso
 * en la caja del admin actual, ambos con source
 * `recibido_directo_admin`. Mantiene la contabilidad balanceada sin
 * involucrar al contador.
 *
 * Rollback atómico best-effort para todos los inserts del bucle. Una
 * sola notif al/los contador(es) afectado(s) por la slice validada.
 */
export async function adminReceiveDirectOrContadorBulkAction(
  pendingPaymentIdsInput: string[],
  validatedPaymentIdsInput: string[],
  pinInput: string,
): Promise<AdminReceiveDirectOrContadorBulkState> {
  const insertedAcr: { id: string }[] = [];
  const insertedTransfers: { id: string }[] = [];
  async function rollbackInserts(
    admin: ReturnType<typeof supabaseAdmin>,
  ): Promise<void> {
    for (const e of insertedAcr) {
      try {
        await admin
          .from('admin_cash_register')
          .delete()
          .eq('id', e.id);
      } catch (rollErr) {
        console.error(
          '[adminReceiveDirectOrContadorBulkAction] rollback acr falló:',
          rollErr,
        );
      }
    }
    for (const e of insertedTransfers) {
      try {
        await admin
          .from('contador_to_admin_transfers')
          .delete()
          .eq('id', e.id);
      } catch (rollErr) {
        console.error(
          '[adminReceiveDirectOrContadorBulkAction] rollback transfer falló:',
          rollErr,
        );
      }
    }
  }

  try {
    const parsed = AdminReceiveDirectOrContadorBulkSchema.safeParse({
      pending_payment_ids: pendingPaymentIdsInput,
      validated_payment_ids: validatedPaymentIdsInput,
      pin: pinInput,
    });
    if (!parsed.success) {
      return {
        status: 'error',
        message:
          parsed.error.flatten().formErrors.join(' ') ||
          'Datos inválidos para recepción bulk del admin.',
        reason: 'other',
      };
    }
    const {
      pending_payment_ids: pendingIds,
      validated_payment_ids: validatedIds,
      pin: providedPin,
    } = parsed.data;

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
    const adminId = user.id;

    const admin = supabaseAdmin();

    const { data: callerProfile, error: callerErr } = await admin
      .from('profiles')
      .select('role, confirmation_pin, full_name')
      .eq('id', adminId)
      .maybeSingle();
    if (callerErr) {
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${callerErr.message}`,
        reason: 'other',
      };
    }
    if (
      callerProfile?.role !== 'admin' &&
      callerProfile?.role !== 'admin2'
    ) {
      return {
        status: 'error',
        message:
          'Solo un administrador (admin o admin2) puede recibir con este flujo.',
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
        message: 'No tienes PIN configurado.',
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
    const adminName = callerProfile.full_name ?? 'Administrador';

    const nowIso = new Date().toISOString();
    const totalsByContador = new Map<string, number>();
    let totalReceived = 0;
    let directCount = 0;
    let contadorCount = 0;

    // ── SLICE DIRECTO (pendientes): bypass del contador.
    for (const paymentId of pendingIds) {
      // 1. Confirmar que la fila sigue "pendiente": existe el ingreso
      //    pago_efectivo y NO existe ningún egreso validado_contador
      //    ni ingreso recibido_directo_admin / recibido_contador.
      //    Re-check server-side para evitar race con el contador
      //    validando concurrentemente.
      const { data: pagoRows, error: pagoErr } = await admin
        .from('admin_cash_register')
        .select('admin_id, amount')
        .eq('payment_id', paymentId)
        .eq('operation_type', 'ingreso')
        .eq('source', 'pago_efectivo')
        .order('created_at', { ascending: false })
        .limit(1);
      if (pagoErr) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: `No se pudo leer un cobro: ${pagoErr.message}`,
          reason: 'other',
        };
      }
      const pago = pagoRows?.[0];
      if (!pago) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message:
            'Uno de los cobros seleccionados no es un pago en efectivo válido.',
          reason: 'other',
        };
      }
      const originalAdminId =
        typeof pago.admin_id === 'string' ? pago.admin_id : null;
      const amount = Number(pago.amount ?? 0);

      const { data: prior, error: priorErr } = await admin
        .from('admin_cash_register')
        .select('id, operation_type, source')
        .eq('payment_id', paymentId)
        .or(
          'operation_type.eq.egreso,source.eq.recibido_directo_admin,source.eq.recibido_contador',
        );
      if (priorErr) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: `No se pudo verificar el estado del cobro: ${priorErr.message}`,
          reason: 'other',
        };
      }
      const hasValidated = (prior ?? []).some(
        (r) =>
          r.operation_type === 'egreso' &&
          (r as { source?: string }).source === 'validado_contador',
      );
      const hasReceived = (prior ?? []).some(
        (r) =>
          r.operation_type === 'ingreso' &&
          ((r as { source?: string }).source === 'recibido_directo_admin' ||
            (r as { source?: string }).source === 'recibido_contador'),
      );
      if (hasValidated) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message:
            'Un cobro marcado como "directo" ya fue validado por el contador. Refresca y vuelve a intentar.',
          reason: 'concurrent_validation',
        };
      }
      if (hasReceived) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: 'Un cobro ya fue recibido previamente.',
          reason: 'already_received',
        };
      }

      // 2. EGRESO en la caja del admin original — el dinero sale.
      const { data: egresoRow, error: egresoErr } = await admin
        .from('admin_cash_register')
        .insert({
          admin_id: originalAdminId,
          amount,
          operation_type: 'egreso',
          source: 'recibido_directo_admin',
          payment_id: paymentId,
          registered_by: adminId,
          notes: `Entregado directo a ${adminName} (bypass contador)`,
        })
        .select('id')
        .single();
      if (egresoErr || !egresoRow) {
        console.error(
          '[adminReceiveDirectOrContadorBulkAction] egreso directo falló:',
          egresoErr,
        );
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: `No se pudo registrar la salida: ${
            egresoErr?.message ?? 'sin datos'
          }`,
          reason: 'other',
        };
      }
      insertedAcr.push({ id: egresoRow.id });

      // 3. INGRESO en la caja del admin actual — el dinero entra.
      const { data: ingresoRow, error: ingresoErr } = await admin
        .from('admin_cash_register')
        .insert({
          admin_id: adminId,
          amount,
          operation_type: 'ingreso',
          source: 'recibido_directo_admin',
          payment_id: paymentId,
          registered_by: adminId,
          notes: 'Recibido directo (sin contador)',
        })
        .select('id')
        .single();
      if (ingresoErr || !ingresoRow) {
        console.error(
          '[adminReceiveDirectOrContadorBulkAction] ingreso directo falló:',
          ingresoErr,
        );
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: `No se pudo registrar en tu caja: ${
            ingresoErr?.message ?? 'sin datos'
          }`,
          reason: 'other',
        };
      }
      insertedAcr.push({ id: ingresoRow.id });

      totalReceived += amount;
      directCount += 1;
    }

    // ── SLICE VIA CONTADOR (validados): mismo flujo que
    //    receiveBulkFromContadorAction pero embebido.
    for (const paymentId of validatedIds) {
      const { data: egresoRows, error: egresoErr } = await admin
        .from('admin_cash_register')
        .select('id, amount, registered_by')
        .eq('payment_id', paymentId)
        .eq('operation_type', 'egreso')
        .eq('source', 'validado_contador')
        .order('created_at', { ascending: false })
        .limit(1);
      if (egresoErr) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: `No se pudo leer un cobro: ${egresoErr.message}`,
          reason: 'other',
        };
      }
      const egreso = egresoRows?.[0];
      if (!egreso) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message:
            'Un cobro marcado como "validado" ya no lo está. Refresca y vuelve a intentar.',
          reason: 'not_validated',
        };
      }
      const contadorId =
        typeof egreso.registered_by === 'string'
          ? egreso.registered_by
          : null;
      const amount = Number(egreso.amount ?? 0);

      const { data: prior, error: priorErr } = await admin
        .from('admin_cash_register')
        .select('id')
        .eq('payment_id', paymentId)
        .eq('operation_type', 'ingreso')
        .in('source', ['recibido_contador', 'recibido_directo_admin'])
        .limit(1);
      if (priorErr) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: `No se pudo verificar duplicados: ${priorErr.message}`,
          reason: 'other',
        };
      }
      if (prior && prior.length > 0) {
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: 'Un cobro ya fue recibido previamente.',
          reason: 'already_received',
        };
      }

      const { data: ingresoRow, error: ingresoErr } = await admin
        .from('admin_cash_register')
        .insert({
          admin_id: adminId,
          amount,
          operation_type: 'ingreso',
          source: 'recibido_contador',
          payment_id: paymentId,
          registered_by: adminId,
          notes: 'Recibido del contador (bulk)',
        })
        .select('id')
        .single();
      if (ingresoErr || !ingresoRow) {
        console.error(
          '[adminReceiveDirectOrContadorBulkAction] ingreso vía contador falló:',
          ingresoErr,
        );
        await rollbackInserts(admin);
        return {
          status: 'error',
          message: `No se pudo registrar en tu caja: ${
            ingresoErr?.message ?? 'sin datos'
          }`,
          reason: 'other',
        };
      }
      insertedAcr.push({ id: ingresoRow.id });

      if (contadorId) {
        try {
          const { data: transferRow, error: transferErr } = await admin
            .from('contador_to_admin_transfers')
            .insert({
              contador_id: contadorId,
              admin_id: adminId,
              amount,
              pin_validated: true,
              validated_at: nowIso,
              notes: 'Recepción bulk mixta',
            })
            .select('id')
            .single();
          if (transferErr) {
            console.error(
              '[adminReceiveDirectOrContadorBulkAction] transfer falló (no fatal):',
              transferErr,
            );
          } else if (transferRow) {
            insertedTransfers.push({ id: transferRow.id });
          }
        } catch (e) {
          console.error(
            '[adminReceiveDirectOrContadorBulkAction] transfer excepción (no fatal):',
            e,
          );
        }
        totalsByContador.set(
          contadorId,
          (totalsByContador.get(contadorId) ?? 0) + amount,
        );
      }
      totalReceived += amount;
      contadorCount += 1;
    }

    // Notifs (best-effort).
    try {
      const fmt = (n: number) =>
        new Intl.NumberFormat('es-MX', {
          style: 'currency',
          currency: 'MXN',
          minimumFractionDigits: 0,
        }).format(n);
      // Slice vía contador → notif al contador con su subtotal.
      const inserts: {
        recipient_id: string;
        type: string;
        message: string;
      }[] = [];
      for (const [contadorId, subtotal] of totalsByContador.entries()) {
        inserts.push({
          recipient_id: contadorId,
          type: 'efectivo_transferido_admin',
          message: `✅ ${adminName} recibió ${fmt(subtotal)} de tu caja.`,
        });
      }
      if (inserts.length > 0) {
        const { error: notifErr } = await admin
          .from('notifications')
          .insert(inserts);
        if (notifErr) {
          console.error(
            '[adminReceiveDirectOrContadorBulkAction] notif contador falló (no fatal):',
            notifErr,
          );
        }
      }

      // Notif a admins (broadcast con el total + desglose).
      const { data: admins } = await admin
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .eq('is_active', true);
      if (admins && admins.length > 0) {
        const message =
          `✅ ${adminName} recibió ${fmt(totalReceived)} — ` +
          `${directCount} directo + ${contadorCount} del contador`;
        const adminInserts = admins.map((a) => ({
          recipient_id: a.id,
          type: 'efectivo_recibido_admin_mixto',
          message,
        }));
        const { error: notifErr } = await admin
          .from('notifications')
          .insert(adminInserts);
        if (notifErr) {
          console.error(
            '[adminReceiveDirectOrContadorBulkAction] notif admins falló (no fatal):',
            notifErr,
          );
        }
      }
    } catch (e) {
      console.error(
        '[adminReceiveDirectOrContadorBulkAction] notif excepción (no fatal):',
        e,
      );
    }

    revalidatePath('/contador');
    revalidatePath('/admin/mi-caja');
    revalidatePath('/admin/caja');
    revalidatePath('/dashboard');
    return {
      status: 'success',
      received: totalReceived,
      direct_count: directCount,
      contador_count: contadorCount,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al recibir cobros';
    console.error(
      '[adminReceiveDirectOrContadorBulkAction] excepción no controlada:',
      err,
    );
    try {
      await rollbackInserts(supabaseAdmin());
    } catch (rollErr) {
      console.error(
        '[adminReceiveDirectOrContadorBulkAction] rollback final falló:',
        rollErr,
      );
    }
    return { status: 'error', message, reason: 'other' };
  }
}
