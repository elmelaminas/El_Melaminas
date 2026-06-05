'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { PeriodFilter as SharedPeriodFilter } from '@/components/ui/PeriodFilter';
import {
  type Periodo,
  type SaleType,
  SALE_TYPE_OPTIONS,
} from './constants';

/**
 * Filtro de periodo del dashboard. Wrapper alrededor del componente
 * compartido `<PeriodFilter>` de `src/components/ui/` — el componente
 * de UI maneja la lógica del periodo y este wrapper se encarga del
 * `router.push` preservando `sale_type` (que el dashboard SIEMPRE
 * lleva en la URL).
 *
 * El select de tipo de venta se renderiza como `extras` para que viva
 * en la misma barra que el resto de los controles del filtro.
 *
 * En /dashboard el periodo está siempre activo (no se puede limpiar)
 * — por eso NO pasamos `onClear`. En /leads sí, porque ahí el
 * periodo es opcional.
 */
export function PeriodFilter({
  periodo,
  fecha,
  saleType,
}: {
  periodo: Periodo;
  fecha: string;
  saleType: SaleType;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  function push(nextPeriodo: Periodo, nextFecha: string, nextSaleType: SaleType) {
    const params = new URLSearchParams();
    params.set('periodo', nextPeriodo);
    params.set('fecha', nextFecha);
    if (nextSaleType) params.set('sale_type', nextSaleType);
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  return (
    <SharedPeriodFilter
      periodo={periodo}
      fecha={fecha}
      pending={pending}
      onChange={({ periodo: p, fecha: f }) => push(p, f, saleType)}
      extras={
        <select
          className="select"
          style={{ width: 'auto', minWidth: 150 }}
          value={saleType}
          onChange={(e) => push(periodo, fecha, e.target.value as SaleType)}
          disabled={pending}
          aria-label="Filtrar por tipo de venta"
        >
          {SALE_TYPE_OPTIONS.map((o) => (
            <option key={o.value || 'all'} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      }
    />
  );
}
