'use client';

import { useState, useTransition } from 'react';
import { Pencil } from 'lucide-react';
import { ColorModal } from './color-modal';
import { toggleColorActiveAction } from './actions';
import type { ColorRow } from './catalogs-client';

type StockStatus = 'ok' | 'warning' | 'danger';

const STOCK_BADGE: Record<StockStatus, string> = {
  ok: 'badge badge-success',
  warning: 'badge badge-warning',
  danger: 'badge badge-danger',
};
const STOCK_LABEL: Record<StockStatus, string> = {
  ok: 'OK',
  warning: 'Bajo',
  danger: 'Sin stock',
};

/**
 * Reglas:
 *  - Disponible <= 0           → danger
 *  - Disponible < mínimo (>0)  → warning
 *  - resto                     → ok
 *
 * Si el color no tiene fila en `inventory` (`has_inventory_row=false`),
 * todos los stocks son 0 → status = 'danger'. Eso lo refleja el badge y
 * además marcamos la fila visualmente para que el admin sepa que falta
 * crear el row de inventory.
 */
function stockStatus(c: ColorRow): StockStatus {
  if (c.stock_available <= 0) return 'danger';
  if (c.stock_minimum > 0 && c.stock_available < c.stock_minimum) return 'warning';
  return 'ok';
}

export function ColorsTab({ initialColors }: { initialColors: ColorRow[] }) {
  const [colors, setColors] = useState(initialColors);
  const [editing, setEditing] = useState<ColorRow | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="tbl-wrap">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Color</th>
                <th className="text-center">Total</th>
                <th className="text-center">Comprometido</th>
                <th className="text-center">Disponible</th>
                <th className="text-center">Mínimo</th>
                <th>Stock</th>
                <th>Activo</th>
                <th className="text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {colors.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className="text-center py-6 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Sin colores en el catálogo. Se crearán al registrar leads
                    con colores nuevos en /leads/new.
                  </td>
                </tr>
              ) : (
                colors.map((c) => (
                  <ColorRowItem
                    key={c.id}
                    color={c}
                    onToggle={(next) =>
                      setColors((prev) =>
                        prev.map((x) =>
                          x.id === c.id ? { ...x, is_active: next } : x,
                        ),
                      )
                    }
                    onEdit={() => setEditing(c)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <ColorModal
          initial={{ id: editing.id, name: editing.name }}
          onClose={() => setEditing(null)}
          onSuccess={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ColorRowItem({
  color,
  onToggle,
  onEdit,
}: {
  color: ColorRow;
  onToggle: (next: boolean) => void;
  onEdit: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const status = stockStatus(color);

  const handleToggle = () => {
    const next = !color.is_active;
    setError(null);
    onToggle(next);
    startTransition(async () => {
      const r = await toggleColorActiveAction(color.id, next);
      if (!r.ok) {
        onToggle(!next);
        setError(r.message);
      }
    });
  };

  return (
    <tr>
      <td>
        <div className="flex items-center gap-2 font-medium">
          <span
            style={{
              width: 14,
              height: 14,
              borderRadius: 4,
              background: colorToHex(color.name),
              border: '1px solid var(--border-strong)',
            }}
          />
          {color.name}
          {!color.has_inventory_row && (
            <span
              className="text-xs"
              style={{
                color: 'var(--text-tertiary)',
                fontStyle: 'italic',
                marginLeft: 6,
              }}
              title="Este color no tiene fila en `inventory`. Aparecerá con stock 0 hasta que se cree."
            >
              (sin inventario)
            </span>
          )}
        </div>
      </td>
      <td className="text-center font-semibold">{color.stock_total}</td>
      <td className="text-center">{color.stock_committed}</td>
      <td
        className="text-center font-bold"
        style={{
          color:
            status === 'danger'
              ? 'var(--danger)'
              : status === 'warning'
              ? 'var(--warning)'
              : 'var(--success)',
        }}
      >
        {color.stock_available}
      </td>
      <td className="text-center" style={{ color: 'var(--text-tertiary)' }}>
        {color.stock_minimum}
      </td>
      <td>
        <span className={STOCK_BADGE[status]}>{STOCK_LABEL[status]}</span>
      </td>
      <td>
        <Toggle
          checked={color.is_active}
          disabled={pending}
          onChange={handleToggle}
        />
        {error && (
          <div
            className="text-xs mt-1"
            style={{ color: 'var(--danger, #dc2626)' }}
          >
            {error}
          </div>
        )}
      </td>
      <td>
        <div className="flex justify-end gap-1">
          <button
            className="btn btn-ghost"
            style={{ padding: '6px' }}
            aria-label="Editar nombre"
            onClick={onEdit}
          >
            <Pencil size={16} />
          </button>
        </div>
      </td>
    </tr>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      role="switch"
      aria-checked={checked}
      className="relative inline-flex items-center"
      style={{
        width: 40,
        height: 22,
        borderRadius: 9999,
        background: checked ? 'var(--success)' : 'var(--border-strong)',
        transition: 'background 150ms ease',
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <span
        className="inline-block bg-white"
        style={{
          width: 18,
          height: 18,
          borderRadius: 9999,
          transform: `translateX(${checked ? 20 : 2}px)`,
          transition: 'transform 150ms ease',
          boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
        }}
      />
    </button>
  );
}

/**
 * Mapea nombres conocidos del catálogo a un swatch hex. Match parcial
 * insensitive a acentos (`Parotá`, `parota`, `PAROTA` → `#A16207`). Para
 * colores no reconocidos retorna gris.
 */
function colorToHex(name: string): string {
  const n = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  if (n.includes('negr')) return '#1F2937';
  if (n.includes('blanc')) return '#F8FAFC';
  if (n.includes('gris')) return '#94A3B8';
  if (n.includes('parot')) return '#A16207';
  if (n.includes('nogal')) return '#7C2D12';
  if (n.includes('wengu')) return '#3F1F0F';
  return '#CBD5E1';
}
