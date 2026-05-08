/* ═══════════════════════════════════════════
   SIDEBAR — Navegación principal por rol
   ═══════════════════════════════════════════ */

'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  ClipboardList,
  CirclePlus,
  CreditCard,
  Truck,
  Package,
  PackagePlus,
  ArrowLeftRight,
  Users as UsersIcon,
  BookOpen,
  ChartBarBig,
  DollarSign,
  History,
  LogOut,
  Layers,
  Loader,
  X,
} from 'lucide-react';
import { useDemo } from '@/context/DemoContext';
import { supabaseClient } from '@/lib/supabase/client';
import { roleLabel, type Role } from '@/data/mock';

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  roles: Role[];
}

const NAV: NavItem[] = [
  { href: '/dashboard',       label: 'Dashboard',         icon: <LayoutDashboard size={18} />, roles: ['admin', 'supervisor'] },
  { href: '/leads/new',       label: 'Nuevo Lead',        icon: <CirclePlus size={18} />,      roles: ['admin', 'seller'] },
  { href: '/leads',           label: 'Leads',             icon: <ClipboardList size={18} />,   roles: ['admin', 'seller'] },
  { href: '/payments',        label: 'Pagos',             icon: <CreditCard size={18} />,      roles: ['admin'] },
  { href: '/payments/new',    label: 'Registrar Pago',    icon: <CirclePlus size={18} />,      roles: ['admin'] },
  { href: '/driver',          label: 'Mis Entregas',      icon: <Truck size={18} />,           roles: ['admin', 'driver'] },
  { href: '/driver?tab=hist', label: 'Historial',         icon: <History size={18} />,         roles: ['driver'] },
  { href: '/warehouse',       label: 'Stock',             icon: <Package size={18} />,         roles: ['admin', 'warehouse'] },
  { href: '/warehouse?new=1', label: 'Registrar Entrada', icon: <PackagePlus size={18} />,     roles: ['warehouse'] },
  { href: '/warehouse?tab=mov', label: 'Movimientos',     icon: <ArrowLeftRight size={18} />,  roles: ['warehouse'] },
  { href: '/admin/users',     label: 'Usuarios',          icon: <UsersIcon size={18} />,       roles: ['admin'] },
  { href: '/admin/catalogs',  label: 'Catálogos',         icon: <BookOpen size={18} />,        roles: ['admin'] },
  // Caja del contador — recibe el efectivo que los choferes traen.
  { href: '/contador',        label: 'Caja',              icon: <DollarSign size={18} />,      roles: ['admin', 'contador'] },
  // Validación de admin: confirma que el contador entregó el efectivo.
  { href: '/admin/caja',      label: 'Validar Caja',      icon: <DollarSign size={18} />,      roles: ['admin'] },
  { href: '/dashboard',       label: 'Reportes',          icon: <ChartBarBig size={18} />,       roles: ['supervisor'] },
];

export default function Sidebar({
  open = false,
  onClose,
}: {
  /** Drawer abierto en mobile. Sin efecto en desktop (CSS lo deja siempre visible). */
  open?: boolean;
  /** Llamado al click en el botón cerrar (X) en mobile. Optional. */
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { role, user, setUser } = useDemo();
  const [signingOut, startSignOut] = useTransition();

  const handleSignOut = () => {
    startSignOut(async () => {
      try {
        // signOut limpia las cookies de sesión del browser; el middleware
        // verá la siguiente request sin auth y nos rebotará a /login si
        // intentamos acceder a una ruta protegida (defensa en profundidad).
        await supabaseClient().auth.signOut();
      } catch (err) {
        // No bloqueamos el logout local por un error de red al server —
        // peor caso quedan cookies stale que el siguiente refresh limpia.
        console.error('[Sidebar] signOut server falló:', err);
      }
      // Limpia el override del DemoContext + localStorage del browser.
      setUser(null);
      router.push('/login');
      router.refresh();
    });
  };

  const items = NAV.filter((it) => it.roles.includes(role));

  const isActive = (href: string) => {
    const path = href.split('?')[0];
    if (path === '/dashboard') return pathname === '/dashboard';
    return pathname === path || pathname.startsWith(path + '/');
  };

  return (
    <aside className={`sidebar${open ? ' open' : ''}`}>
      {/* Logo + botón cerrar en mobile */}
      <div
        className="flex items-center gap-3 px-5"
        style={{
          height: 'var(--header-height)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div
          className="flex items-center justify-center"
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: 'var(--brand-accent)',
            color: '#1F2937',
          }}
        >
          <Layers size={20} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 800,
              letterSpacing: '0.02em',
              fontSize: '0.95rem',
            }}
          >
            EL MELAMINAS
          </div>
          <div
            style={{
              fontSize: '0.6875rem',
              color: 'var(--sidebar-text-muted)',
            }}
          >
            Gestión Operativa
          </div>
        </div>
        {/* Botón cerrar — solo visible en mobile (cuando el drawer es modal) */}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="lg:hidden flex items-center justify-center"
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
            }}
            aria-label="Cerrar menú"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <div className="flex flex-col gap-1">
          {items.map((it, i) => (
            <Link
              key={`${it.href}-${i}`}
              href={it.href}
              className={`nav-link ${isActive(it.href) ? 'active' : ''}`}
            >
              {it.icon}
              <span>{it.label}</span>
            </Link>
          ))}
        </div>
      </nav>

      {/* User footer */}
      <div className="px-3 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <div
          className="flex items-center gap-3 px-3 py-2 rounded-lg"
          style={{ background: 'rgba(255,255,255,0.06)' }}
        >
          <div
            className="flex items-center justify-center"
            style={{
              width: 36,
              height: 36,
              borderRadius: 9999,
              background: 'var(--brand-accent)',
              color: '#1F2937',
              fontWeight: 700,
            }}
          >
            {user.name.charAt(0)}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="truncate" style={{ fontSize: '0.8125rem', fontWeight: 600 }}>
              {user.name}
            </div>
            <div
              className="truncate"
              style={{ fontSize: '0.6875rem', color: 'var(--sidebar-text-muted)' }}
            >
              {roleLabel(role)}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="nav-link mt-2"
          style={{
            color: '#FCA5A5',
            width: '100%',
            textAlign: 'left',
            background: 'transparent',
            border: 'none',
            cursor: signingOut ? 'wait' : 'pointer',
            opacity: signingOut ? 0.6 : 1,
          }}
          aria-busy={signingOut}
        >
          {signingOut ? <Loader size={18} className="animate-spin" /> : <LogOut size={18} />}
          <span>{signingOut ? 'Cerrando…' : 'Cerrar sesión'}</span>
        </button>
      </div>
    </aside>
  );
}
