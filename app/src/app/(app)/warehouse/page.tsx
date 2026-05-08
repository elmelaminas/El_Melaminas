import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  WarehouseClient,
  type StockRow,
  type MovementRow,
  type ColorOption,
  type LeadReadyToExit,
} from './warehouse-client';
import { MOVEMENT_TYPE_LABEL, type MovementType } from './schema';

/**
 * Página /warehouse.
 *
 * Server Component: lee `inventory` JOIN `colors` (para mostrar el nombre
 * del color, no solo el id) y los últimos 20 `inventory_movements` con
 * el color y el usuario que los registró.
 *
 * Realtime: el cliente se suscribe a cambios en `inventory` para
 * refrescar la página cuando alguien (otra pestaña, o un Server Action
 * desde /leads/new) cambia el stock. Requiere que la tabla `inventory`
 * tenga Realtime habilitado en el dashboard de Supabase. Si no, la
 * subscription se monta sin error pero no recibe eventos.
 */
export const dynamic = 'force-dynamic';

const RECENT_MOVEMENTS = 20;

export default async function WarehousePage() {
  try {
    const admin = supabaseAdmin();

    const [invResult, mvResult, leadsExitResult] = await Promise.all([
      admin
        .from('inventory')
        .select(
          `id, color_id, stock_total, stock_committed, stock_minimum,
           colors ( id, name, is_active )`,
        ),
      admin
        .from('inventory_movements')
        .select(
          `id, movement_type, quantity, reference, created_at, registered_by,
           lead_id,
           colors ( name )`,
        )
        .order('created_at', { ascending: false })
        .limit(RECENT_MOVEMENTS),
      // Leads con stock comprometido en estado pendiente — el almacenista
      // los marca como "salida" cuando físicamente prepara la mercancía.
      // Filtros:
      //   - delivery_status pendiente o en_transito (todavía no entregado).
      //   - stock_committed=true (el INSERT de leads/new ya pasó por el
      //     commit-stock que reserva el inventario).
      //   - deleted_at IS NULL.
      admin
        .from('leads')
        .select(
          `id, client_name, sale_date, delivery_status, driver_id,
           lead_colors ( quantity, colors ( name ) )`,
        )
        .in('delivery_status', ['pendiente', 'en_transito'])
        .eq('stock_committed', true)
        .is('deleted_at', null)
        .order('sale_date', { ascending: true })
        .limit(50),
    ]);

    if (invResult.error) {
      return <ErrorState message={`Error leyendo inventario: ${invResult.error.message}`} />;
    }
    if (mvResult.error) {
      return <ErrorState message={`Error leyendo movimientos: ${mvResult.error.message}`} />;
    }
    if (leadsExitResult.error) {
      // No fatal — la página renderiza sin la sección "listos para salir"
      // si esto falla. Loguamos.
      console.error(
        '[WarehousePage] leads listos para salir falló (no fatal):',
        leadsExitResult.error,
      );
    }

    type RawInv = {
      id: string;
      color_id: string | null;
      stock_total: number | string | null;
      stock_committed: number | string | null;
      stock_minimum: number | string | null;
      colors:
        | { id: string; name: string; is_active: boolean | null }
        | { id: string; name: string; is_active: boolean | null }[]
        | null;
    };

    const stockRows: StockRow[] = ((invResult.data ?? []) as RawInv[])
      .map((r) => {
        const colorObj = Array.isArray(r.colors) ? r.colors[0] : r.colors;
        if (!colorObj) {
          // Fila huérfana sin color asociado — la dejamos pasar pero
          // la marcamos para que el admin la note.
          return null;
        }
        const total = Number(r.stock_total ?? 0);
        const committed = Number(r.stock_committed ?? 0);
        const minimum = Number(r.stock_minimum ?? 0);
        return {
          inventory_id: r.id,
          color_id: colorObj.id,
          color_name: colorObj.name,
          is_active: colorObj.is_active ?? false,
          stock_total: total,
          stock_committed: committed,
          stock_available: Math.max(0, total - committed),
          stock_minimum: minimum,
        };
      })
      .filter((r): r is StockRow => r !== null)
      .sort((a, b) => a.color_name.localeCompare(b.color_name, 'es-MX'));

    type RawMv = {
      id: string;
      movement_type: string | null;
      quantity: number | null;
      reference: string | null;
      created_at: string | null;
      registered_by: string | null;
      lead_id: string | null;
      colors: { name: string } | { name: string }[] | null;
    };

    const movRows: (Omit<MovementRow, 'registered_by_name' | 'client_name'> & {
      lead_id: string | null;
    })[] = ((mvResult.data ?? []) as RawMv[]).map((m) => {
      const colorObj = Array.isArray(m.colors) ? m.colors[0] : m.colors;
      const mt = (m.movement_type ?? 'ajuste') as MovementType;
      return {
        id: m.id,
        movement_type: mt,
        movement_type_label: MOVEMENT_TYPE_LABEL[mt] ?? m.movement_type ?? '—',
        quantity: Number(m.quantity ?? 0),
        reference: m.reference,
        color_name: colorObj?.name ?? '(sin color)',
        created_at: m.created_at,
        registered_by: m.registered_by,
        lead_id: m.lead_id,
      };
    });

    // Resolver nombres de los registered_by + client_names de los leads
    // referenciados, en dos queries paralelas. Mismo patrón que
    // /admin/caja: cuando hay múltiples FKs a la misma tabla (acá
    // profiles + leads) hacemos lookups separados en lugar de embedding
    // múltiple para evitar embedding ambiguity de PostgREST.
    const userIds = Array.from(
      new Set(
        movRows
          .map((m) => m.registered_by)
          .filter((id): id is string => !!id),
      ),
    );
    const leadIds = Array.from(
      new Set(
        movRows
          .map((m) => m.lead_id)
          .filter((id): id is string => !!id),
      ),
    );
    const [usersLookup, leadsLookup] = await Promise.all([
      userIds.length > 0
        ? admin.from('profiles').select('id, full_name').in('id', userIds)
        : Promise.resolve({ data: [], error: null }),
      leadIds.length > 0
        ? admin.from('leads').select('id, client_name').in('id', leadIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    const userNameById = new Map<string, string>();
    for (const u of usersLookup.data ?? []) {
      userNameById.set(u.id, u.full_name ?? '(sin nombre)');
    }
    const clientNameByLead = new Map<string, string>();
    for (const l of leadsLookup.data ?? []) {
      clientNameByLead.set(l.id, l.client_name ?? '(sin nombre)');
    }

    const movements: MovementRow[] = movRows.map((m) => ({
      id: m.id,
      movement_type: m.movement_type,
      movement_type_label: m.movement_type_label,
      quantity: m.quantity,
      reference: m.reference,
      color_name: m.color_name,
      created_at: m.created_at,
      registered_by: m.registered_by,
      registered_by_name: m.registered_by
        ? userNameById.get(m.registered_by) ?? '—'
        : '—',
      client_name: m.lead_id ? clientNameByLead.get(m.lead_id) ?? null : null,
    }));

    // Lista de colores activos para el drawer de "Registrar Entrada"
    // — solo los que tienen fila de inventory (sino el UPDATE fallará).
    const activeColors: ColorOption[] = stockRows
      .filter((r) => r.is_active)
      .map((r) => ({ id: r.color_id, name: r.color_name }));

    // Construir lista de leads listos para salir.
    type RawLeadExit = {
      id: string;
      client_name: string | null;
      sale_date: string | null;
      delivery_status: string | null;
      driver_id: string | null;
      lead_colors:
        | {
            quantity: number | null;
            colors: { name: string } | { name: string }[] | null;
          }[]
        | null;
    };
    const leadsExitRaw = (leadsExitResult.data ?? []) as RawLeadExit[];
    // Resolver nombres de chofer en una query (los que tengan driver_id).
    const exitDriverIds = Array.from(
      new Set(
        leadsExitRaw
          .map((l) => l.driver_id)
          .filter((id): id is string => !!id),
      ),
    );
    const driverNameByLead = new Map<string, string>();
    if (exitDriverIds.length > 0) {
      const { data: drivers } = await admin
        .from('profiles')
        .select('id, full_name')
        .in('id', exitDriverIds);
      for (const d of drivers ?? []) {
        driverNameByLead.set(d.id, d.full_name ?? '(sin nombre)');
      }
    }

    const leadsReadyToExit: LeadReadyToExit[] = leadsExitRaw.map((l) => ({
      id: l.id,
      client_name: l.client_name ?? '(sin nombre)',
      sale_date: l.sale_date,
      delivery_status:
        (l.delivery_status as 'pendiente' | 'en_transito') ?? 'pendiente',
      driver_name: l.driver_id
        ? driverNameByLead.get(l.driver_id) ?? null
        : null,
      colors: (l.lead_colors ?? [])
        .map((lc) => {
          const colorObj = Array.isArray(lc.colors) ? lc.colors[0] : lc.colors;
          return {
            color_name: colorObj?.name ?? '(sin nombre)',
            quantity: Number(lc.quantity ?? 0),
          };
        })
        .filter((c) => c.quantity > 0),
    }));

    return (
      <WarehouseClient
        initialStock={stockRows}
        initialMovements={movements}
        activeColors={activeColors}
        leadsReadyToExit={leadsReadyToExit}
      />
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al cargar almacén';
    console.error('[WarehousePage] excepción no controlada:', err);
    return <ErrorState message={message} />;
  }
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar el almacén</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </div>
  );
}
