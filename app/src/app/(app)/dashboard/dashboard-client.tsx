'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Loader } from 'lucide-react';

/**
 * Filtro de mes/año para el dashboard.
 *
 * Los selectores controlan los searchParams `mes` (1-12) y `anio` y
 * disparan navegación con `router.push` cuando cambia cualquiera. El
 * Server Component re-corre con los nuevos params y vuelve a renderizar
 * las métricas con el rango.
 *
 * Decisiones:
 *   - Es un Client Component PEQUEÑO (solo el filter); el resto del
 *     dashboard sigue siendo Server Component. Esto mantiene el
 *     rendering server-side de las queries pesadas.
 *   - useTransition baja la opacidad de los selectores durante el
 *     re-fetch, así el usuario sabe que pasó algo.
 *   - Lista de años: año actual + 2 anteriores (3 opciones). Si quieres
 *     más historia, sube el `historyYears`.
 */
const historyYears = 2; // muestra current + 2 anteriores

const MES_OPTIONS: { value: number; label: string }[] = [
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

export function MonthYearFilter({
  mes,
  anio,
}: {
  mes: number;
  anio: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  const currentYear = new Date().getUTCFullYear();
  // Años hacia atrás incluyendo el actual.
  const yearOptions: number[] = [];
  for (let y = currentYear; y >= currentYear - historyYears; y--) {
    yearOptions.push(y);
  }
  // Si el `anio` actual del filtro queda fuera del rango (ej. el admin
  // navegó manualmente a `?anio=1990`), igual lo agregamos para que el
  // <select> no muestre value desconectado.
  if (!yearOptions.includes(anio)) {
    yearOptions.push(anio);
    yearOptions.sort((a, b) => b - a);
  }

  function pushFilter(nextMes: number, nextAnio: number) {
    const params = new URLSearchParams();
    params.set('mes', String(nextMes));
    params.set('anio', String(nextAnio));
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        className="select"
        style={{ width: 'auto', minWidth: 130 }}
        value={mes}
        onChange={(e) => pushFilter(Number(e.target.value), anio)}
        disabled={pending}
        aria-label="Filtrar por mes"
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
        value={anio}
        onChange={(e) => pushFilter(mes, Number(e.target.value))}
        disabled={pending}
        aria-label="Filtrar por año"
      >
        {yearOptions.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      {pending && (
        <span
          className="text-xs flex items-center gap-1"
          style={{ color: 'var(--text-tertiary)' }}
        >
          <Loader size={12} className="animate-spin" /> Actualizando…
        </span>
      )}
    </div>
  );
}

export const MES_LABEL: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(MES_OPTIONS.map((m) => [m.value, m.label])),
);
