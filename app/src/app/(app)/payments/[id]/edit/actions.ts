'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { PaymentUpdateSchema, type PaymentUpdateState } from './schema';

// NB: 'use server' file — solo async functions. Schemas/tipos en
// `./schema.ts`. Constantes de upload (bucket, max size, exts) duplicadas
// del action de creación para mantener este archivo autocontenido.

const STORAGE_BUCKET = 'payments-evidence';
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_EXTS = ['png', 'jpg', 'jpeg', 'webp'] as const;

type Undo = () => Promise<void>;
class TxnLog {
  private stack: Undo[] = [];
  push(fn: Undo) {
    this.stack.push(fn);
  }
  async rollback(reason: string): Promise<void> {
    console.error(`[updatePaymentAction] iniciando rollback: ${reason}`);
    while (this.stack.length > 0) {
      const fn = this.stack.pop()!;
      try {
        await fn();
      } catch (e) {
        console.error('[updatePaymentAction] paso de rollback falló:', e);
      }
    }
  }
}

/**
 * Best-effort: dado un publicUrl de Supabase Storage del bucket
 * `payments-evidence`, deriva el path interno y borra el blob. Si la
 * URL no parsea o el remove falla, log y seguimos — preferimos blobs
 * huérfanos a abortar la operación.
 */
async function removeEvidenceBlob(url: string): Promise<void> {
  try {
    const marker = `/public/${STORAGE_BUCKET}/`;
    const idx = url.indexOf(marker);
    if (idx < 0) return;
    const path = decodeURIComponent(url.slice(idx + marker.length));
    const admin = supabaseAdmin();
    await admin.storage.from(STORAGE_BUCKET).remove([path]);
  } catch (e) {
    console.error(
      '[updatePaymentAction] cleanup blob falló (no fatal):',
      e,
    );
  }
}

/**
 * `updatePaymentAction(payment_id, formData)` — admin edita un pago
 * existente desde /payments/[id]/edit.
 *
 * Diferencias respecto a `savePaymentAction` (creación):
 *   - El `lead_id` NO es editable — viene del row original.
 *   - La fecha `paid_at` NO se toca (auditoría preservada).
 *   - Reemplazamos los `payment_deductibles` por completo (DELETE + INSERT).
 *   - Si el método anterior era 'efectivo' o el nuevo lo es, ajustamos
 *     `admin_cash_register`:
 *       old=ef, new=ef       → UPDATE amount/admin_id de la fila
 *                              (id resuelto por payment_id + source).
 *       old=ef, new≠ef       → DELETE de la fila correspondiente.
 *       old≠ef, new=ef       → INSERT nuevo ingreso.
 *   - Si la evidencia cambia (nueva foto o remove_evidence=true),
 *     subimos la nueva ANTES del UPDATE y limpiamos el blob viejo
 *     después del UPDATE exitoso (best-effort).
 *
 * Flujo:
 *   1. Validar formData con Zod.
 *   2. Auth + role admin/admin2.
 *   3. Leer payment original (necesitamos lead_id, method, amount,
 *      evidence_photo_url para diff/rollback).
 *   4. Upload nueva evidencia si vino archivo.
 *   5. UPDATE payments con amount, net_amount, method, type, evidence.
 *   6. DELETE + INSERT bulk de deducibles.
 *   7. Recalcular lead.payment_status sumando pagos exitosos.
 *   8. Ajustar admin_cash_register según diff de method (4 ramas).
 *   9. Limpiar blob viejo si correspondió.
 *  10. revalidatePath('/payments') + '/leads'.
 *
 * Si pasos 5-6 fallan: rollback de uploads + early return (DB intacta).
 * Si pasos 7-9 fallan: log no-fatal, el pago ya está editado.
 */
