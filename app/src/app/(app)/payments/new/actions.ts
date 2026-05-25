'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  PaymentCreateSchema,
  type PaymentFormState,
} from './schema';
import { validatePhotoFile } from '@/lib/validate-photo';

// NB: 'use server' file — solo async functions. Schemas/types en ./schema.

const STORAGE_BUCKET = 'payments-evidence';

/**
 * Mini txn log para rollback manual de los efectos de `savePaymentAction`.
 * Mismo patrón que en `/leads/new/actions.ts`. Las pasos posibles que
 * pueden fallar son: upload de evidencia → INSERT payment → INSERT
 * payment_deductibles → recalcular leads.payment_status. Cada paso exitoso
 * empuja su undo y los corremos en orden inverso si algo después rompe.
 */
type Undo = () => Promise<void>;
class TxnLog {
  private stack: Undo[] = [];
  push(fn: Undo) {
    this.stack.push(fn);
  }
  async rollback(reason: string): Promise<void> {
    console.error(`[savePaymentAction] iniciando rollback: ${reason}`);
    while (this.stack.length > 0) {
      const fn = this.stack.pop()!;
      try {
        await fn();
      } catch (e) {
        console.error('[savePaymentAction] paso de rollback falló:', e);
      }
    }
  }
}

/**
 * Registra un pago contra un lead.
 *
 * Recibe FormData (no un objeto) porque incluye un File de evidencia que
 * no se serializa bien como JSON. Los deducibles vienen como JSON string
 * en `deductibles_json` para evitar parsear arrays de `formData.getAll()`.
 *
 * Flujo:
 *   1. Validar (Zod). FormData → objeto → safeParse.
 *   2. Auth: `auth.getUser()` para `registered_by`.
 *   3. Upload de evidencia opcional al bucket `payments-evidence`.
 *   4. INSERT en `payments` con net_amount calculado.
 *   5. INSERT bulk en `payment_deductibles` si hay deducibles.
 *   6. Recalcular `leads.payment_status` sumando todos los pagos
 *      exitosos del lead (incluido este). Reglas:
 *        suma >= total_amount  → 'pagado'
 *        suma > 0              → 'parcial'
 *        suma == 0             → 'pendiente'  (no debería ocurrir
 *                                              post-success aquí)
 *   7. Si paso 6 falla, NO revertimos los pasos 4-5 — el pago está
 *      registrado y es válido; solo el estado del lead queda
 *      desactualizado. Devolvemos success con un message advirtiendo.
 */
