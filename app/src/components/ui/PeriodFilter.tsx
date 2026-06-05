'use client';

import { ChevronLeft, ChevronRight, Loader, X } from 'lucide-react';
import {
  MES_OPTIONS,
  type Periodo,
  addDays,
  addMonths,
  getDateWindow,
  getMondayOfWeek,
  todayInCDMX,
} from '@/app/(app)/dashboard/constants';

/**
 * Filtro de periodo reutilizable (día / semana / mes).
 *
 * Presentacional: NO conoce `router` ni `searchParams`. El padre
 * implementa el `onChange` y decide cómo preservar el resto de los
 * params al navegar. Esto deja el componente plug-and-play tanto en
 * /dashboard (donde el periodo está siempre activo) como en /leads
 * (donde es opcional y debe poder limpiarse).
 *
 * UI:
 *   - 3 tabs (Día / Semana / Mes) arriba.
 *   - Controles según el periodo: input date para Día/Semana, selects
 *     para Mes; flechas ← → para navegar prev/next.
 *   - Botón "Hoy" / "Esta semana" / "Este mes" para volver al actual.
 *   - Botón X (cuando se pasa `onClear`) para desactivar el filtro.
 *   - Slot `extras` para que el padre meta controles extra a la
 *     derecha (ej. el select de sale_type del dashboard).
 *
 * Las helpers (addDays/addMonths/getMondayOfWeek/getDateWindow/
 * todayInCDMX/MES_OPTIONS) viven en `dashboard/constants.ts` porque
 * son TZ-aware (México CDMX -06:00). Importarlas desde un componente
 * `ui/` es un cross-route import; queda como TODO mover los helpers a
 * `src/lib/date-window.ts` cuando crezca otro consumidor.
 */

const HISTORY_YEARS = 2;

export type PeriodFilterProps = {
  periodo: Periodo;
  fecha: string;
  /** Disparado cuando el usuario cambia tab, navega ← / →, salta a
   *  "hoy" o elige fecha. El padre hace el `router.push` real. */
  onChange: (next: { periodo: Periodo; fecha: string }) => void;
  /** Si se provee, aparece una X que desactiva el filtro de periodo.
   *  El padre decide qué significa "inactivo" en su URL. */
  onClear?: () => void;
  /** Desactiva los controles mientras hay una transición router en
   *  vuelo. Default false. */
  pending?: boolean;
  /** Nodo opcional a la derecha de los controles. Dashboard inyecta
   *  aquí su select de tipo de venta. */
  extras?: React.ReactNode;
};

