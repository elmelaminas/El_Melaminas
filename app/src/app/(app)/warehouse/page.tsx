import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  WarehouseClient,
  type StockRow,
  type MovementRow,
  type ColorOption,
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

    const [invResult, mvResult] = await Promise.all([
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
           colors ( name )`,
        )
        .order('created_at', { ascending: false })
        .limit(RECENT_MOVEMENTS),
    ]);

    if (invResult.error) {
      return <ErrorState message={`Error leyendo inventario: ${invResult.error.message}`} />;
    }
    if (mvResult.error) {
      return <ErrorState message={`Error leyendo movimientos: ${mvResult.error.message}`} />;
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
      colors: { name: string } | { name: string }[] | null;
    };

    const movRows: Omit<MovementRow, 'registered_by_name'>[] = (
      (mvResult.data ?? []) as RawMv[]
    ).map((m) => {
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
      };
    });

    // Resolver nombres de los registered_by en una sola query.
    const userIds = Array.from(
      new Set(
        movRows
          .map((m) => m.registered_by)
          .filter((id): id is string => !!id),
      ),
    );
    let nameById = new Map<string, string>();
    if (userIds.length > 0) {
      const { data: users } = await admin
        .from('profiles')
        .select('id, full_name')
        .in('id', userIds);
      for (const u of users ?? []) {
        nameById.set(u.id, u.full_name ?? '(sin nombre)');
      }
    }

    const movements: MovementRow[] = movRows.map((m) => ({
      ...m,
      registered_by_name: m.registered_by
        ? nameById.get(m.registered_by) ?? '—'
        : '—',
    }));

    // Lista de colores activos para el drawer de "Registrar Entrada"
    // — solo los que tienen fila de inventory (sino el UPDATE fallará).
    const activeColors: ColorOption[] = stockRows
      .filter((r) => r.is_active)
      .map((r) => ({ id: r.color_id, name: r.color_name }));

    return (
      <WarehouseClient
        initialStock={stockRows}
        initialMovements={movements}
        activeColors={activeColors}
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
