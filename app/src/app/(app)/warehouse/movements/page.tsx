import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  MovementsClient,
  type MovementsRow,
  type ColorOption,
} from './movements-client';
import {
  MOVEMENT_TYPE_VALUES,
  MOVEMENT_TYPE_LABEL,
  type MovementType,
} from '../schema';

/**
 * Página /warehouse/movements — bitácora completa con filtros y paginación.
 *
 * Server Component: SELECT inventory_movements con joins a colors(name)
 * y profiles(full_name) ordenado por created_at DESC, paginado de 30 en 30.
 *
 * Filtros vía query params (bookmarkable):
 *   - type: movement_type
 *   - color: color_id
 *   - page: 1-indexed
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;

type RawSearchParams = {
  type?: string | string[];
  color?: string | string[];
  page?: string | string[];
};

function pickStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

function whitelistType(value: string): MovementType | '' {
  return (MOVEMENT_TYPE_VALUES as readonly string[]).includes(value)
    ? (value as MovementType)
    : '';
}

export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  try {
    const raw = await searchParams;
    const typeFilter = whitelistType(pickStr(raw.type));
    const colorFilter = pickStr(raw.color);
    const pageNumber = Math.max(1, Number(pickStr(raw.page)) || 1);

    const admin = supabaseAdmin();

    // Cargamos lista de colores activos para el dropdown del filtro.
    const colorsResult = await admin
      .from('colors')
      .select('id, name')
      .order('name');
    if (colorsResult.error) {
      return <ErrorState message={`Error leyendo colores: ${colorsResult.error.message}`} />;
    }
    const colorOptions: ColorOption[] = (colorsResult.data ?? []).map((c) => ({
      id: c.id,
      name: c.name,
    }));

    // Validar colorFilter contra la lista — uuid arbitrario lo descartamos.
    const validColor = colorOptions.some((c) => c.id === colorFilter)
      ? colorFilter
      : '';

    let query = admin
      .from('inventory_movements')
      .select(
        `id, movement_type, quantity, reference, unit_cost, created_at, registered_by, color_id, lead_id,
         colors ( name )`,
        { count: 'exact' },
      )
      .order('created_at', { ascending: false });

    if (typeFilter) query = query.eq('movement_type', typeFilter);
    if (validColor) query = query.eq('color_id', validColor);

    const start = (pageNumber - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE - 1;
    query = query.range(start, end);

    const { data, error, count } = await query;
    if (error) {
      return <ErrorState message={`Error leyendo movimientos: ${error.message}`} />;
    }

    type RawRow = {
      id: string;
      movement_type: string | null;
      quantity: number | null;
      reference: string | null;
      unit_cost: number | string | null;
      created_at: string | null;
      registered_by: string | null;
      color_id: string | null;
      lead_id: string | null;
      colors: { name: string } | { name: string }[] | null;
    };

    const rawRows = (data ?? []) as RawRow[];

    // Lookups paralelos: profiles para registered_by, leads para lead_id
    // (mostrar client_name en la tabla). Mismo patrón que warehouse/page.tsx
    // y /admin/caja: dos queries separadas en lugar de embedding múltiple
    // para evitar embedding ambiguity de PostgREST.
    const userIds = Array.from(
      new Set(
        rawRows
          .map((r) => r.registered_by)
          .filter((id): id is string => !!id),
      ),
    );
    const leadIds = Array.from(
      new Set(
        rawRows
          .map((r) => r.lead_id)
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

    const rows: MovementsRow[] = rawRows.map((r) => {
      const colorObj = Array.isArray(r.colors) ? r.colors[0] : r.colors;
      const mt = (r.movement_type ?? 'ajuste') as MovementType;
      return {
        id: r.id,
        movement_type: mt,
        movement_type_label: MOVEMENT_TYPE_LABEL[mt] ?? r.movement_type ?? '—',
        quantity: Number(r.quantity ?? 0),
        reference: r.reference,
        unit_cost: r.unit_cost == null ? null : Number(r.unit_cost),
        color_name: colorObj?.name ?? '(sin color)',
        client_name: r.lead_id
          ? clientNameByLead.get(r.lead_id) ?? null
          : null,
        created_at: r.created_at,
        registered_by_name: r.registered_by
          ? userNameById.get(r.registered_by) ?? '—'
          : '—',
      };
    });

    const total = count ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return (
      <MovementsClient
        movements={rows}
        total={total}
        page={pageNumber}
        pageSize={PAGE_SIZE}
        totalPages={totalPages}
        colors={colorOptions}
        filters={{ type: typeFilter, color: validColor }}
      />
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al cargar movimientos';
    console.error('[MovementsPage] excepción no controlada:', err);
    return <ErrorState message={message} />;
  }
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar los movimientos</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </div>
  );
}
