'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  ConfirmDeliverySchema,
  ReportIssueSchema,
  MarkFailedDeliverySchema,
  type ConfirmDeliveryState,
  type ReportIssueState,
  type MarkFailedDeliveryState,
} from './schema';

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
    const methodRaw = formData.get('payment_method');
    const receiverRaw = formData.get('receiver_id');

    const parsed = ConfirmDeliverySchema.safeParse({
      lead_id: formData.get('lead_id'),
      receiver_id:
        typeof receiverRaw === 'string' ? receiverRaw : '',
      amount_collected: Number.isFinite(amountNum) ? amountNum : 0,
      payment_method:
        typeof methodRaw === 'string' && methodRaw.length > 0
          ? methodRaw
          : null,
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
    const hasCollection =
      data.amount_collected > 0 && data.payment_method != null;

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
    //    Traemos también `client_name` y `total_amount` para usarlo en
    //    la notificación + recálculo de payment_status al final.
    const { data: leadRow, error: leadErr } = await admin
      .from('leads')
      .select(
        'id, driver_id, delivery_status, client_name, total_amount',
      )
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

    // ── Upload evidencia.
    //    Obligatoria si el chofer cobró por transferencia o Clip
    //    (necesitamos comprobante de la operación). Opcional para
    //    efectivo (el cliente entrega cash sin recibo). Si no hay
    //    cobro, la foto es siempre opcional.
    const evidence = formData.get('evidence');
    const hasEvidenceFile =
      evidence instanceof File && evidence.size > 0;
    const evidenceRequired =
      hasCollection &&
      (data.payment_method === 'transferencia' ||
        data.payment_method === 'clip');
    if (evidenceRequired && !hasEvidenceFile) {
      return {
        status: 'error',
        message:
          'La foto de evidencia es obligatoria para pagos por transferencia o Clip.',
      };
    }
    let evidenceUrl: string | null = null;
    if (hasEvidenceFile) {
      const file = evidence as File;
      if (file.size > MAX_EVIDENCE_BYTES) {
        return { status: 'error', message: 'La imagen excede 5 MB.' };
      }
      const ext = (file.name.split('.').pop() ?? 'bin').toLowerCase();
      if (!(ALLOWED_EXTS as readonly string[]).includes(ext)) {
        return {
          status: 'error',
          message: 'Formato no soportado. Usa PNG, JPG o WEBP.',
        };
      }
      const path = `${data.lead_id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr } = await admin.storage
        .from(STORAGE_BUCKET)
        .upload(path, file, {
          contentType: file.type || `image/${ext}`,
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

    // ── INSERT payment (sólo si hubo cobro real).
    //
    // El chofer cobró al cliente y lo registramos como `payments` con
    // `driver_id=auth.uid()`, `payment_type='liquidacion'` y
    // `status='exitoso'`. Esto unifica el flujo con /payments/new — el
    // admin ve estos cobros en /payments igual que los registrados a
    // mano. La foto de evidencia se comparte (mismo bucket que
    // driver_deliveries, mismo URL).
    //
    // Errores fatales aquí: rollback de upload (la entrega no se
    // confirma). Si el INSERT a payments falla, no creamos el
    // driver_delivery porque la trazabilidad quedaría rota.
    let paymentId: string | null = null;
    if (hasCollection) {
      const { data: pmtRow, error: pmtErr } = await admin
        .from('payments')
        .insert({
          lead_id: data.lead_id,
          amount: data.amount_collected,
          net_amount: data.amount_collected,
          payment_method: data.payment_method,
          payment_type: 'liquidacion',
          driver_id: driverId,
          status: 'exitoso',
          evidence_photo_url: evidenceUrl,
          paid_at: new Date().toISOString(),
          registered_by: driverId,
        })
        .select('id')
        .single();
      if (pmtErr || !pmtRow) {
        await txn.rollback('insert payment falló');
        return {
          status: 'error',
          message: `No se pudo registrar el cobro: ${
            pmtErr?.message ?? 'sin datos'
          }`,
        };
      }
      paymentId = pmtRow.id;
      const pidLocal = paymentId;
      txn.push(async () => {
        await admin.from('payments').delete().eq('id', pidLocal);
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
    //
    // admin_receiver_id queda null cuando no es efectivo (transferencia/
    // clip no necesitan que el chofer entregue cash físico) o cuando
    // no hubo cobro (lead ya liquidado).
    const receiverForInsert =
      hasCollection && data.payment_method === 'efectivo'
        ? data.receiver_id || null
        : null;
    const { data: delRow, error: delErr } = await admin
      .from('driver_deliveries')
      .insert({
        lead_id: data.lead_id,
        driver_id: driverId,
        admin_receiver_id: receiverForInsert,
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

    // ── Driver name lookup (best-effort, non-fatal).
    //    Lo necesitamos para los mensajes de dos notifs distintas
    //    (efectivo_pendiente al contador + entrega_confirmada al admin).
    //    Lo hacemos UNA VEZ acá para no duplicar el round-trip a profiles.
    //    Si falla, ambos mensajes caen al fallback 'Chofer'.
    let driverName = 'Chofer';
    try {
      const { data: dp } = await admin
        .from('profiles')
        .select('full_name')
        .eq('id', driverId)
        .maybeSingle();
      if (dp?.full_name) driverName = dp.full_name;
    } catch (e) {
      console.error(
        '[confirmDeliveryAction] driver name lookup falló (no fatal):',
        e,
      );
    }

    // ── Cash transfer flow (non-fatal).
    //    Si el chofer cobró en EFECTIVO (no transferencia/clip), creamos
    //    un registro pendiente en `cash_transfers` para que el admin lo
    //    reciba en /admin/caja. Si fue por transferencia/clip el dinero
    //    cayó directo a la cuenta y no hay efectivo físico que entregar.
    //
    //    Política de errores: si esto falla, la entrega física ya
    //    sucedió y está registrada — solo perdemos el tracking del
    //    efectivo. Loguamos pero no abortamos.
    if (hasCollection && data.payment_method === 'efectivo') {
      try {
        const { error: ctErr } = await admin
          .from('cash_transfers')
          .insert({
            driver_id: driverId,
            contador_id: null,
            amount: data.amount_collected,
            status: 'pendiente',
          });
        if (ctErr) {
          console.error(
            '[confirmDeliveryAction] cash_transfer insert falló (no fatal):',
            ctErr,
          );
        } else {
          // Refactor 2026-05: el admin (no el contador) ahora recibe
          // efectivo del chofer. Notificamos a admins + admin2 para
          // que cualquiera pueda procesar el efectivo.
          const { data: admins } = await admin
            .from('profiles')
            .select('id')
            .in('role', ['admin', 'admin2'])
            .eq('is_active', true);
          if (admins && admins.length > 0) {
            const amountFmt = new Intl.NumberFormat('es-MX', {
              style: 'currency',
              currency: 'MXN',
              minimumFractionDigits: 0,
            }).format(data.amount_collected);
            const message = `El chofer ${driverName} trae ${amountFmt} en efectivo para entregar`;
            const notifInserts = admins.map((c) => ({
              recipient_id: c.id,
              type: 'efectivo_pendiente',
              message,
            }));
            const { error: notifErr } = await admin
              .from('notifications')
              .insert(notifInserts);
            if (notifErr) {
              console.error(
                '[confirmDeliveryAction] notif efectivo_pendiente falló (no fatal):',
                notifErr,
              );
            }
          }
        }
      } catch (e) {
        console.error(
          '[confirmDeliveryAction] cash_transfer flow excepción (no fatal):',
          e,
        );
      }
    }

    // ── UPDATE leads.delivery_status = 'entregado' (AUTOMÁTICO siempre,
    //    independiente del estado de pago).
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

    // ── Recalcular payment_status del lead.
    //    Solo si hubo cobro este flujo. Si el lead ya estaba pagado y
    //    el chofer no cobró nada, no hay nada que recalcular — el
    //    status se queda como estaba (típicamente 'pagado').
    if (hasCollection) {
      try {
        const { data: paidRows } = await admin
          .from('payments')
          .select('amount')
          .eq('lead_id', data.lead_id)
          .eq('status', 'exitoso');
        const total = Number(leadRow.total_amount ?? 0);
        const totalPaid = (paidRows ?? []).reduce(
          (s, p) => s + Number(p.amount ?? 0),
          0,
        );
        let nextPayStatus: 'pendiente' | 'parcial' | 'pagado';
        if (total > 0 && totalPaid >= total) nextPayStatus = 'pagado';
        else if (totalPaid > 0) nextPayStatus = 'parcial';
        else nextPayStatus = 'pendiente';
        const { error: payUpdErr } = await admin
          .from('leads')
          .update({ payment_status: nextPayStatus })
          .eq('id', data.lead_id);
        if (payUpdErr) {
          console.error(
            '[confirmDeliveryAction] recalc payment_status falló (no fatal):',
            payUpdErr,
          );
        }
      } catch (e) {
        console.error(
          '[confirmDeliveryAction] recalc payment_status excepción (no fatal):',
          e,
        );
      }
    }

    // ── Notificación 'entrega_confirmada' a admins (best-effort, no fatal).
    //    Se emite ANTES de la Edge Function para que aunque commit-stock
    //    falle (la entrega física ya pasó, queda un cleanup manual de
    //    stock), los admins reciban la notif igual.
    //
    //    `driverName` ya fue resuelto arriba (compartido con el bloque
    //    cash_transfer) — no volvemos a SELECT.
    try {
      const clientName = leadRow.client_name ?? `Lead ${data.lead_id.slice(0, 8)}`;

      const { data: admins } = await admin
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .eq('is_active', true);

      if (admins && admins.length > 0) {
        // Mensaje diferenciado según si hubo cobro o no.
        let message: string;
        if (hasCollection) {
          const amountFmt = new Intl.NumberFormat('es-MX', {
            style: 'currency',
            currency: 'MXN',
            minimumFractionDigits: 0,
          }).format(data.amount_collected);
          const methodLabel =
            data.payment_method === 'efectivo'
              ? 'Efectivo'
              : data.payment_method === 'transferencia'
                ? 'Transferencia'
                : 'Clip';
          message = `✅ ${driverName} entregó a ${clientName} — cobró ${amountFmt} via ${methodLabel}`;
        } else {
          message = `✅ ${driverName} entregó a ${clientName} — pedido ya liquidado previamente`;
        }
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
    revalidatePath('/payments');
    revalidatePath('/admin/entregas');
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

/**
 * `reportIssueAction(_prev, formData)` — el chofer reporta un faltante
 * o detalle durante la entrega. El INSERT a `delivery_issues` se hace
 * con supabaseAdmin (bypass RLS); igual validamos ownership del lead
 * (driver_id == auth.uid()) para que un chofer no pueda reportar
 * problemas en entregas de otro.
 *
 * La foto es opcional. Si llega, sube a `driver-evidence` (mismo bucket
 * que la evidencia de entrega) y guarda la URL pública.
 *
 * Notif a admins es non-fatal: si falla, el issue ya está registrado.
 */
export async function reportIssueAction(
  _prev: ReportIssueState,
  formData: FormData,
): Promise<ReportIssueState> {
  try {
    const parsed = ReportIssueSchema.safeParse({
      lead_id: formData.get('lead_id'),
      issue_type: formData.get('issue_type'),
      description: formData.get('description'),
    });
    if (!parsed.success) {
      return {
        status: 'error',
        message: 'Datos inválidos',
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      };
    }
    const data = parsed.data;

    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      return { status: 'error', message: 'Sesión no válida.' };
    }
    const driverId = user.id;

    const admin = supabaseAdmin();

    // Ownership: solo el chofer asignado al lead puede reportar issues.
    const { data: leadRow, error: leadErr } = await admin
      .from('leads')
      .select('id, driver_id, client_name')
      .eq('id', data.lead_id)
      .maybeSingle();
    if (leadErr) {
      return {
        status: 'error',
        message: `No se pudo verificar el lead: ${leadErr.message}`,
      };
    }
    if (!leadRow || leadRow.driver_id !== driverId) {
      return {
        status: 'error',
        message: 'Esta entrega no está asignada a ti.',
      };
    }

    // Foto opcional al mismo bucket que la evidencia de entrega.
    let photoUrl: string | null = null;
    const photo = formData.get('photo');
    if (photo instanceof File && photo.size > 0) {
      if (photo.size > MAX_EVIDENCE_BYTES) {
        return { status: 'error', message: 'La imagen excede 5 MB.' };
      }
      const ext = (photo.name.split('.').pop() ?? 'bin').toLowerCase();
      if (!(ALLOWED_EXTS as readonly string[]).includes(ext)) {
        return {
          status: 'error',
          message: 'Formato no soportado. Usa PNG, JPG o WEBP.',
        };
      }
      const path = `${data.lead_id}/issues/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr } = await admin.storage
        .from(STORAGE_BUCKET)
        .upload(path, photo, {
          contentType: photo.type || `image/${ext}`,
          upsert: false,
        });
      if (upErr) {
        return {
          status: 'error',
          message: `No se pudo subir la foto: ${upErr.message}`,
        };
      }
      const { data: pub } = admin.storage.from(STORAGE_BUCKET).getPublicUrl(path);
      photoUrl = pub.publicUrl;
    }

    // INSERT delivery_issues
    const { error: insErr } = await admin.from('delivery_issues').insert({
      lead_id: data.lead_id,
      driver_id: driverId,
      issue_type: data.issue_type,
      description: data.description,
      photo_url: photoUrl,
      resolved: false,
    });
    if (insErr) {
      return {
        status: 'error',
        message: `No se pudo registrar el reporte: ${insErr.message}`,
      };
    }

    // Notif a admins (non-fatal). El message tiene un emoji inicial
    // para que destaque visualmente en el panel de notifs.
    try {
      const { data: dp } = await admin
        .from('profiles')
        .select('full_name')
        .eq('id', driverId)
        .maybeSingle();
      const driverName = dp?.full_name ?? 'Chofer';
      const clientName = leadRow.client_name ?? '(sin nombre)';
      const typeLabel = data.issue_type === 'faltante' ? 'faltante' : 'detalle';

      const { data: admins } = await admin
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .eq('is_active', true);
      if (admins && admins.length > 0) {
        const message = `⚠️ ${driverName} reportó un ${typeLabel} en entrega de ${clientName}: ${data.description}`;
        const inserts = admins.map((a) => ({
          recipient_id: a.id,
          // type='issue_reported' — nuevo valor de notification.type;
          // como `notifications.type` es text en DB, no requiere ALTER.
          type: 'issue_reported',
          message,
        }));
        const { error: notifErr } = await admin
          .from('notifications')
          .insert(inserts);
        if (notifErr) {
          console.error(
            '[reportIssueAction] notif insert falló (no fatal):',
            notifErr,
          );
        }
      }
    } catch (e) {
      console.error(
        '[reportIssueAction] notif lookup/insert excepción (no fatal):',
        e,
      );
    }

    revalidatePath('/driver');
    revalidatePath('/admin/entregas');
    return { status: 'success' };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al reportar';
    console.error('[reportIssueAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}

/**
 * `markFailedDeliveryAction(_prev, formData)` — el chofer no pudo
 * completar una entrega. Sube una foto OBLIGATORIA del lugar (cámara
 * trasera capture) + motivo, deja el lead en `delivery_status='pendiente'`
 * para que se reintente, y notifica a los admins.
 *
 * Diferencia con `reportIssueAction`:
 *   - `reportIssueAction` documenta un faltante/detalle DURANTE la
 *     entrega (la entrega se completa igual, solo registra problemas).
 *   - `markFailedDeliveryAction` registra que la entrega NO se realizó
 *     (cliente ausente, dirección incorrecta, etc.), bloqueando el
 *     flujo de cobro y dejando la pieza para reintento.
 *
 * Política de errores: la subida de foto es FATAL si falla — sin
 * evidencia el reporte no es accionable. La notif a admins es
 * non-fatal (mejor un reporte sin notif que un reporte perdido).
 */
export async function markFailedDeliveryAction(
  _prev: MarkFailedDeliveryState,
  formData: FormData,
): Promise<MarkFailedDeliveryState> {
  try {
    const parsed = MarkFailedDeliverySchema.safeParse({
      lead_id: formData.get('lead_id'),
      reason: formData.get('reason'),
    });
    if (!parsed.success) {
      return {
        status: 'error',
        message: 'Datos inválidos',
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      };
    }
    const data = parsed.data;

    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      return { status: 'error', message: 'Sesión no válida.' };
    }
    const driverId = user.id;

    const admin = supabaseAdmin();

    // Ownership: solo el chofer asignado puede reportar falla. Mismo
    // patrón que reportIssueAction.
    const { data: leadRow, error: leadErr } = await admin
      .from('leads')
      .select('id, driver_id, delivery_status, client_name')
      .eq('id', data.lead_id)
      .maybeSingle();
    if (leadErr) {
      return {
        status: 'error',
        message: `No se pudo verificar el lead: ${leadErr.message}`,
      };
    }
    if (!leadRow || leadRow.driver_id !== driverId) {
      return {
        status: 'error',
        message: 'Esta entrega no está asignada a ti.',
      };
    }
    // No tiene sentido reportar falla en una entrega ya entregada o
    // cancelada — la idempotencia evita estados absurdos en DB.
    if (leadRow.delivery_status === 'entregado') {
      return {
        status: 'error',
        message: 'Esta entrega ya está marcada como entregada.',
      };
    }
    if (leadRow.delivery_status === 'cancelado') {
      return {
        status: 'error',
        message: 'Esta entrega está cancelada.',
      };
    }

    // Foto OBLIGATORIA. Sin evidencia el reporte no se acepta — el
    // admin necesita ver el lugar para tomar acción (reagendar,
    // contactar al cliente, etc.).
    const photo = formData.get('photo');
    if (!(photo instanceof File) || photo.size === 0) {
      return {
        status: 'error',
        message: 'La foto del lugar es obligatoria.',
      };
    }
    if (photo.size > MAX_EVIDENCE_BYTES) {
      return { status: 'error', message: 'La imagen excede 5 MB.' };
    }
    const ext = (photo.name.split('.').pop() ?? 'bin').toLowerCase();
    if (!(ALLOWED_EXTS as readonly string[]).includes(ext)) {
      return {
        status: 'error',
        message: 'Formato no soportado. Usa PNG, JPG o WEBP.',
      };
    }
    // Ruta `failed/{lead_id}/{timestamp}.ext` siguiendo el patrón
    // sugerido por la spec — separa visualmente las fotos de fallas
    // de las de cobros (que viven directamente en `{lead_id}/...`).
    const path = `failed/${data.lead_id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: upErr } = await admin.storage
      .from(STORAGE_BUCKET)
      .upload(path, photo, {
        contentType: photo.type || `image/${ext}`,
        upsert: false,
      });
    if (upErr) {
      return {
        status: 'error',
        message: `No se pudo subir la foto: ${upErr.message}`,
      };
    }
    const { data: pub } = admin.storage.from(STORAGE_BUCKET).getPublicUrl(path);
    const photoUrl = pub.publicUrl;

    // UPDATE lead: dejamos el delivery_status en 'pendiente' (no
    // sobreescribimos en_transito si ya está en tránsito — el chofer
    // puede haber estado en camino). Solo llenamos las columnas de
    // falla. Si una falla previa existía, la sobreescribimos con la
    // nueva (la última falla es la que importa para el admin).
    const { error: updErr } = await admin
      .from('leads')
      .update({
        failed_delivery_reason: data.reason,
        failed_delivery_photo_url: photoUrl,
      })
      .eq('id', data.lead_id);
    if (updErr) {
      // Best-effort: borrar la foto recién subida si el UPDATE falla
      // (no queremos huérfanos en storage).
      try {
        await admin.storage.from(STORAGE_BUCKET).remove([path]);
      } catch (e) {
        console.error(
          '[markFailedDeliveryAction] cleanup foto huérfana falló:',
          e,
        );
      }
      return {
        status: 'error',
        message: `No se pudo registrar la falla: ${updErr.message}`,
      };
    }

    // Notif a admins (non-fatal).
    try {
      const { data: dp } = await admin
        .from('profiles')
        .select('full_name')
        .eq('id', driverId)
        .maybeSingle();
      const driverName = dp?.full_name ?? 'Chofer';
      const clientName = leadRow.client_name ?? '(sin nombre)';

      const { data: admins } = await admin
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .eq('is_active', true);
      if (admins && admins.length > 0) {
        // Texto explícito sobre la acción pendiente: el admin debe
        // marcar "Devolver al stock" en /admin/entregas para que el
        // material regrese al inventario y libere el compromiso.
        const message =
          `⚠️ DEVOLUCIÓN PENDIENTE: ${driverName} no pudo entregar a ` +
          `${clientName}. El material debe regresar al almacén. ` +
          `Motivo: ${data.reason}`;
        const inserts = admins.map((a) => ({
          recipient_id: a.id,
          type: 'delivery_failed',
          message,
        }));
        const { error: notifErr } = await admin
          .from('notifications')
          .insert(inserts);
        if (notifErr) {
          console.error(
            '[markFailedDeliveryAction] notif insert falló (no fatal):',
            notifErr,
          );
        }
      }
    } catch (e) {
      console.error(
        '[markFailedDeliveryAction] notif lookup/insert excepción (no fatal):',
        e,
      );
    }

    revalidatePath('/driver');
    revalidatePath('/admin/entregas');
    return { status: 'success' };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al registrar falla';
    console.error(
      '[markFailedDeliveryAction] excepción no controlada:',
      err,
    );
    return { status: 'error', message };
  }
}
