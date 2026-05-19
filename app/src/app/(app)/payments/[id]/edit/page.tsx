import { notFound } from 'next/navigation';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { signEvidenceUrl } from '@/lib/supabase/storage';
import { EditPaymentForm, type PaymentDetail } from './edit-payment-form';

/**
 * Página /payments/[id]/edit.
 *
 * Server Component: valida rol admin/admin2, carga el pago + sus
 * deducibles + el lead asociado, firma la URL de evidencia (bucket
 * privado) y entrega todo al `<EditPaymentForm>`.
 *
 * Acceso: el middleware permite `/payments/*` a admin/admin2/supervisor,
 * así que un supervisor que escribe la URL llegaría hasta acá. Hacemos
 * un role-check explícito a nivel page para mostrar un ErrorState claro
 * en lugar de dejarlo intentar guardar y rebotar en la action.
 *
 * Si el pago no existe (UUID inventado / borrado), devolvemos
 * `notFound()` para que Next renderice el 404 estándar.
 */
export const dynamic = 'force-dynamic';

export default async function EditPaymentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  try {
    const { id: paymentId } = await params;
    if (!paymentId) notFound();

    const userClient = await supabaseServer();
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) {
      return (
        <ErrorState message="Sesión no válida. Vuelve a iniciar sesión." />
      );
    }

    const admin = supabaseAdmin();

    // Role gate explícito: solo admin/admin2 pueden ver este form.
    const { data: callerProfile } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    const role = callerProfile?.role ?? '';
    if (role !== 'admin' && role !== 'admin2') {
      return (
        <ErrorState message="Solo un administrador puede editar pagos." />
      );
    }

    // SELECT principal: pago + lead asociado.
    const { data: paymentRow, error: payErr } = await admin
      .from('payments')
      .select(
        `id, lead_id, amount, net_amount, payment_method, payment_type,
         status, evidence_photo_url, paid_at, created_at,
         leads ( client_name, total_amount )`,
      )
      .eq('id', paymentId)
      .maybeSingle();
    if (payErr) {
      return (
        <ErrorState message={`Error leyendo el pago: ${payErr.message}`} />
      );
    }
    if (!paymentRow) notFound();

    // Deducibles asociados.
    const { data: dedRows, error: dedErr } = await admin
      .from('payment_deductibles')
      .select('id, concept, amount')
      .eq('payment_id', paymentId)
      .order('id', { ascending: true });
    if (dedErr) {
      console.error(
        '[EditPaymentPage] deductibles select falló (no fatal):',
        dedErr,
      );
    }

    // Firmamos la URL de evidencia si existe (bucket privado, public
    // URL devuelve 404 al navegador). signEvidenceUrl deja la original
    // si no parsea (best-effort).
    let signedEvidenceUrl: string | null = null;
    if (paymentRow.evidence_photo_url) {
      signedEvidenceUrl = await signEvidenceUrl(
        paymentRow.evidence_photo_url,
        'payments-evidence',
      );
    }

    // Resolver el shape del join (PostgREST a veces devuelve objeto,
    // a veces array). Mismo patrón que el resto del proyecto.
    const leadObj = Array.isArray(paymentRow.leads)
      ? paymentRow.leads[0]
      : paymentRow.leads;

    const detail: PaymentDetail = {
      id: paymentRow.id,
      lead_id: paymentRow.lead_id ?? '',
      client_name: leadObj?.client_name ?? '(sin nombre)',
      lead_total: Number(leadObj?.total_amount ?? 0),
      amount: Number(paymentRow.amount ?? 0),
      net_amount: Number(paymentRow.net_amount ?? 0),
      method:
        (paymentRow.payment_method as PaymentDetail['method']) ?? 'efectivo',
      payment_type:
        (paymentRow.payment_type as PaymentDetail['payment_type']) ??
        'anticipo',
      status: (paymentRow.status as PaymentDetail['status']) ?? 'exitoso',
      evidence_photo_url: signedEvidenceUrl,
      paid_at: paymentRow.paid_at ?? paymentRow.created_at ?? null,
      deductibles: (dedRows ?? []).map((d) => ({
        id: d.id,
        concept: d.concept ?? '',
        amount: Number(d.amount ?? 0),
      })),
    };

    return <EditPaymentForm detail={detail} />;
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al cargar el pago';
    console.error('[EditPaymentPage] excepción no controlada:', err);
    return <ErrorState message={message} />;
  }
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar el pago</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </div>
  );
}
