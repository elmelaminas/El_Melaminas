/**
 * Reglas de color por fila para los listados de leads y entregas.
 *
 * Codificación visual definida por Sergio (regla de negocio):
 *
 *   Rosa     — sale_type = 'venta_empleado'
 *   Naranja  — algún payment del lead tiene payment_type = 'contra_entrega'
 *   Amarillo — payment_status = 'pagado' AND delivery_status != 'entregado'
 *              (cobrado pero todavía no entregado al cliente)
 *   Azul     — product_type = 'con_corte'
 *
 * Prioridad: Rosa > Naranja > Amarillo > Azul. La primera regla que aplica
 * gana; las demás se ignoran. Si ninguna aplica → undefined (fila normal).
 *
 * El helper recibe campos sueltos (no un tipo concreto de fila) para que
 * pueda usarse desde dos listas distintas (`leads` y `admin/entregas`) cuya
 * shape de row es parecida pero no idéntica.
 *
 * `contraEntregaIds` es un Set por O(1) lookup; el caller arma el Set una
 * sola vez con `useMemo`/scope del módulo y lo pasa por fila.
 */

import type { DeliveryStatus, PaymentStatus } from '@/data/mock';

/** Colores con transparencia para fondo de fila — definidos por Sergio. */
export const LEAD_ROW_COLORS = {
  pink: 'rgba(255, 182, 193, 0.35)',
  orange: 'rgba(255, 165, 0, 0.25)',
  yellow: 'rgba(255, 255, 0, 0.25)',
  blue: 'rgba(173, 216, 230, 0.35)',
} as const;

export type LeadRowColorInputs = {
  id: string;
  /** `'venta_empleado'` → rosa. Cualquier otro valor (o null) no aplica. */
  sale_type: string | null;
  /** `'con_corte'` → azul (si ninguna regla anterior aplicó). */
  product_type: string | null;
  payment_status: PaymentStatus;
  delivery_status: DeliveryStatus;
};

/**
 * Devuelve el color de fondo de la fila (rgba string) o `undefined`
 * cuando ninguna regla aplica. Aplicar como
 * `style={{ background: getLeadRowColor(...) }}` en el `<tr>`.
 */
export function getLeadRowColor(
  row: LeadRowColorInputs,
  contraEntregaIds: ReadonlySet<string>,
): string | undefined {
  // 1. Rosa — venta a empleado (precio especial / sin margen).
  if (row.sale_type === 'venta_empleado') return LEAD_ROW_COLORS.pink;

  // 2. Naranja — el lead tiene al menos un pago contra_entrega
  //    pendiente o aplicado (el chofer cobra al entregar).
  if (contraEntregaIds.has(row.id)) return LEAD_ROW_COLORS.orange;

  // 3. Amarillo — ya cobrado pero todavía pendiente de entregar.
  //    Cancelados NO entran (lead muerto, no es prioridad operativa).
  if (
    row.payment_status === 'pagado' &&
    row.delivery_status !== 'entregado' &&
    row.delivery_status !== 'cancelado'
  ) {
    return LEAD_ROW_COLORS.yellow;
  }

  // 4. Azul — producto con corte (requiere trabajo extra en taller).
  if (row.product_type === 'con_corte') return LEAD_ROW_COLORS.blue;

  return undefined;
}

/**
 * Leyenda compacta horizontal con los 4 códigos de color. Se renderiza
 * debajo de los filtros en /leads y /admin/entregas.
 *
 * Tamaño y peso intencionalmente bajos — es referencia secundaria, no
 * debe competir visualmente con los filtros ni con la tabla.
 */
export function LeadRowLegend() {
  const items: { color: string; label: string }[] = [
    { color: LEAD_ROW_COLORS.pink, label: 'Venta empleado' },
    { color: LEAD_ROW_COLORS.orange, label: 'Contra entrega' },
    { color: LEAD_ROW_COLORS.yellow, label: 'Pagado sin entregar' },
    { color: LEAD_ROW_COLORS.blue, label: 'Con corte' },
  ];
  return (
    <div
      className="flex items-center gap-3 flex-wrap text-xs"
      style={{ color: 'var(--text-tertiary)' }}
      aria-label="Leyenda de colores de fila"
    >
      <span style={{ fontWeight: 500 }}>Códigos:</span>
      {items.map((it) => (
        <span
          key={it.label}
          className="inline-flex items-center gap-1.5"
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 9999,
              background: it.color,
              border: '1px solid var(--border)',
            }}
          />
          <span>{it.label}</span>
        </span>
      ))}
    </div>
  );
}
