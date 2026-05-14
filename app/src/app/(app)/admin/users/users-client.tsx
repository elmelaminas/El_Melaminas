'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Pencil, Trash2, Loader } from 'lucide-react';
import type { Role } from '@/data/mock';
import { RoleBadge } from '@/components/ui/Badges';
import { toggleUserActiveAction, deleteUserAction } from './actions';
import { NewUserModal } from './new-user-modal';
import { EditUserModal } from './edit-user-modal';

export type UserRow = {
  id: string;
  full_name: string;
  email: string;
  role: Role;
  phone: string | null;
  is_active: boolean;
};

export function UsersClient({
  initialUsers,
  currentUserId,
}: {
  initialUsers: UserRow[];
  /** UUID del usuario autenticado. Se usa para ocultar el botón de
   *  eliminar en su propia fila — la action también lo bloquea, pero
   *  evitarlo en UI es mejor UX. `null` si no se pudo leer la sesión
   *  (caso edge: la action devolverá error al intentar). */
  currentUserId: string | null;
}) {
  const router = useRouter();
  // Mantenemos copia local para reflejar cambios optimistas del toggle. Tras
  // cada acción server, revalidatePath dispara un re-render con datos frescos
  // que sobrescriben este state al recibir nuevas props (montaje de cliente
  // tras router refresh).
  const [users, setUsers] = useState(initialUsers);
  const [showNew, setShowNew] = useState(false);
  // Usuario actualmente abierto en el modal de edición. null = cerrado.
  // Guardamos el row completo (no solo el id) para precargar el form sin
  // un round-trip extra. revalidatePath + router.refresh tras success
  // sobreescribe `initialUsers` con los datos frescos del server.
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Gestión de Usuarios</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Roles, permisos y estado de las cuentas del sistema.
          </p>
        </div>
        <button
          id="btn-new-user"
          onClick={() => setShowNew(true)}
          className="btn btn-primary"
        >
          <Plus size={16} /> Nuevo Usuario
        </button>
      </div>

      <div id="users-table" className="tbl-wrap">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Correo</th>
                <th>Rol</th>
                <th>Teléfono</th>
                <th>Estado</th>
                <th className="text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-6 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    Sin usuarios todavía. Crea el primero con el botón de arriba.
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <UserRowItem
                    key={u.id}
                    user={u}
                    isSelf={u.id === currentUserId}
                    onToggle={(next) =>
                      setUsers((prev) =>
                        prev.map((x) => (x.id === u.id ? { ...x, is_active: next } : x)),
                      )
                    }
                    onEdit={() => setEditingUser(u)}
                    onDelete={() => {
                      // Optimista: removemos la fila inmediatamente.
                      // router.refresh() refresca props desde el server
                      // por si algo hubiera quedado desincronizado.
                      setUsers((prev) => prev.filter((x) => x.id !== u.id));
                      router.refresh();
                    }}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showNew && (
        <NewUserModal
          onClose={() => setShowNew(false)}
          onSuccess={() => setShowNew(false)}
        />
      )}

      {editingUser && (
        <EditUserModal
          initialValues={{
            id: editingUser.id,
            full_name: editingUser.full_name,
            email: editingUser.email,
            phone: editingUser.phone,
            role: editingUser.role,
          }}
          onClose={() => setEditingUser(null)}
          onSuccess={() => {
            setEditingUser(null);
            // revalidatePath del server invalida el cache; el refresh
            // del router re-monta el Server Component para que la fila
            // muestre los datos nuevos.
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function UserRowItem({
  user,
  isSelf,
  onToggle,
  onEdit,
  onDelete,
}: {
  user: UserRow;
  /** El row corresponde al usuario autenticado — ocultamos botón de
   *  eliminar (la action también lo rechaza). */
  isSelf: boolean;
  onToggle: (nextActive: boolean) => void;
  onEdit: () => void;
  /** Callback que el padre usa para retirar la fila optimistamente
   *  cuando deleteUserAction retorna success. */
  onDelete: () => void;
}) {
  const [togglePending, startToggle] = useTransition();
  const [deletePending, startDelete] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // null = botón normal; 'confirm' = mostrando "¿Eliminar a {nombre}?".
  // El padre quita la fila en `onDelete`; un error post-confirmación
  // se pinta debajo del row.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleToggle = () => {
    const nextActive = !user.is_active;
    setError(null);
    // Optimista: actualizamos UI antes; revertimos si la action falla.
    onToggle(nextActive);
    startToggle(async () => {
      const result = await toggleUserActiveAction(user.id, nextActive);
      if (!result.ok) {
        onToggle(!nextActive);
        setError(result.message);
      }
    });
  };

  const handleConfirmDelete = () => {
    setDeleteError(null);
    startDelete(async () => {
      const result = await deleteUserAction(user.id);
      if (result.status === 'success') {
        // El padre retira la fila optimistamente y dispara
        // router.refresh para sincronizar.
        onDelete();
        return;
      }
      setDeleteError(result.message);
      setConfirmingDelete(false);
    });
  };

  return (
    <>
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
              {user.full_name.charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="font-medium">{user.full_name}</div>
              <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                ID #{user.id.slice(0, 8)}
              </div>
            </div>
          </div>
        </td>
        <td className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {user.email}
        </td>
        <td><RoleBadge role={user.role} /></td>
        <td className="text-sm">{user.phone ?? '—'}</td>
        <td>
          <Toggle
            checked={user.is_active}
            disabled={togglePending || deletePending}
            onChange={handleToggle}
          />
          {error && (
            <div className="text-xs mt-1" style={{ color: 'var(--danger, #dc2626)' }}>
              {error}
            </div>
          )}
        </td>
        <td>
          {confirmingDelete ? (
            // Confirm inline en la columna Acciones. Reemplaza los
            // íconos hasta que el admin decida.
            <div className="flex items-center justify-end gap-2 flex-wrap">
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                ¿Eliminar a <strong>{user.full_name}</strong>?
              </span>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={deletePending}
                className="btn"
                style={{
                  padding: '4px 10px',
                  fontSize: '0.75rem',
                  background: '#DC2626',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
                aria-label={`Confirmar eliminación de ${user.full_name}`}
              >
                {deletePending ? (
                  <Loader size={12} className="animate-spin" />
                ) : null}
                Sí, eliminar
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deletePending}
                className="btn"
                style={{
                  padding: '4px 10px',
                  fontSize: '0.75rem',
                  background: 'var(--bg-subtle)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                }}
              >
                Cancelar
              </button>
            </div>
          ) : (
            <div className="flex justify-end gap-1">
              <button
                type="button"
                onClick={onEdit}
                className="btn btn-ghost"
                style={{ padding: '6px' }}
                aria-label={`Editar usuario ${user.full_name}`}
                title="Editar nombre, teléfono y rol"
              >
                <Pencil size={16} />
              </button>
              {/* El botón "Eliminar" se oculta en la fila del usuario
                  autenticado — anti-self-delete enforced también en
                  el server. */}
              {!isSelf && (
                <button
                  type="button"
                  onClick={() => {
                    setDeleteError(null);
                    setConfirmingDelete(true);
                  }}
                  disabled={deletePending}
                  className="btn btn-ghost"
                  style={{ padding: '6px', color: '#DC2626' }}
                  aria-label={`Eliminar usuario ${user.full_name}`}
                  title="Eliminar usuario"
                >
                  {deletePending ? (
                    <Loader size={16} className="animate-spin" />
                  ) : (
                    <Trash2 size={16} />
                  )}
                </button>
              )}
            </div>
          )}
        </td>
      </tr>
      {deleteError && (
        <tr>
          <td colSpan={6} style={{ paddingTop: 0 }}>
            <div
              role="alert"
              className="text-xs"
              style={{
                color: 'var(--danger, #dc2626)',
                background: 'var(--danger-bg, rgba(220,38,38,0.08))',
                border: '1px solid rgba(220,38,38,0.25)',
                padding: '6px 10px',
                borderRadius: 6,
              }}
            >
              <strong>No se pudo eliminar.</strong> {deleteError}
            </div>
          </td>
        </tr>
      )}
    </>
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
