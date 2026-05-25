'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { validatePhotoFile } from '@/lib/validate-photo';

// NB: 'use server' — solo async functions. El schema vive inline porque
// es muy chico y no se reusa cliente-side (el form de liquidación se
// arma con un <form> simple, no con RHF).

const LIQUIDATE_METHODS = ['efectivo', 'transferencia', 'clip'] as const;

const LiquidateLeadSchema = z.object({
  lead_id: z.string().uuid('lead_id inválido'),
  payment_method: z.enum(LIQUIDATE_METHODS, {
    message: 'Método de pago inválido',
  }),
});

const EVIDENCE_BUCKET = 'payments-evidence';

export type LiquidateLeadState =
  | { status: 'idle' }
  | { status: 'success'; amount: number }
  | { status: 'error'; message: string };

/**
 * `liquidateLeadAction` — admin liquida el adeudo de un lead en un
 * solo click desde /payments. Crea un payment de tipo 'liquidacion'
 * por el monto que falta para llegar a `lead.total_amount`.
 *
 * Diseño contra race conditions: el monto se recalcula en el server
 * mirando los pagos exitosos actuales. El cliente NO manda amount —
 * si un pago concurrente reduce el adeudo entre el click y la action,
 * tomamos el nuevo valor (puede ser 0 → error explícito).
 *
 * Efectos en orden:
 *   1. Verificar role admin/admin2.
 *   2. SELECT lead.total_amount + SUM(payments exitosos).
 *   3. amount = lead.total_amount − totalPaid. Si ≤ 0 → error.
 *   4. INSERT payment {type='liquidacion', status='exitoso',
 *      paid_at=now()}.
 *   5. Si method='efectivo': INSERT admin_cash_register ingreso
 *      source='pago_efectivo' (non-fatal, mismo patrón que
 *      savePaymentAction).
 *   6. UPDATE leads.payment_status = 'pagado'.
 *   7. Notif a admins ('pago_confirmado', non-fatal).
 *   8. revalidatePath('/payments'), '/leads', '/dashboard'.
 *
 * Política de errores: si el paso 4 falla, no hicimos nada. Si pasos
 * 5-7 fallan, log y seguimos — el payment ya está registrado.
 */
