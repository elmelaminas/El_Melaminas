import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  NewPaymentForm,
  type LeadOption,
  type DriverOption,
} from './new-payment-form';

/**
 * Página /payments/new.
 *
 * Server Component: carga (a) leads no totalmente pagados con su adeudo
 * calculado a partir de la suma de pagos exitosos previos, y
 * (b) profiles activos con role∈{driver,admin} para el dropdown de
 * "chofer asignado". Pasa todo a `<NewPaymentForm>`.
 *
 * Adeudo se calcula en memoria porque Supabase JS no soporta agregaciones
 * GROUP BY directamente desde la API. Hacemos dos SELECTs en paralelo:
 *  - leads no pagados (con total_amount).
 *  - todos los payments exitosos (lead_id, amount).
 * Y mergeamos por lead_id. Para muchos miles de pagos esto puede ser
 * costoso — cuando lo sea, refactor a una RPC o vista materializada.
 */
export const dynamic = 'force-dynamic';

export default async function NewPaymentPage() {
  try {
    const admin = supabaseAdmin();

    const [leadsResult, driversResult, paymentsResult] = await Promise.all([
      admin
        .from('leads')
        .select(
          'id, client_name, phone, total_amount, payment_status, sale_date, created_at',
        )
        .neq('payment_status', 'pagado')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(200),
      admin
        .from('profiles')
        .select('id, full_name, role')
        .in('role', ['driver', 'admin'])
        .eq('is_active', true)
        .order('full_name'),
      admin
        .from('payments')
        .select('lead_id, amount')
        .eq('status', 'exitoso'),
    ]);

    if (leadsResult.error) {
      return <ErrorState message={`Error leyendo leads: ${leadsResult.error.message}`} />;
    }
    if (driversResult.error) {
      return <ErrorState message={`Error leyendo profiles: ${driversResult.error.message}`} />;
    }
    if (paymentsResult.error) {
      return <ErrorState message={`Error leyendo pagos previos: ${paymentsResult.error.message}`} />;
    }

    // Suma de pagos exitosos por lead_id.
    const paidByLead = new Map<string, number>();
    for (const p of paymentsResult.data ?? []) {
      if (!p.lead_id) continue;
      paidByLead.set(p.lead_id, (paidByLead.get(p.lead_id) ?? 0) + Number(p.amount ?? 0));
    }

    // Filtramos leads cuyo adeudo siga siendo > 0 (puede haber leads con
    // payment_status='parcial' pero con suma de pagos = total — el flag
    // está stale). Si está pagado de hecho, lo escondemos del selector.
    const leads: LeadOption[] = ((leadsResult.data ?? [])
      .map((l) => {
        const total = Number(l.total_amount ?? 0);
        const paid = paidByLead.get(l.id) ?? 0;
        const adeudo = Math.max(0, total - paid);
        return {
          id: l.id,
          client_name: l.client_name ?? '(sin nombre)',
          phone: l.phone ?? '',
          total_amount: total,
          paid_so_far: paid,
          adeudo,
          sale_date: l.sale_date ?? null,
        };
      })
      .filter((l) => l.adeudo > 0));

    const drivers: DriverOption[] = (driversResult.data ?? []).map((d) => ({
      id: d.id,
      name: d.full_name ?? '(sin nombre)',
      role: d.role as 'driver' | 'admin',
    }));

    return <NewPaymentForm leads={leads} drivers={drivers} />;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al cargar';
    console.error('[NewPaymentPage] excepción no controlada:', err);
    return <ErrorState message={message} />;
  }
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar el formulario</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </div>
  );
}
