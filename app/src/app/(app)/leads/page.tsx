import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  LeadsClient,
  type LeadRow,
  type FiltersState,
} from './leads-client';
import type { Channel, DeliveryStatus, PaymentStatus } from '@/data/mock';

/**
 * Página /leads — listado paginado con filtros bookmarkables vía URL.
 *
 * Server Component: ejecuta el SELECT con `supabaseAdmin()` (bypassa RLS,
 * consistente con /admin/users y /admin/catalogs). Pasa los rows a
 * `<LeadsClient>` que maneja la UI de filtros, debounced search y
 * paginación — al cambiar un filtro el cliente hace `router.push` con
 * nuevos query params y este Server Component re-corre.
 *
 * Política de errores idéntica al resto del proyecto: try/catch envolvente
 * + `<ErrorState>` con el message del throw, así errores de RLS, env vars
 * o queries son visibles en pantalla en lugar de un genérico
 * "couldn't load" sanitizado por Next.
 *
 * En Next 16 `searchParams` es un `Promise` — hay que `await`-earlo.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// Whitelists para validar query params del cliente. Si llega un valor
// fuera de esta lista (URL stale, manipulada, o errata de futuro) lo
// ignoramos — `.eq('channel', 'xxx')` con un valor no enum reventaría
// con error de Postgres.
const CHANNEL_VALUES = ['whatsapp', 'tiktok', 'google', 'tienda'] as const;
// `en_transito` SÍ existe en el enum DB pero NO se expone como opción
// del filtro: el dashboard linkea con `?delivery=pendiente` esperando ver
// ambos `pendiente` y `en_transito` (semántica de negocio: ambos son
// "no entregado"). El server interpreta `pendiente` como
// IN ('pendiente', 'en_transito') más abajo.
const DELIVERY_VALUES = ['pendiente', 'entregado', 'cancelado'] as const;
const PAYMENT_VALUES = [
  'pendiente',
  'parcial',
  'pagado',
  'cancelado',
] as const;

type RawSearchParams = {
  q?: string | string[];
  channel?: string | string[];
  delivery?: string | string[];
  payment?: string | string[];
  /** Mes 1-12 — si presente filtra `sale_date` por la ventana del mes. */
  mes?: string | string[];
  /** Año 4-dígitos — pareja de `mes`. Ambos deben venir juntos para filtrar. */
  anio?: string | string[];
  page?: string | string[];
};

/** Devuelve `value` si está en la lista, o `''` en caso contrario. */
function whitelist<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | '' {
  if (!value) return '';
  return (allowed as readonly string[]).includes(value) ? (value as T) : '';
}

/** Toma el primer valor si llega como array (Next acepta `?q=a&q=b`). */
function pickStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

/**
 * Sanitiza el término de búsqueda para que no rompa la sintaxis del
 * `.or()` de PostgREST. La sintaxis usa `,` como separador y `*`/`%` como
 * wildcards — un usuario que busque "Pérez, Juan" o "20%" haría queries
 * inválidas. Stripping es pragmático: pierde precisión (búsqueda por
 * substring sin esos chars) pero NO rompe.
 */
