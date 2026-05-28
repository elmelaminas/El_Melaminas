/**
 * Constantes neutras compartidas entre el Server Component (page.tsx) y
 * el Client Component (dashboard-client.tsx).
 *
 * Vive en su propio archivo SIN `'use client'` ni `'use server'` porque
 * los exports no-función de un módulo `'use client'` son referencias
 * opacas vistas desde un Server Component (Next 16 RSC los serializa
 * para el bundle del cliente y el server no puede leerlos como valores).
 *
 * Helpers de ventana de fechas (`getDateWindow`, `getMondayOfWeek`,
 * `getSundayOfWeek`, `addDays`, `addMonths`, `todayInCDMX`,
 * `normalizePeriodo`, `normalizeFecha`) son TZ-aware: México abolió DST
 * en 2022, así que CDMX queda fijo en UTC-6 y las fechas-puras
 * "YYYY-MM-DD" se anclan a media noche `-06:00` para evitar drift de 6h
 * que confundiría al filtro por día.
 */

export const MES_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Enero' },
  { value: 2, label: 'Febrero' },
  { value: 3, label: 'Marzo' },
  { value: 4, label: 'Abril' },
  { value: 5, label: 'Mayo' },
  { value: 6, label: 'Junio' },
  { value: 7, label: 'Julio' },
  { value: 8, label: 'Agosto' },
  { value: 9, label: 'Septiembre' },
  { value: 10, label: 'Octubre' },
  { value: 11, label: 'Noviembre' },
  { value: 12, label: 'Diciembre' },
];

export const MES_LABEL: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(MES_OPTIONS.map((m) => [m.value, m.label])),
);

export type SaleType =
  | ''
  | 'primer_contacto'
  | 'recompra'
  | 'seguimiento'
  | 'venta_empleado';

/** Opciones del filtro de tipo de venta (dashboard + /leads). El primer
 *  valor con `value=''` representa "todos" — el server no aplica
 *  `.eq('sale_type', …)` en ese caso. */
export const SALE_TYPE_OPTIONS: readonly { value: SaleType; label: string }[] = [
  { value: '', label: 'Todos los tipos' },
  { value: 'primer_contacto', label: 'Primer contacto' },
  { value: 'recompra', label: 'Recompra' },
  { value: 'seguimiento', label: 'Seguimiento' },
  { value: 'venta_empleado', label: 'Venta empleado' },
];

/** Sufijo para el subtitle cuando hay tipo de venta activo. Plural/
 *  contextual donde aplica para que lea natural junto al periodo
 *  ("Métricas de Mayo 2026 — Recompras"). */
export const SALE_TYPE_SUBTITLE: Readonly<Record<string, string>> = Object.freeze({
  primer_contacto: 'Primer contacto',
  recompra: 'Recompras',
  seguimiento: 'Seguimientos',
  venta_empleado: 'Ventas a empleados',
});

const SALE_TYPE_VALUE_SET: readonly string[] = SALE_TYPE_OPTIONS
  .map((o) => o.value)
  .filter((v) => v !== '');

export function normalizeSaleType(input: string | undefined | null): SaleType {
  if (!input) return '';
  return SALE_TYPE_VALUE_SET.includes(input) ? (input as SaleType) : '';
}

const MES_SHORT_LABEL: Readonly<Record<number, string>> = Object.freeze({
  1: 'ene', 2: 'feb', 3: 'mar', 4: 'abr', 5: 'may', 6: 'jun',
  7: 'jul', 8: 'ago', 9: 'sep', 10: 'oct', 11: 'nov', 12: 'dic',
});

export type Periodo = 'dia' | 'semana' | 'mes';

const CDMX_OFFSET = '-06:00';
const FECHA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function ymdFromUTCDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** YYYY-MM-DD del día actual en CDMX (no del entorno donde corre el SSR). */
export function todayInCDMX(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function normalizePeriodo(
  input: string | undefined | null,
): Periodo {
  return input === 'dia' || input === 'semana' || input === 'mes'
    ? input
    : 'mes';
}

/**
 * Valida "YYYY-MM-DD" como fecha real (rechaza Feb 30, etc.). Si la
 * entrada es inválida, devuelve hoy CDMX. Defensa contra URLs
 * manipuladas — el dashboard debe seguir cargando con un default
 * razonable, no romper.
 */
export function normalizeFecha(input: string | undefined | null): string {
  if (!input) return todayInCDMX();
  const m = FECHA_RE.exec(input);
  if (!m) return todayInCDMX();
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return todayInCDMX();
  const obj = new Date(`${input}T00:00:00${CDMX_OFFSET}`);
  if (Number.isNaN(obj.getTime())) return todayInCDMX();
  if (obj.getUTCMonth() + 1 !== mo || obj.getUTCDate() !== d) {
    return todayInCDMX();
  }
  return input;
}

/** "YYYY-MM-DD" → Date anclado a medianoche CDMX (= 06:00 UTC). */
function parseCDMXDate(fecha: string): Date {
  return new Date(`${fecha}T00:00:00${CDMX_OFFSET}`);
}

/** Lunes de la semana que contiene la fecha (en contexto CDMX). */
export function getMondayOfWeek(fecha: string): string {
  const d = parseCDMXDate(fecha);
  // Anclado a medianoche CDMX, getUTCDay coincide con día-de-semana CDMX.
  const dow = d.getUTCDay();
  const back = dow === 0 ? 6 : dow - 1; // Domingo (0) retrocede 6 días.
  d.setUTCDate(d.getUTCDate() - back);
  return ymdFromUTCDate(d);
}

/** Domingo de la semana que contiene la fecha. */
export function getSundayOfWeek(fecha: string): string {
  const monday = getMondayOfWeek(fecha);
  const d = parseCDMXDate(monday);
  d.setUTCDate(d.getUTCDate() + 6);
  return ymdFromUTCDate(d);
}

/** Suma `days` (puede ser negativo) a una fecha YYYY-MM-DD. */
export function addDays(fecha: string, days: number): string {
  const d = parseCDMXDate(fecha);
  d.setUTCDate(d.getUTCDate() + days);
  return ymdFromUTCDate(d);
}

/**
 * Suma `months` (puede ser negativo) a una fecha YYYY-MM-DD,
 * clamp-eando el día al último válido del mes destino (31 ene + 1 mes
 * = 28/29 feb).
 */
export function addMonths(fecha: string, months: number): string {
  const [yStr, mStr, dStr] = fecha.split('-');
  let y = Number(yStr);
  let m = Number(mStr) + months;
  let d = Number(dStr);
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1) { m += 12; y -= 1; }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > lastDay) d = lastDay;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export type DateWindow = {
  /** YYYY-MM-DD inclusive — para columnas DATE (sale_date). */
  startDate: string;
  /** YYYY-MM-DD inclusive — para columnas DATE. */
  endDate: string;
  /** ISO timestamp inclusive — para columnas timestamptz (paid_at, created_at). */
  startIso: string;
  /** ISO timestamp EXCLUSIVE — primer instante del día posterior a endDate. */
  endIso: string;
  /** Label corto para chip/header ("Hoy, 25 may 2026", "Mayo 2026"). */
  label: string;
  /** Label largo para subtitle ("Métricas de Mayo 2026"). */
  subtitleLabel: string;
  /** Periodo normalizado. */
  periodo: Periodo;
  /** Fecha normalizada (puede no coincidir con la input si vino inválida). */
  fecha: string;
};

