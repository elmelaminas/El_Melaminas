/**
 * Helpers de formateo de fechas — TIMEZONE explícito CDMX.
 *
 * Por qué CDMX explícito:
 * Supabase guarda timestamps en UTC (`timestamptz`). Cuando llamamos
 * `new Date(iso).toLocaleString('es-MX')` SIN timezone, el browser/SSR
 * usa la TZ del entorno donde corre. En Vercel/Edge eso suele ser UTC,
 * lo que producía horas adelantadas 6h vs la realidad del negocio en
 * México (UTC-6 / UTC-5 con DST). Fijando `timeZone: 'America/Mexico_City'`
 * el resultado es estable entre cliente y servidor y refleja la hora
 * que el operador ve en su celular.
 *
 * Las funciones aceptan ISO strings o `null`/inválidas y devuelven `'—'`
 * para esos casos — defensivo contra movimientos sin `created_at` y
 * legacy data.
 *
 * Detección de fecha-pura (YYYY-MM-DD) en `formatDateCDMX`: cuando el
 * input no incluye hora, lo parseamos como hora local (mediodía local
 * de México) para evitar shifts de UTC que hacen aparecer "ayer".
 */

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Fecha + hora en TZ CDMX. Formato ejemplo: "25 may 2026, 03:14 p. m."
 * Usar para timestamps de movimientos, notificaciones, historial, etc.
 */
export function formatDateTimeCDMX(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Solo fecha en TZ CDMX. Formato ejemplo: "25 may 2026".
 * Acepta ISO timestamps y también fechas puras "YYYY-MM-DD" (campos
 * tipo DATE en DB — `sale_date`, `delivery_date`). Para fecha-pura no
 * pasamos timezone: la string no tiene hora UTC que convertir; tomamos
 * los componentes literales para evitar shifts.
 */
export function formatDateCDMX(iso: string | null): string {
  if (!iso) return '—';
  const m = DATE_ONLY_RE.exec(iso);
  if (m) {
    const [, y, mo, day] = m;
    // Construimos un Date local con esos componentes; al formatear sin
    // timezone se respeta el día tal cual viene en la string.
    const d = new Date(Number(y), Number(mo) - 1, Number(day));
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('es-MX', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('es-MX', {
    timeZone: 'America/Mexico_City',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Solo hora del día (HH:mm a/p. m.) en TZ CDMX. Usar para timestamps
 * que se muestran agrupados por día (ej. "Entregados hoy" del chofer)
 * donde la fecha ya es contexto y solo importa cuándo del día.
 */
export function formatTimeCDMX(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('es-MX', {
    timeZone: 'America/Mexico_City',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}