function sanitizeQuery(q: string): string {
  return q.replace(/[,%*\\()]/g, '').trim().slice(0, 80);
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  try {
    const raw = await searchParams;
    const qInput = sanitizeQuery(pickStr(raw.q));
    const channel = whitelist(pickStr(raw.channel), CHANNEL_VALUES);
    const delivery = whitelist(pickStr(raw.delivery), DELIVERY_VALUES);
    const payment = whitelist(pickStr(raw.payment), PAYMENT_VALUES);
    const pageNumber = Math.max(1, Number(pickStr(raw.page)) || 1);

    // Filtro mes/anio (ambos opcionales pero deben venir JUNTOS para
    // aplicar). Si solo viene uno, ignoramos los dos — evita comparaciones
    // contra ventanas inválidas. Drill-down típico desde /dashboard.
    const mesRaw = Number.parseInt(pickStr(raw.mes), 10);
    const anioRaw = Number.parseInt(pickStr(raw.anio), 10);
    const mes =
      Number.isFinite(mesRaw) && mesRaw >= 1 && mesRaw <= 12 ? mesRaw : 0;
    const anio =
      Number.isFinite(anioRaw) && anioRaw >= 2000 && anioRaw <= 2100
        ? anioRaw
        : 0;
    const monthFilterActive = mes > 0 && anio > 0;
    const startOfMonthDate = monthFilterActive
      ? new Date(Date.UTC(anio, mes - 1, 1)).toISOString().slice(0, 10)
      : null;
    const startOfNextMonthDate = monthFilterActive
      ? new Date(Date.UTC(anio, mes, 1)).toISOString().slice(0, 10)
      : null;

    const admin = supabaseAdmin();

    // Construimos la query con todos los filtros antes del range, para
    // que el `count: 'exact'` cuente solo los rows que cumplen los
    // filtros (no toda la tabla). PostgREST devuelve el count en el header
    // `Content-Range` que el cliente JS expone como `count`.
    let query = admin
      .from('leads')
      .select(
        `id, client_name, phone, channel, sheets_count, total_amount,
         sale_date, created_at, delivery_status, payment_status,
         sale_type, product_type, document_url, row_color,
         sellers ( name )`,
        { count: 'exact' },
      )
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (channel) query = query.eq('channel', channel);
    // `pendiente` semántico = "no entregado" → mostramos también
    // `en_transito` (que el filtro UI ya no expone como valor separado).
    if (delivery === 'pendiente') {
      query = query.in('delivery_status', ['pendiente', 'en_transito']);
    } else if (delivery) {
      query = query.eq('delivery_status', delivery);
    }
    if (payment) query = query.eq('payment_status', payment);
    if (monthFilterActive && startOfMonthDate && startOfNextMonthDate) {
      query = query
        .gte('sale_date', startOfMonthDate)
        .lt('sale_date', startOfNextMonthDate);
    }

    if (qInput) {
      // ilike usa `*` o `%` como wildcard; usamos `*` porque no requiere
      // escape adicional dentro de `.or()`.
      query = query.or(
        `client_name.ilike.*${qInput}*,phone.ilike.*${qInput}*`,
      );
    }

    const start = (pageNumber - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE - 1;
    query = query.range(start, end);

    const { data, error, count } = await query;
    if (error) {
      return (
        <ErrorState message={`Error leyendo leads: ${error.message}`} />
      );
    }

    // El typing del row con join es complejo en Supabase JS; usamos `any`
    // localmente para mantener legible. Si en el futuro generamos types
    // desde el schema (`supabase gen types`), reemplazamos con el tipo real.
    type RawRow = {
      id: string;
      client_name: string;
      phone: string | null;
      channel: string | null;
      sheets_count: number | null;
      total_amount: number | string | null;
      sale_date: string | null;
      created_at: string | null;
      delivery_status: string | null;
      payment_status: string | null;
      sale_type: string | null;
      product_type: string | null;
      document_url: string | null;
      row_color: string | null;
      sellers: { name: string } | { name: string }[] | null;
    };

    const rows: LeadRow[] = ((data ?? []) as RawRow[]).map((r) => ({
      id: r.id,
      client_name: r.client_name,
      phone: r.phone ?? '',
      // DB enum es lowercase; el badge `<ChannelBadge>` espera uppercase
      // (mock.Channel = 'WHATSAPP' | ...). Mapeamos aquí para no tocar el
      // type de mock (lo consumen otros archivos con datos uppercase).
      channel: ((r.channel as string) ?? '').toUpperCase() as Channel,
      // PostgREST puede devolver el join como objeto o como array según
      // el tipo de relación; manejamos ambas formas.
      seller_name: Array.isArray(r.sellers)
        ? r.sellers[0]?.name ?? null
        : r.sellers?.name ?? null,
      sheets_count: Number(r.sheets_count ?? 0),
      total_amount: Number(r.total_amount ?? 0),
      sale_date: r.sale_date,
      created_at: r.created_at,
      delivery_status: (r.delivery_status as DeliveryStatus) ?? 'pendiente',
      payment_status: (r.payment_status as PaymentStatus) ?? 'pendiente',
      sale_type: r.sale_type,
      product_type: r.product_type,
      document_url: r.document_url,
      row_color: r.row_color,
    }));

    // Detección de "contra_entrega": un lead se marca naranja si AL MENOS
    // un pago suyo tiene payment_type='contra_entrega'. Hacemos una sola
    // query bulk para los lead_ids visibles en esta página (no toda la
    // tabla) — costo O(rows). Si la query falla, loguamos y dejamos el
    // Set vacío (fail-soft: la fila simplemente no pintará naranja).
    const visibleLeadIds = rows.map((r) => r.id);
    const contraEntregaSet = new Set<string>();
    if (visibleLeadIds.length > 0) {
      const { data: ceData, error: ceErr } = await admin
        .from('payments')
        .select('lead_id')
        .eq('payment_type', 'contra_entrega')
        .in('lead_id', visibleLeadIds);
      if (ceErr) {
        console.error(
          '[LeadsPage] contra_entrega lookup falló (no fatal):',
          ceErr,
        );
      } else {
        for (const p of ceData ?? []) {
          if (p.lead_id) contraEntregaSet.add(p.lead_id);
        }
      }
    }
    // Pasamos un array al cliente (Sets serializan con RSC en React 19
    // pero array es más portable y consistente con otros bulk-lookups
    // del proyecto). El cliente reconstruye el Set con useMemo.
    const contraEntregaLeadIds = Array.from(contraEntregaSet);

    const total = count ?? 0;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const filters: FiltersState = {
      q: qInput,
      channel,
      delivery,
      payment,
      mes: monthFilterActive ? mes : 0,
      anio: monthFilterActive ? anio : 0,
    };

    return (
      <LeadsClient
        leads={rows}
        total={total}
        page={pageNumber}
        pageSize={PAGE_SIZE}
        totalPages={totalPages}
        filters={filters}
        contraEntregaLeadIds={contraEntregaLeadIds}
      />
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al cargar leads';
    console.error('[LeadsPage] excepción no controlada:', err);
    return <ErrorState message={message} />;
  }
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar los leads</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </div>
  );
}
