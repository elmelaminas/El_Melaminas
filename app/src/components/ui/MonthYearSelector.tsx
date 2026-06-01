'use client';

/**
 * Selector mes/año reutilizable, self-routing. Lo usan las vistas de
 * efectivo (`/contador`, `/admin/caja`, `/admin/mi-caja`) para que el
 * operador pueda revisar y actuar sobre meses pasados — el filtro
 * solo afecta lo que se MUESTRA, no lo que se puede validar/recibir.
 *
 * Self-routing: el componente lee/escribe los searchParams `mes` y
 * `anio` directamente con `useRouter`/`useSearchParams`. Preserva
 * cualquier otro searchParam (`tab`, filtros) y deja la URL como
 * fuente de verdad. Esto permite usarlo en server components sin
 * tener que envolverlo en otro client component.
 *
 * UI: dos `<select>` (mes + año) + botón "Hoy" para volver al mes
 * actual. La opción "Hoy" se deshabilita si ya estás en el mes actual.
 *
 * Años: año actual + 2 anteriores. Si el padre pasa un `anio` fuera de
 * ese rango (ej. URL stale apuntando a 2022) lo agregamos a la lista
 * para que el `<select>` no muestre un value desconectado.
 */
import { useMemo, useTransition } from 'react';
import {
  usePathname,
  useRouter,
  useSearchParams,
} from 'next/navigation';

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

const HISTORY_YEARS = 2;

export function MonthYearSelector({
  mes,
  anio,
}: {
  mes: number;
  anio: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function push(nextMes: number, nextAnio: number) {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('mes', String(nextMes));
    params.set('anio', String(nextAnio));
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  const now = new Date();
  const currentMonth = now.getUTCMonth() + 1;
  const currentYear = now.getUTCFullYear();

  const yearOptions = useMemo(() => {
    const list: number[] = [];
    for (let y = currentYear; y >= currentYear - HISTORY_YEARS; y--) {
      list.push(y);
    }
    if (!list.includes(anio)) {
      list.push(anio);
      list.sort((a, b) => b - a);
    }
    return list;
  }, [anio, currentYear]);

  const isCurrentMonth = mes === currentMonth && anio === currentYear;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        className="select"
        style={{ width: 'auto', minWidth: 130 }}
        value={mes}
        disabled={pending}
        onChange={(e) => push(Number(e.target.value), anio)}
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
        disabled={pending}
        onChange={(e) => push(mes, Number(e.target.value))}
        aria-label="Filtrar por año"
      >
        {yearOptions.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn-outline"
        style={{ padding: '6px 14px' }}
        onClick={() => push(currentMonth, currentYear)}
        disabled={pending || isCurrentMonth}
        title={
          isCurrentMonth
            ? 'Ya estás en el mes actual'
            : 'Volver al mes actual'
        }
      >
        Hoy
      </button>
    </div>
  );
}
