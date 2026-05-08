import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { EditLeadForm, type DriverOption } from './edit-form';

/**
 * Página /leads/[id]/edit — admin edita fecha y chofer de un lead.
 *
 * Tres SELECTs en paralelo:
 *   1. profile del user logueado (verificar role=admin).
 *   2. lead a editar (con sus valores actuales para hidratar el form).
 *   3. choferes activos para el dropdown.
 *
 * Triple defensa de acceso (middleware + este page + el server action).
 * El page chequea role aquí ANTES de renderizar para que un user con
 * role distinto no vea el form ni siquiera por un tick (seguridad +
 * UX consistente con el resto del proyecto).
 */
export const dynamic = 'force-dynamic';

export default async function EditLeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  try {
    const { id } = await params;
    if (!id || typeof id !== 'string') {
      return <ErrorState message="ID de lead inválido." />;
    }

    const userClient = await supabaseServer();
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) {
      return <ErrorState message="Sesión no válida. Vuelve a iniciar sesión." />;
    }

    const admin = supabaseAdmin();

    const [profileResult, leadResult, driversResult] = await Promise.all([
      admin
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle(),
      admin
        .from('leads')
        .select('id, client_name, sale_date, driver_id')
        .eq('id', id)
        .maybeSingle(),
      admin
        .from('profiles')
        .select('id, full_name')
        .eq('role', 'driver')
        .eq('is_active', true)
        .order('full_name', { ascending: true }),
    ]);

    if (profileResult.error) {
      return (
        <ErrorState
          message={`No se pudo verificar tu rol: ${profileResult.error.message}`}
        />
      );
    }
    if (profileResult.data?.role !== 'admin') {
      return (
        <ErrorState message="Solo un administrador puede editar leads." />
      );
    }
    if (leadResult.error) {
      return (
        <ErrorState
          message={`Error leyendo el lead: ${leadResult.error.message}`}
        />
      );
    }
    if (!leadResult.data) {
      return <ErrorState message="Lead no encontrado." />;
    }
    if (driversResult.error) {
      return (
        <ErrorState
          message={`Error leyendo choferes: ${driversResult.error.message}`}
        />
      );
    }

    const drivers: DriverOption[] = (driversResult.data ?? []).map((d) => ({
      id: d.id,
      name: d.full_name ?? '(sin nombre)',
    }));

    // Si el lead apunta a un chofer inactivo (no en `drivers`), lo
    // agregamos al final para que el select no se muestre desincronizado.
    const currentDriverId = leadResult.data.driver_id ?? '';
    if (currentDriverId && !drivers.some((d) => d.id === currentDriverId)) {
      const { data: inactive } = await admin
        .from('profiles')
        .select('full_name')
        .eq('id', currentDriverId)
        .maybeSingle();
      if (inactive) {
        drivers.push({
          id: currentDriverId,
          name: `${inactive.full_name ?? '(sin nombre)'} (inactivo)`,
        });
      }
    }

    return (
      <EditLeadForm
        leadId={leadResult.data.id}
        clientName={leadResult.data.client_name ?? ''}
        initialSaleDate={leadResult.data.sale_date ?? ''}
        initialDriverId={currentDriverId}
        drivers={drivers}
      />
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al cargar';
    console.error('[EditLeadPage] excepción no controlada:', err);
    return <ErrorState message={message} />;
  }
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar el editor</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </div>
  );
}
