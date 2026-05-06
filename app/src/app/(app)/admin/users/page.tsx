'use client';

import { useState } from 'react';
import { Plus, Pencil, X, Mail, Phone } from 'lucide-react';
import { mockUsers, type Role } from '@/data/mock';
import { RoleBadge } from '@/components/ui/Badges';

const ROLES: Role[] = ['admin', 'seller', 'driver', 'warehouse', 'supervisor'];

export default function AdminUsersPage() {
  const [users, setUsers] = useState(mockUsers);
  const [showNew, setShowNew] = useState(false);

  const toggleActive = (id: string) =>
    setUsers((prev) =>
      prev.map((u) => (u.id === id ? { ...u, active: !u.active } : u)),
    );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Gestión de Usuarios</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Roles, permisos y estado de las cuentas del sistema.
          </p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn btn-primary">
          <Plus size={16} /> Nuevo Usuario
        </button>
      </div>

      <div className="tbl-wrap">
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
              {users.map((u) => (
                <tr key={u.id}>
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
                        {u.name.charAt(0)}
                      </div>
                      <div>
                        <div className="font-medium">{u.name}</div>
                        <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          ID #{u.id}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {u.email}
                  </td>
                  <td><RoleBadge role={u.role} /></td>
                  <td className="text-sm">{u.phone ?? '—'}</td>
                  <td>
                    <Toggle
                      checked={u.active ?? false}
                      onChange={() => toggleActive(u.id)}
                    />
                  </td>
                  <td>
                    <div className="flex justify-end gap-1">
                      <button
                        className="btn btn-ghost"
                        style={{ padding: '6px' }}
                        aria-label="Editar rol"
                      >
                        <Pencil size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showNew && <NewUserModal onClose={() => setShowNew(false)} />}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      role="switch"
      aria-checked={checked}
      className="relative inline-flex items-center"
      style={{
        width: 40,
        height: 22,
        borderRadius: 9999,
        background: checked ? 'var(--success)' : 'var(--border-strong)',
        transition: 'background 150ms ease',
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

function NewUserModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.45)' }}
      onClick={onClose}
    >
      <div
        className="card w-full max-w-md p-6 animate-fade"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-lg">Nuevo Usuario</h3>
          <button
            className="btn btn-ghost"
            style={{ padding: '6px' }}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <label className="label">Nombre completo</label>
            <input className="input" placeholder="Ej. Juan García" />
          </div>
          <div>
            <label className="label">Correo</label>
            <div className="relative">
              <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} />
              <input
                type="email"
                className="input"
                style={{ paddingLeft: 36 }}
                placeholder="usuario@elmelaminas.com"
              />
            </div>
          </div>
          <div>
            <label className="label">Teléfono</label>
            <div className="relative">
              <Phone size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} />
              <input
                type="tel"
                className="input"
                style={{ paddingLeft: 36 }}
                placeholder="55 1234 5678"
              />
            </div>
          </div>
          <div>
            <label className="label">Rol</label>
            <select className="select" defaultValue="seller">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r === 'admin' && 'Administrador'}
                  {r === 'seller' && 'Vendedor'}
                  {r === 'driver' && 'Chofer'}
                  {r === 'warehouse' && 'Almacén'}
                  {r === 'supervisor' && 'Supervisor'}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex gap-2 mt-6">
          <button className="btn btn-outline flex-1" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary flex-1">Crear usuario</button>
        </div>
      </div>
    </div>
  );
}
