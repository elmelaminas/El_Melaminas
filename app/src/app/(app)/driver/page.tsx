import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  DriverClient,
  type DeliveryCardData,
  type ReceiverOption,
} from './driver-client';

/**
 * Página /driver — vista del chofer.
 *
 * Server Component:
 *   1. Lee `auth.uid()` del usuario logueado vía cookies (supabaseServer).
 *   2. SELECT leads donde driver_id = uid AND delivery_status IN
 *      ('pendiente', 'en_transito') AND deleted_at IS NULL.
 *   3. Para cada lead, joinea lead_colors → colors(name) y suma
 *      payments(amount where status='exitoso') para calcular adeudo.
 *   4. SELECT profiles activos role∈{admin, supervisor} para el
 *      dropdown "Entregar efectivo a".
 *   5. Pasa al Client Component.
 *
 * Mobile-first: el Client se encarga del layout estrecho (max 420px).
 */
export const dynamic = 'force-dynamic';

export default async function DriverPage() {
  try {
    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      return <ErrorState message="Sesión no válida. Vuelve a iniciar sesión." />;
    }
    const driverId = user.id;

    const admin = supabaseAdmin();

    // Hoy en YYYY-MM-DD (UTC para consistencia con el campo
    // `delivery_date` que es DATE sin huso). El banner usa esto para
    // contar entregas programadas para hoy.
    const todayIso = new Date().toISOString().slice(0, 10);

    // SELECTs en paralelo. Seis queries:
    //   1. Leads activos asignados a este chofer.
    //   2. Profile del chofer (para el saludo).
    //   3. Profiles admin/supervisor (para "Entregar efectivo a").
    //   4. Cash transfers pendientes de este chofer — la suma es el
    //      "efectivo que llevas" que se muestra en el banner. Si la
    //      tabla no existe o RLS bloquea, el banner cae a $0 y la
    //      página sigue funcionando.
    //   5. COUNT de entregas programadas para HOY (Grupo 1 — banner
    //      "📦 Tienes N entregas programadas para hoy"). Usamos
    //      `count: 'exact'` y `head: true` para no traer filas, solo
    //      el número. Non-fatal: si la columna `delivery_date` no
    //      existe (migración pendiente) loggeamos y el banner muestra 0.
    //   6. COUNT de entregas YA COMPLETADAS hoy (delivery_date=hoy
    //      AND delivery_status='entregado'). Sirve para el contador
    //      "Entrega N de M" en el modo secuencial del cliente
    //      (Grupo 2). Non-fatal igual que la #5.
    //
    //    NB: el SELECT principal (#1) trae también `delivery_date`,
    //    `delivery_order`, `failed_delivery_reason` y
    //    `failed_delivery_photo_url`. Si esas columnas no existen en
    //    DB todavía, la query entera falla — por eso conservamos los
    //    nombres exactos del DDL de la migración (Grupos 1 + 2 las
    //    requieren las dos).
    const [leadsResult, profileResult, receiversResult, cashResult, todayCountResult, todayCompletedResult] = await Promise.all([
      admin
        .from('leads')
        .select(
          `id, client_name, address, maps_url, total_amount, payment_status, delivery_status,
           delivery_date, delivery_order,
           failed_delivery_reason, failed_delivery_photo_url,
           lead_colors (
             quantity,
             colors ( name )
           )`,
        )
        .eq('driver_id', driverId)
        .in('delivery_status', ['pendiente', 'en_transito'])
        .is('deleted_at', null)
        .order('created_at', { ascending: false }),
      admin
        .from('profiles')
        .select('full_name')
        .eq('id', driverId)
        .maybeSingle(),
      admin
        .from('profiles')
        .select('id, full_name, role')
        .in('role', ['admin', 'supervisor'])
        .eq('is_active', true)
        .order('full_name'),
      admin
        .from('cash_transfers')
        .select('amount')
        .eq('driver_id', driverId)
        .eq('status', 'pendiente'),
      admin
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('driver_id', driverId)
        .eq('delivery_date', todayIso)
        .in('delivery_status', ['pendiente', 'en_transito'])
        .is('deleted_at', null),
      admin
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('driver_id', driverId)
        .eq('delivery_date', todayIso)
        .eq('delivery_status', 'entregado')
        .is('deleted_at', null),
    ]);

    if (leadsResult.error) {
      return <ErrorState message={`Error leyendo entregas: ${leadsResult.error.message}`} />;
    }
    if (receiversResult.error) {
      return <ErrorState message={`Error leyendo admins: ${receiversResult.error.message}`} />;
    }
    // cashResult: si falla (tabla no existe / RLS) NO abortamos — el
    // banner caerá a $0 pero las entregas siguen visibles. Loguamos.
    if (cashResult.error) {
      console.error('[DriverPage] cash_transfers select falló (no fatal):', cashResult.error);
    }
    const cashPending = (cashResult.data ?? []).reduce(
      (s, t) => s + Number(t.amount ?? 0),
      0,
    );

    // todayCountResult / todayCompletedResult: igual que cashResult,
    // non-fatal. Si la columna `delivery_date` no existe en DB
    // (migración pendiente), el COUNT falla y mostramos 0 en el banner
    // y el contador secuencial. Eso degrada elegantemente al modo
    // lista del Grupo 0 (todas las pendientes sin orden).
    if (todayCountResult.error) {
      console.error(
        '[DriverPage] today count select falló (no fatal):',
        todayCountResult.error,
      );
    }
    if (todayCompletedResult.error) {
      console.error(
        '[DriverPage] today completed count select falló (no fatal):',
        todayCompletedResult.error,
      );
    }
    const todayDeliveriesCount = todayCountResult.count ?? 0;
    const todayCompletedCount = todayCompletedResult.count ?? 0;

    const leadIds = (leadsResult.data ?? []).map((l) => l.id);

    // Pagos exitosos previos para calcular adeudo de cada lead.
    let paidByLead = new Map<string, number>();
    if (leadIds.length > 0) {
      const { data: pagosData, error: pagosErr } = await admin
        .from('payments')
        .select('lead_id, amount')
        .eq('status', 'exitoso')
        .in('lead_id', leadIds);
      if (pagosErr) {
        return <ErrorState message={`Error leyendo pagos previos: ${pagosErr.message}`} />;
      }
      for (const p of pagosData ?? []) {
        if (!p.lead_id) continue;
        paidByLead.set(p.lead_id, (paidByLead.get(p.lead_id) ?? 0) + Number(p.amount ?? 0));
      }
    }

    // Lecciones aprendidas en módulos previos: PostgREST puede devolver
    // joins anidados como objeto o array. `lead_colors` es many → array;
    // `colors` dentro de cada lead_color es one → puede ser objeto o
    // array de un único elemento. Manejamos ambos.
    type RawLeadColor = {
      quantity: number | null;
      colors: { name: string } | { name: string }[] | null;
    };
    type RawLead = {
      id: string;
      client_name: string;
      address: string | null;
      maps_url: string | null;
      total_amount: number | string | null;
      payment_status: string | null;
      delivery_status: string | null;
      delivery_date: string | null;
      delivery_order: number | null;
      failed_delivery_reason: string | null;
      failed_delivery_photo_url: string | null;
      lead_colors: RawLeadColor[] | null;
    };

    const deliveries: DeliveryCardData[] = ((leadsResult.data ?? []) as RawLead[]).map(
      (l) => {
        const total = Number(l.total_amount ?? 0);
        const paid = paidByLead.get(l.id) ?? 0;
        const adeudo = Math.max(0, total - paid);
        const colors = (l.lead_colors ?? [])
          .map((lc) => {
            const colorObj = Array.isArray(lc.colors) ? lc.colors[0] : lc.colors;
            return {
              color_name: colorObj?.name ?? '(color sin nombre)',
              quantity: Number(lc.quantity ?? 0),
            };
          })
          .filter((c) => c.quantity > 0);
        return {
          id: l.id,
          client_name: l.client_name,
          address: l.address ?? '',
          maps_url: l.maps_url ?? '',
          total_amount: total,
          adeudo,
          delivery_status: (l.delivery_status as 'pendiente' | 'en_transito') ?? 'pendiente',
          delivery_date: l.delivery_date,
          delivery_order: l.delivery_order,
          failed_delivery_reason: l.failed_delivery_reason,
          failed_delivery_photo_url: l.failed_delivery_photo_url,
          colors,
        };
      },
    );

    const receivers: ReceiverOption[] = (receiversResult.data ?? []).map((r) => ({
      id: r.id,
      name: r.full_name ?? '(sin nombre)',
    }));

    const driverName = profileResult.data?.full_name ?? user.email ?? 'Chofer';

    return (
      <DriverClient
        driverName={driverName}
        deliveries={deliveries}
        receivers={receivers}
        cashPending={cashPending}
        todayDeliveriesCount={todayDeliveriesCount}
        todayCompletedCount={todayCompletedCount}
        todayIso={todayIso}
      />
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al cargar entregas';
    console.error('[DriverPage] excepción no controlada:', err);
    return <ErrorState message={message} />;
  }
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar las entregas</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </div>
  );
}
