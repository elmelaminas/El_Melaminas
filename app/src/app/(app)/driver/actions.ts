'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { ConfirmDeliverySchema, type ConfirmDeliveryState } from './schema';

// NB: 'use server' file — solo async functions. Schemas/types en ./schema.

const STORAGE_BUCKET = 'driver-evidence';
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXTS = ['png', 'jpg', 'jpeg', 'webp'] as const;
const EDGE_FN = 'commit-stock-delivery';

/**
 * Confirma la entrega de un lead por parte del chofer.
 *
 * Flujo:
 *   1. Validar input (Zod).
 *   2. Auth: el chofer logueado.
 *   3. Verificar que el lead pertenezca al chofer (defensa contra
 *      manipulación del lead_id en la URL/body).
 *   4. Subir foto de evidencia opcional al bucket 'driver-evidence'.
 *   5. INSERT en `driver_deliveries`.
 *   6. UPDATE leads.delivery_status = 'entregado'.
 *   7. Invocar Edge Function `commit-stock-delivery` para que descuente
 *      el stock comprometido. Si la function no existe o falla, NO
 *      revertimos: la entrega física ya ocurrió, lo registramos como
 *      warning para que el admin lo concilie manualmente.
 *
 * Política de errores: try/catch envolvente; rollback manual de los
 * efectos previos si un paso intermedio falla (igual que `saveLeadAction`).
 */
type Undo = () => Promise<void>;
class TxnLog {
  private stack: Undo[] = [];
  push(fn: Undo) {
    this.stack.push(fn);
  }
  async rollback(reason: string): Promise<void> {
    console.error(`[confirmDeliveryAction] rollback: ${reason}`);
    while (this.stack.length > 0) {
      const fn = this.stack.pop()!;
      try {
        await fn();
      } catch (e) {
        console.error('[confirmDeliveryAction] paso de rollback falló:', e);
      }
    }
  }
}

