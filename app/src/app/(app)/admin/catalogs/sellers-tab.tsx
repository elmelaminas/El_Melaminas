'use client';

import { useState, useTransition } from 'react';
import { Plus, Pencil } from 'lucide-react';
import { SellerModal } from './seller-modal';
import { toggleSellerActiveAction } from './actions';
import type { SellerRow } from './catalogs-client';

export function SellersTab({ initialSellers }: { initialSellers: SellerRow[] }) {
  // Copia local para reflejar cambios optimistas del toggle. revalidatePath
  // del Server Action dispara un refresh con datos frescos que sobrescriben
  // este state al re-montar el cliente.
  const [sellers, setSellers] = useState(initialSellers);
  const [editing, setEditing] = useState<SellerRow | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <button onClick={() => setCreating(true)} className="btn btn-primary">
          <Plus size={16} /> Nuevo Vendedor
        </button>
      </div>

      <div className="tbl-wrap">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Teléfono</th>
                <th>Vinculado a usuario</th>
                <th>Estado</th>
                <th className="text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {sellers.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="text-center py-6 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Sin vendedores todavía. Crea el primero con el botón de arriba.
                  </td>
                </tr>
              ) : (
                sellers.map((s) => (
                  <SellerRowItem
                    key={s.id}
                    seller={s}
                    onToggle={(next) =>
                      setSellers((prev) =>
                        prev.map((x) =>
                          x.id === s.id ? { ...x, is_active: next } : x,
                        ),
                      )
                    }
                    onEdit={() => setEditing(s)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {creating && (
        <SellerModal
          mode="create"
          onClose={() => setCreating(false)}
          onSuccess={() => setCreating(false)}
        />
      )}
      {editing && (
        <SellerModal
          mode="edit"
          initial={{
            id: editing.id,
            name: editing.name,
            phone: editing.phone,
          }}
          onClose={() => setEditing(null)}
          onSuccess={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function SellerRowItem({
  seller,
  onToggle,
  onEdit,
}: {
  seller: SellerRow;
  onToggle: (next: boolean) => void;
  onEdit: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleToggle = () => {
    const next = !seller.is_active;
    setError(null);
    onToggle(next);
    startTransition(async () => {
      const r = await toggleSellerActiveAction(seller.id, next);
      if (!r.ok) {
        onToggle(!next);
        setError(r.message);
      }
    });
  };

  return (
    <tr>
      <td>
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center"
            style={{
              width: 36,
              height: 36,
              borderRadius: 9999,
              background: 'var(--brand-primary)',
              color: '#fff',
              fontWeight: 700,
              fontSize: '0.8125rem',
            }}
          >
            {seller.name.charAt(0).toUpperCase()}
          </div>
          <div className="font-medium">{seller.name}</div>
        </div>
      </td>
      <td className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {seller.phone ?? '—'}
      </td>
      <td>
        {seller.profile_id ? (
          <span className="badge badge-success">Sí</span>
        ) : (
          <span className="badge badge-neutral">No</span>
        )}
      </td>
      <td>
        <Toggle
          checked={seller.is_active}
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
            aria-label="Editar"
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
