import { supabaseAdmin } from '@/lib/supabase/admin';
import { CatalogsClient, type SellerRow, type ColorRow } from './catalogs-client';

/**
 * Página /admin/catalogs.
 *
 * Server Component: lee `sellers`, `colors` e `inventory` con service_role
 * (consistente con `/admin/users`). Misma política de errores: TODO throw
 * se atrapa y se devuelve como `<ErrorState>` con mensaje legible — Next 16
 * sanitiza errores throw'eados desde Server Components a un digest genérico
 * en producción, así que sólo retornando texto del Server Component vemos
 * la causa real (env var faltante, RLS, etc.) en pantalla.
 *
 * Las suposiciones sobre la tabla `sellers` (no estaba en la captura del
 * DDL): columnas `id, name, phone, profile_id, is_active, created_at`. Si
 * alguna columna no existe, el SELECT fallará con un mensaje preciso de
 * Supabase ("column 'X' does not exist") y se renderizará en el banner.
 */
export const dynamic = 'force-dynamic';

export default async function AdminCatalogsPage() {
  try {
    const admin = supabaseAdmin();

    const [sellersResult, colorsResult, inventoryResult] = await Promise.all([
      admin
        .from('sellers')
        .select('id, name, phone, profile_id, is_active, created_at')
        .order('created_at', { ascending: false }),
      admin
        .from('colors')
        .select('id, name, is_active, created_at')
        .order('name', { ascending: true }),
      admin
        .from('inventory')
        .select('color_id, stock_total, stock_committed, stock_minimum'),
    ]);

    if (sellersResult.error) {
      return <ErrorState message={`Error leyendo sellers: ${sellersResult.error.message}`} />;
    }
    if (colorsResult.error) {
      return <ErrorState message={`Error leyendo colors: ${colorsResult.error.message}`} />;
    }
    if (inventoryResult.error) {
      return <ErrorState message={`Error leyendo inventory: ${inventoryResult.error.message}`} />;
    }

    // `inventory.color_id` es nullable en la DB — ignoramos filas huérfanas
    // al construir el índice por color, en vez de meter `null` como key.
    const inventoryByColorId = new Map<
      string,
      { stock_total: number; stock_committed: number; stock_minimum: number }
    >();
    for (const i of inventoryResult.data ?? []) {
      if (!i.color_id) continue;
      inventoryByColorId.set(i.color_id, {
        stock_total: Number(i.stock_total ?? 0),
        stock_committed: Number(i.stock_committed ?? 0),
        stock_minimum: Number(i.stock_minimum ?? 0),
      });
    }

    const sellers: SellerRow[] = (sellersResult.data ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      phone: s.phone ?? null,
      profile_id: s.profile_id ?? null,
      is_active: s.is_active ?? false,
    }));

    const colors: ColorRow[] = (colorsResult.data ?? []).map((c) => {
      const inv = inventoryByColorId.get(c.id);
      const total = inv?.stock_total ?? 0;
      const committed = inv?.stock_committed ?? 0;
      return {
        id: c.id,
        name: c.name,
        is_active: c.is_active ?? false,
        stock_total: total,
        stock_committed: committed,
        // `available` se computa, no se persiste — evita drift con `total`/`committed`.
        stock_available: Math.max(0, total - committed),
        stock_minimum: inv?.stock_minimum ?? 0,
        has_inventory_row: inv !== undefined,
      };
    });

    return <CatalogsClient initialSellers={sellers} initialColors={colors} />;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al cargar catálogos';
    console.error('[AdminCatalogsPage] excepción no controlada:', err);
    return <ErrorState message={message} />;
  }
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card p-6">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar catálogos</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </div>
  );
}