export function PeriodFilter({
  periodo,
  fecha,
  onChange,
  onClear,
  pending = false,
  extras,
}: PeriodFilterProps) {
  const window = getDateWindow(periodo, fecha);

  function push(nextPeriodo: Periodo, nextFecha: string) {
    onChange({ periodo: nextPeriodo, fecha: nextFecha });
  }

  function selectTab(next: Periodo) {
    if (next === periodo) return;
    push(next, fecha);
  }

  function navigatePrev() {
    if (periodo === 'dia') {
      push('dia', addDays(fecha, -1));
    } else if (periodo === 'semana') {
      push('semana', addDays(getMondayOfWeek(fecha), -7));
    } else {
      push('mes', addMonths(fecha, -1));
    }
  }

  function navigateNext() {
    if (periodo === 'dia') {
      push('dia', addDays(fecha, 1));
    } else if (periodo === 'semana') {
      push('semana', addDays(getMondayOfWeek(fecha), 7));
    } else {
      push('mes', addMonths(fecha, 1));
    }
  }

  function jumpToCurrent() {
    push(periodo, todayInCDMX());
  }

  const jumpLabel =
    periodo === 'dia'
      ? 'Hoy'
      : periodo === 'semana'
        ? 'Esta semana'
        : 'Este mes';

  const tabs: { value: Periodo; label: string }[] = [
    { value: 'dia', label: 'Día' },
    { value: 'semana', label: 'Semana' },
    { value: 'mes', label: 'Mes' },
  ];

  return (
    <div className="flex flex-col gap-2 items-end">
      <div
        className="inline-flex rounded-lg overflow-hidden"
        style={{ border: '1px solid var(--border)' }}
        role="tablist"
        aria-label="Periodo del filtro"
      >
        {tabs.map((t) => {
          const active = t.value === periodo;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => selectTab(t.value)}
              disabled={pending}
              className="text-sm font-medium"
              style={{
                padding: '6px 14px',
                background: active ? 'var(--brand-primary)' : 'transparent',
                color: active ? '#fff' : 'var(--text-secondary)',
                cursor: pending ? 'wait' : 'pointer',
                transition: 'background 150ms ease',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2 flex-wrap justify-end">
        <button
          type="button"
          className="btn btn-outline"
          style={{ padding: '6px 10px' }}
          onClick={navigatePrev}
          disabled={pending}
          aria-label="Periodo anterior"
          title="Periodo anterior"
        >
          <ChevronLeft size={16} />
        </button>

        {periodo === 'dia' && (
          <DiaControl fecha={fecha} pending={pending} onPick={(f) => push('dia', f)} />
        )}
        {periodo === 'semana' && (
          <SemanaControl
            fecha={fecha}
            pending={pending}
            onPick={(f) => push('semana', getMondayOfWeek(f))}
          />
        )}
        {periodo === 'mes' && (
          <MesControl fecha={fecha} pending={pending} onPick={(f) => push('mes', f)} />
        )}

        <button
          type="button"
          className="btn btn-outline"
          style={{ padding: '6px 10px' }}
          onClick={navigateNext}
          disabled={pending}
          aria-label="Periodo siguiente"
          title="Periodo siguiente"
        >
          <ChevronRight size={16} />
        </button>

        <button
          type="button"
          className="btn btn-outline"
          style={{ padding: '6px 14px' }}
          onClick={jumpToCurrent}
          disabled={pending}
        >
          {jumpLabel}
        </button>

        {extras}

        {onClear && (
          <button
            type="button"
            className="btn btn-outline"
            style={{ padding: '6px 10px' }}
            onClick={onClear}
            disabled={pending}
            aria-label="Quitar filtro de periodo"
            title="Quitar filtro de periodo"
          >
            <X size={16} />
          </button>
        )}

        {pending && (
          <span
            className="text-xs flex items-center gap-1"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <Loader size={12} className="animate-spin" /> Actualizando…
          </span>
        )}
      </div>

      {periodo === 'semana' && (
        <span
          className="text-xs"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {window.label}
        </span>
      )}
    </div>
  );
}

function DiaControl({
  fecha,
  pending,
  onPick,
}: {
  fecha: string;
  pending: boolean;
  onPick: (fecha: string) => void;
}) {
  return (
    <input
      type="date"
      className="select"
      style={{ width: 'auto' }}
      value={fecha}
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value);
      }}
      disabled={pending}
      aria-label="Día"
    />
  );
}

function SemanaControl({
  fecha,
  pending,
  onPick,
}: {
  fecha: string;
  pending: boolean;
  onPick: (fecha: string) => void;
}) {
  // El input muestra el lunes de la semana activa (ancla); al cambiar,
  // el padre snapea al lunes de la nueva fecha.
  const monday = getMondayOfWeek(fecha);
  return (
    <input
      type="date"
      className="select"
      style={{ width: 'auto' }}
      value={monday}
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value);
      }}
      disabled={pending}
      aria-label="Semana (selecciona cualquier día)"
      title="Cualquier día → se ancla al lunes de esa semana"
    />
  );
}

function MesControl({
  fecha,
  pending,
  onPick,
}: {
  fecha: string;
  pending: boolean;
  onPick: (fecha: string) => void;
}) {
  const [yStr, mStr] = fecha.split('-');
  const year = Number(yStr);
  const month = Number(mStr);

  const currentYear = new Date().getUTCFullYear();
  const yearOptions: number[] = [];
  for (let y = currentYear; y >= currentYear - HISTORY_YEARS; y--) {
    yearOptions.push(y);
  }
  if (!yearOptions.includes(year)) {
    yearOptions.push(year);
    yearOptions.sort((a, b) => b - a);
  }

  function setMonth(m: number) {
    onPick(`${yStr}-${String(m).padStart(2, '0')}-01`);
  }
  function setYear(y: number) {
    onPick(`${y}-${mStr}-01`);
  }

  return (
    <>
      <select
        className="select"
        style={{ width: 'auto', minWidth: 130 }}
        value={month}
        onChange={(e) => setMonth(Number(e.target.value))}
        disabled={pending}
        aria-label="Mes"
      >
        {MES_OPTIONS.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>
      <select
        className="select"
        style={{ width: 'auto', minWidth: 100 }}
        value={year}
        onChange={(e) => setYear(Number(e.target.value))}
        disabled={pending}
        aria-label="Año"
      >
        {yearOptions.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </>
  );
}
