'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { ChevronLeft, ChevronRight, Loader } from 'lucide-react';
import {
  MES_OPTIONS,
  type Periodo,
  addDays,
  addMonths,
  getDateWindow,
  getMondayOfWeek,
  todayInCDMX,
} from './constants';

/**
 * Filtro de periodo (día / semana / mes) para el dashboard.
 *
 * Reemplaza al viejo `MonthYearFilter`. Controla los searchParams
 * `periodo` ('dia' | 'semana' | 'mes') y `fecha` ('YYYY-MM-DD').
 *
 * UI:
 *   - 3 tabs en la parte superior para elegir el periodo activo.
 *   - Controles de navegación dependientes del periodo:
 *       Día    → input type="date" + flechas ← →
 *       Semana → input type="date" (snap a lunes) + flechas ← →
 *                + texto "Semana del {lunes} al {domingo}"
 *       Mes    → selects de mes y año + flechas ← →
 *   - Botón para volver al periodo actual ("Hoy", "Esta semana",
 *     "Este mes").
 *
 * Cuando cualquier control cambia, `router.push` dispara una nueva
 * navegación con los searchParams correspondientes y el Server
 * Component vuelve a calcular la ventana de fechas.
 */
const historyYears = 2;

export function PeriodFilter({
  periodo,
  fecha,
}: {
  periodo: Periodo;
  fecha: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  const window = getDateWindow(periodo, fecha);

  function push(nextPeriodo: Periodo, nextFecha: string) {
    const params = new URLSearchParams();
    params.set('periodo', nextPeriodo);
    params.set('fecha', nextFecha);
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
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
      {/* Tabs */}
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

      {/* Controles según periodo */}
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

        {periodo === 'dia' && <DiaControl fecha={fecha} pending={pending} onPick={(f) => push('dia', f)} />}
        {periodo === 'semana' && (
          <SemanaControl
            fecha={fecha}
            pending={pending}
            onPick={(f) => push('semana', getMondayOfWeek(f))}
            label={window.label}
          />
        )}
        {periodo === 'mes' && <MesControl fecha={fecha} pending={pending} onPick={(f) => push('mes', f)} />}

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

        {pending && (
          <span
            className="text-xs flex items-center gap-1"
            style={{ color: 'var(--text-tertiary)' }}
          >
            <Loader size={12} className="animate-spin" /> Actualizando…
          </span>
        )}
      </div>

      {/* Texto descriptivo para semana (rango visible). */}
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
  label: _label,
}: {
  fecha: string;
  pending: boolean;
  onPick: (fecha: string) => void;
  label: string;
}) {
  // El input muestra el lunes de la semana activa (para que el usuario
  // vea el "ancla"); al cambiar, el padre snapea al lunes de la nueva fecha.
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
  for (let y = currentYear; y >= currentYear - historyYears; y--) {
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