function diaLabels(fecha: string): { label: string; subtitle: string } {
  const today = todayInCDMX();
  const [y, m, d] = fecha.split('-');
  const dayN = Number(d);
  const monthN = Number(m);
  const short = `${dayN} ${MES_SHORT_LABEL[monthN] ?? '—'} ${y}`;
  const long = `${dayN} de ${(MES_LABEL[monthN] ?? '').toLowerCase()} ${y}`;
  return {
    label: fecha === today ? `Hoy, ${short}` : short,
    subtitle: `Métricas del ${long}`,
  };
}

function semanaLabels(
  startDate: string,
  endDate: string,
): { label: string; subtitle: string } {
  const [, smStr, sdStr] = startDate.split('-');
  const [eyStr, emStr, edStr] = endDate.split('-');
  const sm = Number(smStr);
  const sd = Number(sdStr);
  const em = Number(emStr);
  const ed = Number(edStr);
  const year = eyStr;
  const sameMonth = sm === em;
  const shortStart = sameMonth ? `${sd}` : `${sd} ${MES_SHORT_LABEL[sm] ?? ''}`;
  const shortEnd = `${ed} ${MES_SHORT_LABEL[em] ?? ''}`;
  const longStart = sameMonth
    ? `${sd}`
    : `${sd} de ${(MES_LABEL[sm] ?? '').toLowerCase()}`;
  const longEnd = `${ed} de ${(MES_LABEL[em] ?? '').toLowerCase()}`;
  return {
    label: `Semana del ${shortStart} al ${shortEnd} ${year}`,
    subtitle: `Métricas del ${longStart} al ${longEnd} ${year}`,
  };
}

function mesLabels(
  year: number,
  month: number,
): { label: string; subtitle: string } {
  const m = MES_LABEL[month] ?? '—';
  return {
    label: `${m} ${year}`,
    subtitle: `Métricas de ${m} ${year}`,
  };
}

/**
 * Ventana de fechas para el dashboard según periodo + fecha. Para
 * 'semana' la fecha de entrada puede ser cualquier día de la semana; el
 * resultado siempre arranca el lunes. Para 'mes' se ignora el día y se
 * usa el rango completo del mes.
 */
export function getDateWindow(
  periodoInput: string | undefined | null,
  fechaInput: string | undefined | null,
): DateWindow {
  const periodo = normalizePeriodo(periodoInput);
  const fecha = normalizeFecha(fechaInput);

  let startDate: string;
  let endDate: string;
  let label: string;
  let subtitleLabel: string;

  if (periodo === 'dia') {
    startDate = fecha;
    endDate = fecha;
    const r = diaLabels(fecha);
    label = r.label;
    subtitleLabel = r.subtitle;
  } else if (periodo === 'semana') {
    startDate = getMondayOfWeek(fecha);
    endDate = getSundayOfWeek(fecha);
    const r = semanaLabels(startDate, endDate);
    label = r.label;
    subtitleLabel = r.subtitle;
  } else {
    const [yStr, mStr] = fecha.split('-');
    const y = Number(yStr);
    const m = Number(mStr);
    // Date.UTC(y, m, 0) = día 0 del mes siguiente = último día del mes actual.
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    startDate = `${yStr}-${mStr}-01`;
    endDate = `${yStr}-${mStr}-${pad2(lastDay)}`;
    const r = mesLabels(y, m);
    label = r.label;
    subtitleLabel = r.subtitle;
  }

  const startIso = parseCDMXDate(startDate).toISOString();
  const endDay = parseCDMXDate(endDate);
  endDay.setUTCDate(endDay.getUTCDate() + 1);
  const endIso = endDay.toISOString();

  return {
    startDate,
    endDate,
    startIso,
    endIso,
    label,
    subtitleLabel,
    periodo,
    fecha,
  };
}