export async function liquidateLeadAction(
  _prev: LiquidateLeadState,
  formData: FormData,
): Promise<LiquidateLeadState> {
  try {
    const parsed = LiquidateLeadSchema.safeParse({
      lead_id: formData.get('lead_id'),
      payment_method: formData.get('payment_method'),
    });
    if (!parsed.success) {
      return { status: 'error', message: 'Datos inválidos' };
    }
    const { lead_id, payment_method } = parsed.data;

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
    const userId = user.id;

    const admin = supabaseAdmin();

    // Role check defense-in-depth.
    const { data: caller, error: callerErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', userId)
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
        message: 'Solo un administrador puede liquidar pagos.',
      };
    }

    // Recalcular adeudo fresco. Dos queries en paralelo: lead total +
    // suma de pagos exitosos.
    const [leadRes, paidRes] = await Promise.all([
      admin
        .from('leads')
        .select('id, client_name, total_amount, payment_status')
        .eq('id', lead_id)
        .maybeSingle(),
      admin
        .from('payments')
        .select('amount')
        .eq('lead_id', lead_id)
        .eq('status', 'exitoso'),
    ]);
    if (leadRes.error) {
      return {
        status: 'error',
        message: `No se pudo leer el lead: ${leadRes.error.message}`,
      };
    }
    if (!leadRes.data) {
      return { status: 'error', message: 'Lead no encontrado.' };
    }
    if (paidRes.error) {
      return {
        status: 'error',
        message: `No se pudo leer pagos previos: ${paidRes.error.message}`,
      };
    }

    const total = Number(leadRes.data.total_amount ?? 0);
    const totalPaid = (paidRes.data ?? []).reduce(
      (s, p) => s + Number(p.amount ?? 0),
      0,
    );
    const amount = Math.max(0, total - totalPaid);
    if (amount <= 0) {
      return {
        status: 'error',
        message: 'Este lead ya está liquidado.',
      };
    }

    // Paso 3.5: Evidencia OBLIGATORIA para cualquier método (política
    // unificada 2026-05/3). El archivo viene como `evidence` en el
    // FormData. Validamos via helper compartido (size, extensión)
    // como defensa en profundidad — el cliente ya validó pero NO
    // confiamos en él. Si la subida falla, abortamos antes de tocar
    // `payments` (la action es atómica).
    const evidence = formData.get('evidence');
    const photoResult = validatePhotoFile(evidence);
    if (!photoResult.ok) {
      return {
        status: 'error',
        message: `Foto del comprobante: ${photoResult.message}`,
      };
    }
    const file = evidence as File;
    const ext = (photoResult.file.name.split('.').pop() ?? '').toLowerCase();
    let evidenceUrl: string | null = null;
    const path = `${lead_id}/liquidacion_${Date.now()}.${ext}`;
    const { error: upErr } = await admin.storage
      .from(EVIDENCE_BUCKET)
      .upload(path, file, {
        contentType:
          photoResult.file.type ||
          `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        upsert: false,
      });
    if (upErr) {
      return {
        status: 'error',
        message: `No se pudo subir la foto: ${upErr.message}`,
      };
    }
    const { data: pub } = admin.storage
      .from(EVIDENCE_BUCKET)
      .getPublicUrl(path);
    evidenceUrl = pub.publicUrl;

    // Paso 4: INSERT payment.
    const { data: payRow, error: payErr } = await admin
      .from('payments')
      .insert({
        lead_id,
        amount,
        net_amount: amount, // sin deducibles para liquidación rápida
        payment_method,
        payment_type: 'liquidacion',
        status: 'exitoso',
        paid_at: new Date().toISOString(),
        registered_by: userId,
        driver_id: null,
        evidence_photo_url: evidenceUrl,
      })
      .select('id')
      .single();
    if (payErr || !payRow) {
      // Cleanup de la evidencia recién subida — si el INSERT falla
      // no queremos blobs huérfanos en storage.
      if (evidenceUrl) {
        const marker = `/public/${EVIDENCE_BUCKET}/`;
        const idx = evidenceUrl.indexOf(marker);
        if (idx >= 0) {
          const path = decodeURIComponent(
            evidenceUrl.slice(idx + marker.length),
          );
          await admin.storage
            .from(EVIDENCE_BUCKET)
            .remove([path])
            .catch((e) =>
              console.error(
                '[liquidateLeadAction] cleanup evidencia falló (no fatal):',
                e,
              ),
            );
        }
      }
      return {
        status: 'error',
        message: `No se pudo registrar la liquidación: ${
          payErr?.message ?? 'sin datos'
        }`,
      };
    }
    const paymentId: string = payRow.id;

    // Paso 5: si efectivo, suma a la caja personal del admin.
    if (payment_method === 'efectivo') {
      try {
        const { error: cashErr } = await admin
          .from('admin_cash_register')
          .insert({
            admin_id: userId,
            amount,
            operation_type: 'ingreso',
            source: 'pago_efectivo',
            payment_id: paymentId,
            registered_by: userId,
          });
        if (cashErr) {
          console.error(
            '[liquidateLeadAction] admin_cash_register falló (no fatal):',
            cashErr,
          );
        }
      } catch (e) {
        console.error(
          '[liquidateLeadAction] admin_cash_register excepción (no fatal):',
          e,
        );
      }
    }

    // Paso 6: marcar el lead como pagado.
    const { error: updErr } = await admin
      .from('leads')
      .update({ payment_status: 'pagado' })
      .eq('id', lead_id);
    if (updErr) {
      console.error(
        '[liquidateLeadAction] update payment_status falló (no fatal):',
        updErr,
      );
    }

    // Paso 7: notif a admins.
    try {
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
        }).format(amount);
        const clientName =
          leadRes.data.client_name ?? `Lead ${lead_id.slice(0, 8)}`;
        const message = `✅ ${clientName} liquidó su adeudo de ${amountFmt}`;
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
            '[liquidateLeadAction] notif insert falló (no fatal):',
            notifErr,
          );
        }
      }
    } catch (e) {
      console.error(
        '[liquidateLeadAction] notif excepción (no fatal):',
        e,
      );
    }

    revalidatePath('/payments');
    revalidatePath('/leads');
    revalidatePath('/dashboard');
    return { status: 'success', amount };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al liquidar el lead';
    console.error('[liquidateLeadAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}