export async function updatePaymentAction(
  paymentId: string,
  formData: FormData,
): Promise<PaymentUpdateState> {
  const txn = new TxnLog();
  try {
    if (typeof paymentId !== 'string' || paymentId.length === 0) {
      return { status: 'error', message: 'ID de pago inválido.' };
    }

    // ── 1. Parse + validate
    let deductiblesParsed: unknown = [];
    const dRaw = formData.get('deductibles_json');
    if (typeof dRaw === 'string' && dRaw.length > 0) {
      try {
        deductiblesParsed = JSON.parse(dRaw);
      } catch {
        return {
          status: 'error',
          message: 'Formato inválido en la lista de deducibles.',
        };
      }
    }
    const amountRaw = formData.get('amount');
    const amountNum =
      typeof amountRaw === 'string' ? Number(amountRaw) : NaN;
    const removeEvidence = formData.get('remove_evidence') === '1';

    const parsed = PaymentUpdateSchema.safeParse({
      amount: amountNum,
      method: formData.get('method'),
      payment_type: formData.get('payment_type'),
      deductibles: deductiblesParsed,
      remove_evidence: removeEvidence,
    });
    if (!parsed.success) {
      console.error(
        '[updatePaymentAction] validación falló:',
        parsed.error.flatten(),
      );
      return {
        status: 'error',
        message: 'Datos inválidos',
        fieldErrors: parsed.error.flatten().fieldErrors as Record<
          string,
          string[]
        >,
      };
    }
    const data = parsed.data;

    // ── 2. Auth + role admin/admin2.
    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      return { status: 'error', message: 'Sesión no válida.' };
    }
    const userId = user.id;

    const admin = supabaseAdmin();

    const { data: callerProfile, error: profErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (profErr) {
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${profErr.message}`,
      };
    }
    if (callerProfile?.role !== 'admin' && callerProfile?.role !== 'admin2') {
      return {
        status: 'error',
        message: 'Solo un administrador puede editar pagos.',
      };
    }

    // ── 3. Leer payment original
    const { data: orig, error: origErr } = await admin
      .from('payments')
      .select(
        'id, lead_id, amount, payment_method, payment_type, evidence_photo_url, status',
      )
      .eq('id', paymentId)
      .maybeSingle();
    if (origErr) {
      return {
        status: 'error',
        message: `No se pudo leer el pago: ${origErr.message}`,
      };
    }
    if (!orig) {
      return { status: 'error', message: 'Pago no encontrado.' };
    }
    const oldMethod = (orig.payment_method as string) ?? '';
    const oldEvidenceUrl = (orig.evidence_photo_url as string) ?? null;
    const leadId = (orig.lead_id as string) ?? '';

    // ── 4. Upload evidencia nueva (si vino archivo).
    let nextEvidenceUrl: string | null = oldEvidenceUrl;
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
      const path = `${leadId}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${ext}`;
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
      const { data: pub } = admin.storage
        .from(STORAGE_BUCKET)
        .getPublicUrl(path);
      nextEvidenceUrl = pub.publicUrl;
      txn.push(async () => {
        await admin.storage.from(STORAGE_BUCKET).remove([path]);
      });
    } else if (data.remove_evidence) {
      nextEvidenceUrl = null;
    }

    // ── 5. UPDATE payment
    const totalDed = data.deductibles.reduce((s, d) => s + d.amount, 0);
    const netAmount = Math.max(0, data.amount - totalDed);

    const { error: updErr } = await admin
      .from('payments')
      .update({
        amount: data.amount,
        net_amount: netAmount,
        payment_method: data.method,
        payment_type: data.payment_type,
        evidence_photo_url: nextEvidenceUrl,
      })
      .eq('id', paymentId);
    if (updErr) {
      await txn.rollback('update payment falló');
      return {
        status: 'error',
        message: `No se pudo actualizar el pago: ${updErr.message}`,
      };
    }
    // No registramos undo del UPDATE porque a partir de acá los pasos
    // 6-9 son non-fatal (log + continue) — un rollback del UPDATE sólo
    // tendría sentido si los siguientes pasos también fueran fatales.

    // ── 6. Reemplazar deducibles.
    {
      const { error: delErr } = await admin
        .from('payment_deductibles')
        .delete()
        .eq('payment_id', paymentId);
      if (delErr) {
        console.error(
          '[updatePaymentAction] delete deductibles falló (no fatal):',
          delErr,
        );
      }
    }
    if (data.deductibles.length > 0) {
      const inserts = data.deductibles.map((d) => ({
        payment_id: paymentId,
        concept: d.concept,
        amount: d.amount,
      }));
      const { error: insErr } = await admin
        .from('payment_deductibles')
        .insert(inserts);
      if (insErr) {
        console.error(
          '[updatePaymentAction] insert deductibles falló (no fatal):',
          insErr,
        );
      }
    }

    // ── 7. Recalcular payment_status del lead.
    if (leadId) {
      try {
        const { data: leadRow } = await admin
          .from('leads')
          .select('total_amount')
          .eq('id', leadId)
          .maybeSingle();
        const { data: paidRows } = await admin
          .from('payments')
          .select('amount')
          .eq('lead_id', leadId)
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
          .eq('id', leadId);
        if (leadUpdErr) {
          console.error(
            '[updatePaymentAction] update lead.payment_status falló (no fatal):',
            leadUpdErr,
          );
        }
      } catch (e) {
        console.error(
          '[updatePaymentAction] recalc payment_status excepción (no fatal):',
          e,
        );
      }
    }

    // ── 8. Sincronizar admin_cash_register según diff de método.
    const wasEfectivo = oldMethod === 'efectivo';
    const isEfectivo = data.method === 'efectivo';
    try {
      if (wasEfectivo && isEfectivo) {
        // UPDATE del row existente (mismo payment_id + source).
        const { error: cashErr } = await admin
          .from('admin_cash_register')
          .update({ amount: data.amount })
          .eq('payment_id', paymentId)
          .eq('source', 'pago_efectivo');
        if (cashErr) {
          console.error(
            '[updatePaymentAction] cash_register update falló (no fatal):',
            cashErr,
          );
        }
      } else if (wasEfectivo && !isEfectivo) {
        // El pago dejó de ser en efectivo — borramos la fila.
        const { error: cashErr } = await admin
          .from('admin_cash_register')
          .delete()
          .eq('payment_id', paymentId)
          .eq('source', 'pago_efectivo');
        if (cashErr) {
          console.error(
            '[updatePaymentAction] cash_register delete falló (no fatal):',
            cashErr,
          );
        }
      } else if (!wasEfectivo && isEfectivo) {
        // Pasó a efectivo — insertamos nuevo ingreso. admin_id =
        // usuario que editó (no necesariamente el mismo que registró
        // originalmente, pero quien "responde" por el efectivo ahora).
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
            '[updatePaymentAction] cash_register insert falló (no fatal):',
            cashErr,
          );
        }
      }
      // ¡ojo!: si ambos métodos no son efectivo, no hay nada que hacer.
    } catch (e) {
      console.error(
        '[updatePaymentAction] cash_register sync excepción (no fatal):',
        e,
      );
    }

    // ── 9. Cleanup del blob viejo cuando lo reemplazamos o removimos.
    if (
      oldEvidenceUrl &&
      nextEvidenceUrl !== oldEvidenceUrl &&
      typeof oldEvidenceUrl === 'string'
    ) {
      await removeEvidenceBlob(oldEvidenceUrl);
    }

    revalidatePath('/payments');
    revalidatePath('/leads');
    revalidatePath('/admin/mi-caja');
    return {
      status: 'success',
      message: 'Pago actualizado correctamente.',
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al actualizar el pago';
    console.error('[updatePaymentAction] excepción no controlada:', err);
    await txn.rollback('excepción no controlada');
    return { status: 'error', message };
  }
}
