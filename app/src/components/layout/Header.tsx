/* ═══════════════════════════════════════════
   HEADER — Barra superior con notificaciones
   ═══════════════════════════════════════════ */

'use client';

import { useState } from 'react';
import { Bell, Menu, Search } from 'lucide-react';
import { useDemo } from '@/context/DemoContext';
import { mockNotifications, roleLabel } from '@/data/mock';

const TYPE_DOT: Record<string, string> = {
  info: 'bg-[#2E74B5]',
  success: 'bg-[#16A34A]',
  warning: 'bg-[#D97706]',
  danger: 'bg-[#DC2626]',
};

export default function Header({
  onMenuClick,
}: {
  /** Callback para abrir el sidebar drawer. Solo se invoca desde el botón
   *  hamburger visible en mobile (`lg:hidden`). En desktop el sidebar
   *  ya está siempre visible y el botón no aparece. */
  onMenuClick?: () => void;
}) {
  const { user, role } = useDemo();
  const [open, setOpen] = useState(false);
  const unread = mockNotifications.length;

  return (
    <header className="app-header">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {/* Botón hamburger — solo en mobile/tablet. Abre el sidebar drawer. */}
        {onMenuClick && (
          <button
            type="button"
            onClick={onMenuClick}
            className="lg:hidden flex items-center justify-center rounded-lg"
            style={{
              width: 40,
              height: 40,
              color: 'var(--text-secondary)',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              flexShrink: 0,
            }}
            aria-label="Abrir menú"
          >
            <Menu size={22} />
          </button>
        )}

        {/* Search — visible solo en md+ (≥768px) */}
        <div
          className="hidden md:flex items-center gap-2 px-3 py-2 rounded-lg"
          style={{ background: 'var(--bg-muted)', minWidth: 320 }}
        >
          <Search size={16} style={{ color: 'var(--text-tertiary)' }} />
          <input
            placeholder="Buscar leads, clientes, pagos…"
            className="bg-transparent outline-none text-sm flex-1"
            style={{ color: 'var(--text-primary)' }}
          />
          <kbd
            className="hidden lg:inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium"
            style={{ background: '#fff', border: '1px solid var(--border)', color: 'var(--text-tertiary)' }}
          >
            Ctrl + K
          </kbd>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {/* Notifications */}
        <div className="relative">
          <button
            onClick={() => setOpen((v) => !v)}
            className="relative flex items-center justify-center rounded-full hover:bg-[var(--bg-muted)]"
            style={{ width: 40, height: 40, color: 'var(--text-secondary)' }}
            aria-label="Notificaciones"
          >
            <Bell size={20} />
            {unread > 0 && (
              <span
                className="absolute flex items-center justify-center"
                style={{
                  top: 6,
                  right: 6,
                  minWidth: 18,
                  height: 18,
                  padding: '0 5px',
                  borderRadius: 9999,
                  background: 'var(--danger)',
                  color: '#fff',
                  fontSize: '0.625rem',
                  fontWeight: 700,
                }}
              >
                {unread}
              </span>
            )}
          </button>

          {open && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
              <div
                className="absolute right-0 mt-2 z-20 animate-fade card"
                style={{ width: 360, padding: 0 }}
              >
                <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                  <div className="font-semibold text-sm">Notificaciones</div>
                  <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    Tienes {unread} sin leer
                  </div>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {mockNotifications.map((n) => (
                    <div
                      key={n.id}
                      className="flex gap-3 px-4 py-3 cursor-pointer hover:bg-[var(--bg-muted)] border-b last:border-b-0"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <span
                        className={`mt-1.5 inline-block rounded-full ${TYPE_DOT[n.type]}`}
                        style={{ width: 8, height: 8, flexShrink: 0 }}
                      />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="text-sm font-medium truncate">{n.title}</div>
                        <div
                          className="text-xs"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          {n.message}
                        </div>
                        <div
                          className="text-[11px] mt-1"
                          style={{ color: 'var(--text-tertiary)' }}
                        >
                          {n.time}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* User */}
        <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg" style={{ background: 'var(--bg-muted)' }}>
          <div
            className="flex items-center justify-center"
            style={{
              width: 32,
              height: 32,
              borderRadius: 9999,
              background: 'var(--brand-primary)',
              color: '#fff',
              fontSize: '0.75rem',
              fontWeight: 700,
            }}
          >
            {user.name.charAt(0)}
          </div>
          <div className="hidden sm:block leading-tight">
            <div className="text-sm font-semibold">{user.name}</div>
            <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              {roleLabel(role)}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