export async function savePaymentAction(
  _prev: PaymentFormState,
  formData: FormData,
): Promise<PaymentFormState> {
  const txn = new TxnLog();
  try {
    // ── 1. Parse + validate
    let deductiblesParsed: unknown = [];
    const dRaw = formData.get('deductibles_json');
    if (typeof dRaw === 'string' && dRaw.length > 0) {
      try {
        deductiblesParsed = JSON.parse(dRaw);
      } catch (e) {
        return {
          status: 'error',
          message: 'Formato inválido en la lista de deducibles.',
        };
      }
    }
    const amountRaw = formData.get('amount');
    const amountNum = typeof amountRaw === 'string' ? Number(amountRaw) : NaN;

    const parsed = PaymentCreateSchema.safeParse({
      lead_id: formData.get('lead_id'),
      amount: amountNum,
      method: formData.get('method'),
      payment_type: formData.get('payment_type'),
      deductibles: deductiblesParsed,
    });

    if (!parsed.success) {
      console.error(
        '[savePaymentAction] validación falló:',
        parsed.error.flatten(),
      );
      return {
        status: 'error',
        message: 'Datos inválidos',
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      };
    }
    const data = parsed.data;

    // ── 2. Auth
    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      console.error('[savePaymentAction] auth.getUser falló:', authErr);
      return {
        status: 'error',
        message: 'Sesión no válida. Vuelve a iniciar sesión.',
      };
    }
    const userId = user.id;

    const admin = supabaseAdmin();

    // ── 3. Upload evidencia (OBLIGATORIA para cualquier método).
    //    Política unificada 2026-05/3: toda foto de pago/entrega es
    //    requerida, sin distinguir efectivo vs digital. Defensa en
    //    profundidad con `validatePhotoFile` que aplica las mismas
    //    reglas que el cliente (size, extensión).
    const evidence = formData.get('evidence');
    const photoResult = validatePhotoFile(evidence);
    if (!photoResult.ok) {
      return { status: 'error', message: photoResult.message };
    }
    const evidenceFile = evidence as File;
    const ext = (photoResult.file.name.split('.').pop() ?? 'bin').toLowerCase();
    let evidenceUrl: string | null = null;
    const path = `${data.lead_id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: upErr } = await admin.storage
      .from(STORAGE_BUCKET)
      .upload(path, evidenceFile, {
        contentType: photoResult.file.type || `image/${ext}`,
        upsert: false,
      });
    if (upErr) {
      console.error('[savePaymentAction] storage upload falló:', upErr);
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

    // ── 4. INSERT payment
    const totalDed = data.deductibles.reduce((s, d) => s + d.amount, 0);
    const netAmount = Math.max(0, data.amount - totalDed);

    // NB: la DB usa nombres distintos a los del schema interno del form:
    //   form `method`        → DB column `payment_method`
    //   variable `evidenceUrl` → DB column `evidence_photo_url`
    // El mapeo se hace en este sitio (no en schema.ts) para que el contrato
    // UI↔server (`PaymentCreateInput.method`) sea independiente del nombre
    // físico de la columna. Si más adelante renombramos en DB, solo se
    // tocan los dos puntos de borde (este INSERT y el SELECT en page.tsx).
    //
    // `driver_id` siempre null aquí — la asignación de chofer migró al
    // formulario de /leads/new. La columna se mantiene en payments por si
    // alguien quiere reusarla a futuro, pero este endpoint no la setea.
    const { data: paymentRow, error: payErr } = await admin
      .from('payments')
      .insert({
        lead_id: data.lead_id,
        amount: data.amount,
        net_amount: netAmount,
        payment_method: data.method,
        payment_type: data.payment_type,
        driver_id: null,
        status: 'exitoso',
        evidence_photo_url: evidenceUrl,
        paid_at: new Date().toISOString(),
        registered_by: userId,
      })
      .select('id')
      .single();
    if (payErr || !paymentRow) {
      console.error('[savePaymentAction] insert payment falló:', payErr);
      await txn.rollback('insert payment falló');
      return {
        status: 'error',
        message: `No se pudo registrar el pago: ${payErr?.message ?? 'sin datos'}`,
      };
    }
    const paymentId: string = paymentRow.id;
    txn.push(async () => {
      await admin.from('payments').delete().eq('id', paymentId);
    });

    // ── 5. INSERT bulk deductibles
    if (data.deductibles.length > 0) {
      const dInserts = data.deductibles.map((d) => ({
        payment_id: paymentId,
        concept: d.concept,
        amount: d.amount,
      }));
      const { error: dErr } = await admin
        .from('payment_deductibles')
        .insert(dInserts);
      if (dErr) {
        console.error('[savePaymentAction] insert deductibles falló:', dErr);
        await txn.rollback('insert deductibles falló');
        return {
          status: 'error',
          message: `No se pudieron registrar los deducibles: ${dErr.message}`,
        };
      }
      txn.push(async () => {
        await admin
          .from('payment_deductibles')
          .delete()
          .eq('payment_id', paymentId);
      });
    }

    // ── 6. Recalcular payment_status del lead
    //    Errores aquí NO revierten el pago — el cobro es válido.
    try {
      const { data: leadRow } = await admin
        .from('leads')
        .select('total_amount')
        .eq('id', data.lead_id)
        .maybeSingle();

      const { data: paidRows } = await admin
        .from('payments')
        .select('amount')
        .eq('lead_id', data.lead_id)
        .eq('status', 'exitoso');

      const total = Number(leadRow?.total_amount ?? 0);
      const totalPaid = (paidRows ?? []).reduce(
        (s, p) => s + Number(p.amount ?? 0),
        0,
      );

      let nextStatus: 'pendiente' | 'parcial' | 'pagado';
      if (total > 0 && totalPaid >= total) nextStatus = 'pagado';
      else if (totalPaid > 0) nextStatus = 'parcial';
      else nextStatus = 'pendiente';

      const { error: leadUpdErr } = await admin
        .from('leads')
        .update({ payment_status: nextStatus })
        .eq('id', data.lead_id);
      if (leadUpdErr) {
        console.error(
          '[savePaymentAction] update lead.payment_status falló (no fatal):',
          leadUpdErr,
        );
      }
    } catch (e) {
      console.error(
        '[savePaymentAction] recalc payment_status falló (no fatal):',
        e,
      );
    }

    // ── 7. Si el método es 'efectivo', registramos un INGRESO en
    //    `admin_cash_register` atribuido al usuario que registró el
    //    pago (típicamente un admin recibiendo el cash directamente).
    //    Non-fatal — si la tabla no existe (migración pendiente),
    //    políticas RLS bloquean, o falla por cualquier razón, el pago
    //    sigue siendo válido y el flujo continúa.
    //
    //    Requiere migración manual previa:
    //      CREATE TABLE admin_cash_register (...);
    //    Que Sergio corra ese SQL antes del deploy.
    if (data.method === 'efectivo') {
      try {
        const { error: cashErr } = await admin
          .from('admin_cash_register')
          .insert({
            admin_id: userId,
            amount: data.amount,
            operation_type: 'ingreso',
            source: 'pago_efectivo',
            payment_id: paymentId,
            registered_by: userId,
          });
        if (cashErr) {
          console.error(
            '[savePaymentAction] admin_cash_register insert falló (no fatal):',
            cashErr,
          );
        }
      } catch (e) {
        console.error(
          '[savePaymentAction] admin_cash_register excepción (no fatal):',
          e,
        );
      }
    }

    // ── 8. Notificaciones a admins (best-effort, no fatal).
    //    Necesitamos el client_name del lead para el message. Si el SELECT
    //    falla, intentamos un mensaje genérico con el id corto. Cualquier
    //    error aquí se loguea pero el pago ya está registrado.
    try {
      const { data: leadName } = await admin
        .from('leads')
        .select('client_name')
        .eq('id', data.lead_id)
        .maybeSingle();
      const clientName =
        leadName?.client_name ?? `Lead ${data.lead_id.slice(0, 8)}`;

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
        }).format(data.amount);
        // Capitalizamos el método para el mensaje (efectivo → Efectivo).
        const methodLabel =
          data.method.charAt(0).toUpperCase() + data.method.slice(1);
        const message = `Pago confirmado: ${clientName} — ${amountFmt} via ${methodLabel}`;
        const inserts = admins.map((a) => ({
          recipient_id: a.id,
          type: 'pago_confirmado',
          message,
        }));
        const { error: notifErr } = await admin
          .from('notifications')
          .insert(inserts);
        if (notifErr) {
          console.error(
            '[savePaymentAction] notif insert falló (no fatal):',
            notifErr,
          );
        }
      }
    } catch (e) {
      console.error(
        '[savePaymentAction] notif lookup/insert falló (no fatal):',
        e,
      );
    }

    revalidatePath('/payments');
    revalidatePath('/leads');
    return {
      status: 'success',
      message: 'Pago registrado correctamente.',
      paymentId,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al registrar el pago';
    console.error('[savePaymentAction] excepción no controlada:', err);
    await txn.rollback('excepción no controlada');
    return { status: 'error', message };
  }
}
