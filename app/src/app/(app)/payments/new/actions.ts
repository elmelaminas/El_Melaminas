'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  PaymentCreateSchema,
  type PaymentFormState,
} from './schema';

// NB: 'use server' file — solo async functions. Schemas/types en ./schema.

const STORAGE_BUCKET = 'payments-evidence';
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_EXTS = ['png', 'jpg', 'jpeg', 'webp'] as const;

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

    // ── 3. Upload evidencia (opcional)
    let evidenceUrl: string | null = null;
    const evidence = formData.get('evidence');
    if (evidence instanceof File && evidence.size > 0) {
      if (evidence.size > MAX_EVIDENCE_BYTES) {
        return {
          status: 'error',
          message: 'La imagen excede 5 MB.',
        };
      }
      const ext = (evidence.name.split('.').pop() ?? 'bin').toLowerCase();
      if (!(ALLOWED_EXTS as readonly string[]).includes(ext)) {
        return {
          status: 'error',
          message: 'Formato de imagen no soportado. Usa PNG, JPG o WEBP.',
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
    }

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
