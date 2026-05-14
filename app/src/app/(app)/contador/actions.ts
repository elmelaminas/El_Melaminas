'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { ReceiveCashSchema, type ReceiveCashState } from './schema';

// NB: 'use server' file — solo async functions. Schemas/types en ./schema.

/**
 * `recibirEfectivoAction` — el contador presiona "Recibí efectivo de
 * {chofer}". Marca todos los cash_transfers pendientes del chofer como
 * 'recibido' atribuyéndolos a este contador.
 *
 * Diseño contra race condition:
 *   No hacemos un UPDATE bulk con WHERE driver_id=X AND status='pendiente'
 *   porque entre el click del contador y el UPDATE, el chofer puede
 *   confirmar otra entrega y agregar un cash_transfer nuevo. Si ese nuevo
 *   transfer queda dentro del WHERE, lo marcaríamos como recibido aunque
 *   el contador no lo haya cobrado físicamente.
 *
 *   Solución: SELECT IDs primero (snapshot) → UPDATE WHERE id IN (...).
 *   Cualquier transfer nuevo que entre después queda intacto en
 *   'pendiente' y aparecerá en la próxima ronda.
 *
 * Notif `efectivo_recibido` a admins es non-fatal — si el INSERT a
 * `notifications` falla, el cash_transfer ya se actualizó y eso es lo
 * que importa para el flujo financiero.
 */
export async function recibirEfectivoAction(
  _prev: ReceiveCashState,
  formData: FormData,
): Promise<ReceiveCashState> {
  try {
    const parsed = ReceiveCashSchema.safeParse({
      driver_id: formData.get('driver_id'),
    });
    if (!parsed.success) {
      return {
        status: 'error',
        message: 'Datos inválidos',
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      };
    }
    const { driver_id } = parsed.data;

    // Auth — el contador autenticado.
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

    // Snapshot de los pendientes en el momento del click.
    const { data: pending, error: pendErr } = await admin
      .from('cash_transfers')
      .select('id, amount')
      .eq('driver_id', driver_id)
      .eq('status', 'pendiente');
    if (pendErr) {
      console.error('[recibirEfectivoAction] select pending falló:', pendErr);
      return {
        status: 'error',
        message: `No se pudo leer el efectivo pendiente: ${pendErr.message}`,
      };
    }
    if (!pending || pending.length === 0) {
      return {
        status: 'error',
        message: 'Ese chofer no tiene efectivo pendiente.',
      };
    }

    const ids = pending.map((p) => p.id);
    const total = pending.reduce((s, p) => s + Number(p.amount ?? 0), 0);

    const { error: updErr } = await admin
      .from('cash_transfers')
      .update({ status: 'recibido', contador_id: contadorId })
      .in('id', ids);
    if (updErr) {
      console.error('[recibirEfectivoAction] update falló:', updErr);
      return {
        status: 'error',
        message: `No se pudo registrar la recepción: ${updErr.message}`,
      };
    }

    // ── Notif a admins (non-fatal).
    try {
      const [{ data: contadorProfile }, { data: driverProfile }, { data: admins }] =
        await Promise.all([
          admin.from('profiles').select('full_name').eq('id', contadorId).maybeSingle(),
          admin.from('profiles').select('full_name').eq('id', driver_id).maybeSingle(),
          // La validación de caja la hace exclusivamente el rol admin2
          // (separación de responsabilidades). Notificamos solo a ese rol
          // — el admin regular ya no opera caja.
          admin
            .from('profiles')
            .select('id')
            .eq('role', 'admin2')
            .eq('is_active', true),
        ]);
      const contadorName = contadorProfile?.full_name ?? 'Contador';
      const driverName = driverProfile?.full_name ?? 'Chofer';
      if (admins && admins.length > 0) {
        const amountFmt = new Intl.NumberFormat('es-MX', {
          style: 'currency',
          currency: 'MXN',
          minimumFractionDigits: 0,
        }).format(total);
        const message = `El contador ${contadorName} recibió ${amountFmt} en efectivo del chofer ${driverName}`;
        const notifs = admins.map((a) => ({
          recipient_id: a.id,
          type: 'efectivo_recibido',
          message,
        }));
        const { error: notifErr } = await admin.from('notifications').insert(notifs);
        if (notifErr) {
          console.error(
            '[recibirEfectivoAction] notif insert falló (no fatal):',
            notifErr,
          );
        }
      }
    } catch (e) {
      console.error(
        '[recibirEfectivoAction] notif lookup/insert excepción (no fatal):',
        e,
      );
    }

    revalidatePath('/contador');
    revalidatePath('/admin/caja');
    revalidatePath('/driver'); // banner del chofer baja a 0
    return {
      status: 'success',
      message: 'Efectivo registrado.',
      received: total,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al recibir efectivo';
    console.error('[recibirEfectivoAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}