export async function confirmDeliveryAction(
  _prev: ConfirmDeliveryState,
  formData: FormData,
): Promise<ConfirmDeliveryState> {
  const txn = new TxnLog();
  try {
    const amountRaw = formData.get('amount_collected');
    const amountNum =
      typeof amountRaw === 'string' ? Number(amountRaw) : 0;

    const parsed = ConfirmDeliverySchema.safeParse({
      lead_id: formData.get('lead_id'),
      receiver_id: formData.get('receiver_id'),
      amount_collected: Number.isFinite(amountNum) ? amountNum : 0,
    });
    if (!parsed.success) {
      console.error(
        '[confirmDeliveryAction] validación falló:',
        parsed.error.flatten(),
      );
      return {
        status: 'error',
        message: 'Datos inválidos',
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      };
    }
    const data = parsed.data;

    // ── Auth
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
    const driverId = user.id;

    const admin = supabaseAdmin();

    // ── Verificación de ownership: el lead debe estar asignado a este
    //    chofer y no estar ya entregado/cancelado. Defensa contra que un
    //    chofer cierre la entrega de otro chofer manipulando el lead_id.
    //    Traemos también `client_name` para usarlo en la notificación
    //    'entrega_confirmada' al final — evita un round-trip extra.
    const { data: leadRow, error: leadErr } = await admin
      .from('leads')
      .select('id, driver_id, delivery_status, client_name')
      .eq('id', data.lead_id)
      .maybeSingle();
    if (leadErr) {
      return { status: 'error', message: `No se pudo leer el lead: ${leadErr.message}` };
    }
    if (!leadRow) {
      return { status: 'error', message: 'Lead no encontrado.' };
    }
    if (leadRow.driver_id !== driverId) {
      // Excepción: si el rol es admin podríamos permitir; por simplicidad
      // y seguridad lo bloqueamos siempre y dejamos que un admin use otra
      // herramienta para corregir asignaciones.
      return {
        status: 'error',
        message: 'Esta entrega no está asignada a ti.',
      };
    }
    if (leadRow.delivery_status === 'entregado') {
      return { status: 'error', message: 'Esta entrega ya está marcada como entregada.' };
    }
    if (leadRow.delivery_status === 'cancelado') {
      return { status: 'error', message: 'Esta entrega está cancelada.' };
    }

    // ── Upload evidencia opcional
    let evidenceUrl: string | null = null;
    const evidence = formData.get('evidence');
    if (evidence instanceof File && evidence.size > 0) {
      if (evidence.size > MAX_EVIDENCE_BYTES) {
        return { status: 'error', message: 'La imagen excede 5 MB.' };
      }
      const ext = (evidence.name.split('.').pop() ?? 'bin').toLowerCase();
      if (!(ALLOWED_EXTS as readonly string[]).includes(ext)) {
        return {
          status: 'error',
          message: 'Formato no soportado. Usa PNG, JPG o WEBP.',
        };
      }
      const path = `${data.lead_id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr } = await admin.storage
        .from(STORAGE_BUCKET)
        .upload(path, evidence, {
          contentType: evidence.type || `image/${ext}`,
          upsert: false,
        });
      if (upErr) {
        return {
          status: 'error',
          message: `No se pudo subir la evidencia: ${upErr.message}`,
        };
      }
      const { data: pub } = admin.storage.from(STORAGE_BUCKET).getPublicUrl(path);
      evidenceUrl = pub.publicUrl;
      txn.push(async () => {
        await admin.storage.from(STORAGE_BUCKET).remove([path]);
      });
    }

    // ── INSERT driver_deliveries
    //
    // Nombres de columna del DDL real (algunos DIFERENTES al schema interno):
    //   schema interno (FormData) -> DB column
    //   ─────────────────────────────────────────────
    //   data.receiver_id          -> admin_receiver_id
    //   variable evidenceUrl      -> evidence_photo_url
    //   timestamp del action      -> delivered_at  (NO confirmed_at)
    // El campo `delivered_at` se manda explícito (en lugar de dejar el
    // default `now()` del DB) para que el timestamp registrado refleje
    // el momento del action, no el commit del INSERT — minimal pero útil
    // si hay latencia entre validación y persistencia.
    const { data: delRow, error: delErr } = await admin
      .from('driver_deliveries')
      .insert({
        lead_id: data.lead_id,
        driver_id: driverId,
        admin_receiver_id: data.receiver_id,
        amount_collected: data.amount_collected,
        evidence_photo_url: evidenceUrl,
        delivered_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (delErr || !delRow) {
      console.error('[confirmDeliveryAction] insert driver_deliveries falló:', delErr);
      await txn.rollback('insert driver_deliveries falló');
      return {
        status: 'error',
        message: `No se pudo registrar la entrega: ${delErr?.message ?? 'sin datos'}`,
      };
    }
    const deliveryId: string = delRow.id;
    txn.push(async () => {
      await admin.from('driver_deliveries').delete().eq('id', deliveryId);
    });

    // ── UPDATE leads.delivery_status = 'entregado'
    const { error: updErr } = await admin
      .from('leads')
      .update({ delivery_status: 'entregado' })
      .eq('id', data.lead_id);
    if (updErr) {
      console.error('[confirmDeliveryAction] update lead.delivery_status falló:', updErr);
      await txn.rollback('update lead.delivery_status falló');
      return {
        status: 'error',
        message: `No se pudo actualizar el estado del lead: ${updErr.message}`,
      };
    }

    // ── Notificación 'entrega_confirmada' a admins (best-effort, no fatal).
    //    Se emite ANTES de la Edge Function para que aunque commit-stock
    //    falle (la entrega física ya pasó, queda un cleanup manual de
    //    stock), los admins reciban la notif igual.
    try {
      // Nombre del chofer para el mensaje. Si el SELECT falla caemos a
      // 'Chofer' genérico — no abortamos la notif por eso.
      const { data: driverProfile } = await admin
        .from('profiles')
        .select('full_name')
        .eq('id', driverId)
        .maybeSingle();
      const driverName = driverProfile?.full_name ?? 'Chofer';
      const clientName = leadRow.client_name ?? `Lead ${data.lead_id.slice(0, 8)}`;

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
        }).format(data.amount_collected);
        const message = `Entrega confirmada: ${clientName} — cobró ${amountFmt} — Chofer: ${driverName}`;
        const inserts = admins.map((a) => ({
          recipient_id: a.id,
          type: 'entrega_confirmada',
          message,
        }));
        const { error: notifErr } = await admin
          .from('notifications')
          .insert(inserts);
        if (notifErr) {
          console.error(
            '[confirmDeliveryAction] notif insert falló (no fatal):',
            notifErr,
          );
        }
      }
    } catch (e) {
      console.error(
        '[confirmDeliveryAction] notif lookup/insert falló (no fatal):',
        e,
      );
    }

    // ── Invocar Edge Function commit-stock-delivery
    //    Convierte el "compromiso" en "salida" real (decrementa stock_total).
    //    NO ABORTAMOS si falla: la entrega física ya pasó, registrarla
    //    es lo crítico. Loggeamos el problema para que el admin lo
    //    concilie manualmente desde /warehouse.
    try {
      const { error: edgeErr } = await admin.functions.invoke(EDGE_FN, {
        body: { lead_id: data.lead_id },
      });
      if (edgeErr) {
        console.error(
          `[confirmDeliveryAction] Edge Function ${EDGE_FN} falló (no fatal):`,
          edgeErr,
        );
      }
    } catch (e) {
      console.error(
        `[confirmDeliveryAction] excepción al invocar ${EDGE_FN} (no fatal):`,
        e,
      );
    }

    revalidatePath('/driver');
    revalidatePath('/leads');
    revalidatePath('/admin/catalogs');
    return {
      status: 'success',
      message: 'Entrega confirmada.',
      deliveryId,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al confirmar entrega';
    console.error('[confirmDeliveryAction] excepción no controlada:', err);
    await txn.rollback('excepción no controlada');
    return { status: 'error', message };
  }
}
