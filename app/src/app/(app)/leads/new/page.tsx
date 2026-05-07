import { supabaseAdmin } from '@/lib/supabase/admin';
import { NewLeadForm, type SellerOption, type ColorOption } from './new-lead-form';

/**
 * Página /leads/new.
 *
 * Server Component: lee `sellers` activos y `colors` activos de Supabase
 * (con service_role para bypassar RLS, consistente con /admin/users y
 * /admin/catalogs). Pasa al Client Component `<NewLeadForm>` que tiene
 * toda la lógica de formulario.
 *
 * Política de errores idéntica a /admin/users y /admin/catalogs: TODO throw
 * se atrapa y devuelve `<ErrorState>` con mensaje legible para que la
 * causa sea visible en pantalla (Next 16 sanitiza throws desde Server
 * Components a digest genérico en producción).
 */
export const dynamic = 'force-dynamic';

export default async function NewLeadPage() {
  try {
    const admin = supabaseAdmin();

    const [sellersResult, colorsResult] = await Promise.all([
      admin
        .from('sellers')
        .select('id, name')
        .eq('is_active', true)
        .order('name', { ascending: true }),
      admin
        .from('colors')
        .select('id, name')
        .eq('is_active', true)
        .order('name', { ascending: true }),
    ]);

    if (sellersResult.error) {
      return <ErrorState message={`Error leyendo sellers: ${sellersResult.error.message}`} />;
    }
    if (colorsResult.error) {
      return <ErrorState message={`Error leyendo colors: ${colorsResult.error.message}`} />;
    }

    const sellers: SellerOption[] = (sellersResult.data ?? []).map((s) => ({
      id: s.id,
      name: s.name,
    }));
    const colors: ColorOption[] = (colorsResult.data ?? []).map((c) => ({
      id: c.id,
      name: c.name,
    }));

    return <NewLeadForm sellers={sellers} colors={colors} />;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al cargar formulario';
    console.error('[NewLeadPage] excepción no controlada:', err);
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
