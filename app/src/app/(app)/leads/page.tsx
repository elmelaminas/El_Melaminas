import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  LeadsClient,
  type LeadRow,
  type FiltersState,
} from './leads-client';
import type { Channel, DeliveryStatus, PaymentStatus } from '@/data/mock';
import { getDateWindow } from '../dashboard/constants';

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

// Filtro por color de fila (tabs encima de la tabla). Valores cubren
// los 4 automáticos + 2 manuales. 'all' / vacío = sin filtro.
const COLOR_FILTER_VALUES = [
  'all',
  'azul',
  'rosa',
  'naranja',
  'amarillo',
  'verde',
  'morado',
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
  /** Periodo del dashboard ('dia' | 'semana' | 'mes'). Cuando viene con
   *  `fecha` toma prioridad sobre `mes`/`anio` y filtra `sale_date` por
   *  la ventana correspondiente. */
  periodo?: string | string[];
  /** Fecha del dashboard YYYY-MM-DD. Sin `periodo` se ignora. */
  fecha?: string | string[];
  page?: string | string[];
  /** Tab de color (ver COLOR_FILTER_VALUES). 'all' o vacío = sin filtro. */
  color_filter?: string | string[];
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
    const colorFilterRaw = whitelist(pickStr(raw.color_filter), COLOR_FILTER_VALUES);
    // 'all' y '' son equivalentes (sin filtro). Normalizamos a '' para
    // simplificar el ramo `if (colorFilter)` abajo.
    const colorFilter: '' | Exclude<typeof colorFilterRaw, 'all' | ''> =
      colorFilterRaw === 'all' || colorFilterRaw === ''
        ? ''
        : (colorFilterRaw as Exclude<typeof colorFilterRaw, 'all' | ''>);
    const pageNumber = Math.max(1, Number(pickStr(raw.page)) || 1);

    // Filtro de fecha — dos formas válidas (drill-down desde /dashboard):
    //   1. `periodo` + `fecha` (nuevo): día/semana/mes con fecha exacta.
    //   2. `mes` + `anio` (legacy): se mantiene por backwards-compat con
    //      links viejos. Si vienen ambas formas, `periodo` gana.
    //
    // `filters.mes` / `filters.anio` se siguen exponiendo al cliente
    // para que el chip "Mes: may/2026" funcione cuando la ventana coincide
    // con un mes calendario. Para 'dia' / 'semana' el chip queda en 0
    // (no representable como un solo mes) — el rango sigue aplicándose
    // al query, pero el chip no aparece y los filtros del cliente
    // no preservan la ventana si el usuario cambia otro filtro.
    const periodoRaw = pickStr(raw.periodo);
    const fechaRaw = pickStr(raw.fecha);
    const usePeriodFilter =
      (periodoRaw === 'dia' || periodoRaw === 'semana' || periodoRaw === 'mes') &&
      fechaRaw.length > 0;

    let mes = 0;
    let anio = 0;
    let rangeStartDate: string | null = null;
    let rangeEndDateInclusive: string | null = null;

    if (usePeriodFilter) {
      const window = getDateWindow(periodoRaw, fechaRaw);
      rangeStartDate = window.startDate;
      rangeEndDateInclusive = window.endDate;
      if (window.periodo === 'mes') {
        const [yStr, mStr] = window.fecha.split('-');
        mes = Number(mStr);
        anio = Number(yStr);
      }
    } else {
      const mesRaw = Number.parseInt(pickStr(raw.mes), 10);
      const anioRaw = Number.parseInt(pickStr(raw.anio), 10);
      mes =
        Number.isFinite(mesRaw) && mesRaw >= 1 && mesRaw <= 12 ? mesRaw : 0;
      anio =
        Number.isFinite(anioRaw) && anioRaw >= 2000 && anioRaw <= 2100
          ? anioRaw
          : 0;
      if (mes > 0 && anio > 0) {
        rangeStartDate = new Date(Date.UTC(anio, mes - 1, 1))
          .toISOString()
          .slice(0, 10);
        // Último día del mes (inclusive) para parear con la nueva
        // semántica `<= rangeEndDateInclusive`.
        const lastDay = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
        rangeEndDateInclusive = `${anio}-${String(mes).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      }
    }
    const monthFilterActive = rangeStartDate !== null && rangeEndDateInclusive !== null;

    const admin = supabaseAdmin();

    // Rol del usuario actual: lo necesitamos en el cliente para gatear
    // el botón "Eliminar lead" (solo admin/admin2). Best-effort: si
    // falla, caemos a string vacío y el botón queda oculto.
    let currentUserRole = '';
    try {
      const userClient = await supabaseServer();
      const {
        data: { user },
      } = await userClient.auth.getUser();
      if (user) {
        const { data: profileRow } = await admin
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .maybeSingle();
        currentUserRole = (profileRow?.role as string) ?? '';
      }
    } catch (e) {
      console.error('[LeadsPage] role lookup falló (no fatal):', e);
    }

    // Construimos la query con todos los filtros antes del range, para
    // que el `count: 'exact'` cuente solo los rows que cumplen los
    // filtros (no toda la tabla). PostgREST devuelve el count en el header
    // `Content-Range` que el cliente JS expone como `count`.
    let query = admin
      .from('leads')
      .select(
        `id, client_name, phone, channel, sheets_count, total_amount,
         sale_date, created_at, delivery_status, payment_status,
         sale_type, product_type, purchase_type, document_url, document_urls, row_color,
         has_hojas, has_cubrecanto, has_catalogo, extra_costs,
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
    if (monthFilterActive && rangeStartDate && rangeEndDateInclusive) {
      query = query
        .gte('sale_date', rangeStartDate)
        .lte('sale_date', rangeEndDateInclusive);
    }

    if (qInput) {
      // ilike usa `*` o `%` como wildcard; usamos `*` porque no requiere
      // escape adicional dentro de `.or()`.
      query = query.or(
        `client_name.ilike.*${qInput}*,phone.ilike.*${qInput}*`,
      );
    }

    // Filtro por color (tab). Cada color combina su REGLA AUTOMÁTICA
    // con el match manual `row_color = X`. Naranja necesita un pre-query
    // para obtener los lead_ids con pago contra_entrega — un set pequeño
    // en la práctica (negocio típico).
    if (colorFilter === 'azul') {
      query = query.or('product_type.eq.con_corte,row_color.eq.azul');
    } else if (colorFilter === 'rosa') {
      query = query.or('sale_type.eq.venta_empleado,row_color.eq.rosa');
    } else if (colorFilter === 'amarillo') {
      // 2026-05 (rev2): amarillo es 100% manual ("Pagado pero no
      // entregado", asignado por el admin con el picker). Sin regla
      // automática asociada.
      query = query.eq('row_color', 'amarillo');
    } else if (colorFilter === 'naranja') {
      // Pre-query: lead_ids con AL MENOS un pago contra_entrega. Set
      // limitado en la práctica; si crece a miles, considerar moverlo
      // a un VIEW en Postgres con índice.
      //
      // Manejo defensivo: si el enum `payment_type_enum` aún no tiene
      // 'contra_entrega' (migración pendiente o schema cache stale en
      // PostgREST), la query devuelve error. Lo tratamos como
      // no-fatal — el filtro pierde precisión (no resaltamos por la
      // regla automática) pero la página sigue funcionando con el
      // override manual `row_color='naranja'`.
      let ceIds: string[] = [];
      try {
        const { data: ceLeads, error: ceErr } = await admin
          .from('payments')
          .select('lead_id')
          .eq('payment_type', 'contra_entrega');
        if (ceErr) {
          console.error(
            '[LeadsPage] naranja contra_entrega lookup falló (no fatal):',
            ceErr,
          );
        } else {
          ceIds = Array.from(
            new Set(
              (ceLeads ?? [])
                .map((p) => p.lead_id)
                .filter((x): x is string => !!x),
            ),
          );
        }
      } catch (e) {
        console.error(
          '[LeadsPage] naranja contra_entrega excepción (no fatal):',
          e,
        );
      }
      if (ceIds.length > 0) {
        // `id.in.(uuid1,uuid2,...)` dentro de `.or()`. PostgREST acepta
        // UUIDs sin comillas dentro de `()`.
        query = query.or(`row_color.eq.naranja,id.in.(${ceIds.join(',')})`);
      } else {
        query = query.eq('row_color', 'naranja');
      }
    } else if (colorFilter === 'verde') {
      query = query.eq('row_color', 'verde');
    } else if (colorFilter === 'morado') {
      query = query.eq('row_color', 'morado');
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
      purchase_type: string | null;
      document_url: string | null;
      document_urls: string[] | null;
      row_color: string | null;
      has_hojas: boolean | null;
      has_cubrecanto: boolean | null;
      has_catalogo: boolean | null;
      extra_costs: unknown | null;
      sellers: { name: string } | { name: string }[] | null;
    };

    const rows: LeadRow[] = ((data ?? []) as RawRow[]).map((r) => {
      // Fusión document_url (legacy single) + document_urls (array
      // nuevo). Si document_urls trae al menos un elemento usamos esa
      // lista; si está vacía y existe document_url, lo envolvemos en
      // un array para que el cliente lo trate uniformemente. Si no
      // hay nada, array vacío.
      const urls = Array.isArray(r.document_urls)
        ? r.document_urls.filter((u): u is string => !!u)
        : [];
      const merged =
        urls.length > 0 ? urls : r.document_url ? [r.document_url] : [];
      return {
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
        purchase_type: r.purchase_type,
        document_url: r.document_url,
        document_urls: merged,
        row_color: r.row_color,
        // Tipos del pedido (CAMBIO 1). Legacy leads sin las columnas
        // caen a null → tratado como false en el cliente. Como
        // fallback razonable, si el lead tiene sheets_count > 0 lo
        // mostramos como has_hojas=true aunque la columna sea null
        // (era el comportamiento implícito antes del refactor).
        has_hojas:
          r.has_hojas == null
            ? Number(r.sheets_count ?? 0) > 0
            : Boolean(r.has_hojas),
        has_cubrecanto: Boolean(r.has_cubrecanto),
        has_catalogo: Boolean(r.has_catalogo),
        // Cantidad de costos extras del lead. Lo usamos para mostrar
        // un badge "💰 +extras" junto al nombre en la tabla. Sólo
        // contamos filas con amount>0 y descripción no vacía (las
        // filas zombie de migraciones viejas no cuentan).
        extra_costs_count: Array.isArray(r.extra_costs)
          ? (r.extra_costs as unknown[]).filter((e) => {
              if (!e || typeof e !== 'object') return false;
              const obj = e as { description?: unknown; amount?: unknown };
              const desc =
                typeof obj.description === 'string'
                  ? obj.description.trim()
                  : '';
              const amt = Number(obj.amount ?? 0);
              return desc.length > 0 && amt > 0;
            }).length
          : 0,
      };
    });

    // Detección de "contra_entrega": un lead se marca naranja si AL MENOS
    // un pago suyo tiene payment_type='contra_entrega'. Hacemos una sola
    // query bulk para los lead_ids visibles en esta página (no toda la
    // tabla) — costo O(rows). Si la query falla (ej: enum sin el valor
    // 'contra_entrega' en algunos entornos, o schema cache stale en
    // PostgREST), loguamos y dejamos el Set vacío (fail-soft: la fila
    // simplemente no pintará naranja).
    const visibleLeadIds = rows.map((r) => r.id);
    const contraEntregaSet = new Set<string>();
    if (visibleLeadIds.length > 0) {
      try {
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
      } catch (e) {
        console.error(
          '[LeadsPage] contra_entrega excepción (no fatal):',
          e,
        );
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
      color_filter: colorFilter,
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
        currentUserRole={currentUserRole}
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
