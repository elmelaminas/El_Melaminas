import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  EditLeadForm,
  type EditLeadFormData,
} from './edit-form';
import type {
  SellerOption,
  ColorOption,
  DriverOption,
} from '../../new/new-lead-form';

/**
 * Página /leads/[id]/edit — admin edita TODOS los campos del lead.
 *
 * SELECTs en paralelo:
 *   1. profile del user logueado (verificar role=admin).
 *   2. lead con todos sus campos editables.
 *   3. lead_colors del lead (cantidad por color).
 *   4. sellers activos.
 *   5. colors activos.
 *   6. drivers activos (más, si el lead apunta a uno inactivo lo
 *      añadimos al final para que el select no quede desincronizado).
 *
 * Triple defensa de acceso: middleware → este page → server action.
 * El page rechaza con ErrorState ANTES de renderizar el form si el
 * caller no es admin.
 *
 * Bloqueos visibles desde el page (no solo desde el action):
 *   - lead.deleted_at != NULL → cancelado.
 *   - delivery_status === 'entregado' o 'cancelado' → ya cerró.
 * El form igual se renderiza para casos edge, pero el action rechazará
 * con mensaje claro si llega a enviarse.
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

    const [
      profileResult,
      leadResult,
      lcResult,
      sellersResult,
      colorsResult,
      driversResult,
    ] = await Promise.all([
      admin
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle(),
      admin
        .from('leads')
        .select(
          `id, client_name, phone, address, maps_url, channel, seller_id,
           sale_place, sale_type, sale_date, purchase_type, product_type,
           cost_per_sheet, cuts_count, edge_banding_type,
           edge_banding_meters, driver_id, document_url, document_urls,
           delivery_status, deleted_at`,
        )
        .eq('id', id)
        .maybeSingle(),
      admin
        .from('lead_colors')
        .select('color_id, quantity, cost_per_sheet')
        .eq('lead_id', id),
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
    if (
      profileResult.data?.role !== 'admin' &&
      profileResult.data?.role !== 'admin2'
    ) {
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
    if (leadResult.data.deleted_at) {
      return (
        <ErrorState message="Este lead está cancelado y no se puede editar." />
      );
    }
    if (leadResult.data.delivery_status === 'entregado') {
      return (
        <ErrorState message="Este lead ya fue entregado y no se puede editar." />
      );
    }
    if (lcResult.error) {
      return (
        <ErrorState
          message={`Error leyendo colores del lead: ${lcResult.error.message}`}
        />
      );
    }
    if (sellersResult.error) {
      return (
        <ErrorState
          message={`Error leyendo sellers: ${sellersResult.error.message}`}
        />
      );
    }
    if (colorsResult.error) {
      return (
        <ErrorState
          message={`Error leyendo colors: ${colorsResult.error.message}`}
        />
      );
    }
    if (driversResult.error) {
      return (
        <ErrorState
          message={`Error leyendo choferes: ${driversResult.error.message}`}
        />
      );
    }

    const sellers: SellerOption[] = (sellersResult.data ?? []).map((s) => ({
      id: s.id,
      name: s.name,
    }));
    const colors: ColorOption[] = (colorsResult.data ?? []).map((c) => ({
      id: c.id,
      name: c.name,
    }));
    const drivers: DriverOption[] = (driversResult.data ?? []).map((d) => ({
      id: d.id,
      name: d.full_name ?? '(sin nombre)',
    }));

    // Lead con chofer inactivo: agregarlo al final para que el select
    // no muestre value disconnect. Mismo patrón que tenía el editor
    // anterior cuando solo era 2 campos.
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

    // Si seller asignado al lead está inactivo, lo añadimos también.
    const currentSellerId = leadResult.data.seller_id ?? '';
    if (currentSellerId && !sellers.some((s) => s.id === currentSellerId)) {
      const { data: inactive } = await admin
        .from('sellers')
        .select('name')
        .eq('id', currentSellerId)
        .maybeSingle();
      if (inactive) {
        sellers.push({
          id: currentSellerId,
          name: `${inactive.name ?? '(sin nombre)'} (inactivo)`,
        });
      }
    }

    // lead_colors → array de { color_id, quantity, new_name, cost_per_sheet }
    // que el form espera. Filtramos por quantity > 0 por seguridad.
    //
    // `cost_per_sheet`: para leads antiguos creados antes de la
    // migración, `lead_colors.cost_per_sheet` es null. En ese caso
    // caemos al `leads.cost_per_sheet` legacy. Si ese tampoco es un
    // valor válido del catálogo (350/600/2200), default a 350.
    const ALLOWED_COSTS = [350, 600, 2200] as const;
    const legacyLeadCost = Number(leadResult.data.cost_per_sheet ?? 350);
    const fallbackCost: 350 | 600 | 2200 = (
      ALLOWED_COSTS as readonly number[]
    ).includes(legacyLeadCost)
      ? (legacyLeadCost as 350 | 600 | 2200)
      : 350;
    type RawLc = {
      color_id: string;
      quantity: number;
      cost_per_sheet: number | null;
    };
    const leadColors = (lcResult.data ?? [])
      .filter(
        (r): r is RawLc =>
          !!r.color_id && Number(r.quantity ?? 0) > 0,
      )
      .map((r) => {
        const rawCost =
          r.cost_per_sheet == null
            ? fallbackCost
            : Number(r.cost_per_sheet);
        const cost = (ALLOWED_COSTS as readonly number[]).includes(rawCost)
          ? (rawCost as 350 | 600 | 2200)
          : fallbackCost;
        return {
          color_id: r.color_id,
          quantity: Number(r.quantity),
          new_name: '',
          cost_per_sheet: cost,
        };
      });

    // `lead-documents` es bucket PÚBLICO — la URL guardada funciona
    // directo en el browser. Si en el futuro se cambia a privado,
    // habría que pasar por signEvidenceUrl como en payments-evidence.
    // Normalizamos document_urls como array siempre; si es null o no es
    // array (DB no migrada), filtramos nulos por defensa.
    const rawUrls = leadResult.data.document_urls;
    const initialDocumentUrls: string[] = Array.isArray(rawUrls)
      ? rawUrls.filter((u): u is string => typeof u === 'string' && !!u)
      : [];

    const formData: EditLeadFormData = {
      leadId: leadResult.data.id,
      initialDocumentUrl: leadResult.data.document_url ?? null,
      initialDocumentUrls,
      initialValues: {
        client_name: leadResult.data.client_name ?? '',
        phone: leadResult.data.phone ?? '',
        address: leadResult.data.address ?? '',
        maps_url: leadResult.data.maps_url ?? '',
        channel:
          (leadResult.data.channel as
            | 'whatsapp'
            | 'tiktok'
            | 'google'
            | 'tienda') ?? 'whatsapp',
        seller_id: leadResult.data.seller_id ?? '',
        driver_id: leadResult.data.driver_id ?? '',
        sale_place:
          (leadResult.data.sale_place as 'online' | 'en_fabrica') ?? 'online',
        sale_type:
          (leadResult.data.sale_type as
            | 'primer_contacto'
            | 'recompra'
            | 'seguimiento'
            | 'venta_empleado') ?? 'primer_contacto',
        sale_date: leadResult.data.sale_date ?? '',
        purchase_type:
          (leadResult.data.purchase_type as 'domicilio' | 'fabrica') ??
          'domicilio',
        product_type:
          (leadResult.data.product_type as 'con_corte' | 'sin_corte') ??
          'con_corte',
        cuts_count:
          leadResult.data.cuts_count == null
            ? null
            : Number(leadResult.data.cuts_count),
        edge_banding_type:
          (leadResult.data.edge_banding_type as '' | '19mm' | '3.5mm') ?? '',
        edge_banding_meters:
          leadResult.data.edge_banding_meters == null
            ? null
            : Number(leadResult.data.edge_banding_meters),
        colors: leadColors,
      },
    };

    return (
      <EditLeadForm
        formData={formData}
        sellers={sellers}
        colors={colors}
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
