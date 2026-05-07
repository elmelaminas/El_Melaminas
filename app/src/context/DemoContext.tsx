/* ═══════════════════════════════════════════
   SESSION CONTEXT (originalmente "DEMO")
   Mantiene el rol y el usuario activos en el cliente para que
   sidebar/header rendericen avatar + label de rol. Originalmente era
   100% mock manejado desde un selector en /login; ahora también acepta
   un usuario real vía `setUser(...)` que el login llama tras
   `signInWithPassword` de Supabase.

   Si nunca se llama `setUser`, el contexto cae al mock derivado del rol
   (`userForRole`), preservando el flujo del prototipo en pantallas que
   aún no tocan auth real. Esto evita romper Sidebar/Header/Dashboard/etc.

   Nombre `DemoContext` se mantiene para no tocar 7 archivos de imports
   ahora — un rename a `SessionContext` es trivial y se hace en una
   pasada cuando el resto del refactor lo amerite.
   ═══════════════════════════════════════════ */

'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import { mockUsers, type Role } from '@/data/mock';

/**
 * Forma mínima común que sidebar/header consumen: `name` y `role`. Tanto
 * `MockUser` como un usuario real cumplen esto, así no rompo consumers.
 */
export interface SessionUser {
  id?: string;
  name: string;
  email?: string;
  role: Role;
}

interface DemoContextValue {
  role: Role;
  user: SessionUser;
  setRole: (role: Role) => void;
  /** Setea el usuario real (post-signIn). Pasa `null` para limpiar (logout). */
  setUser: (user: SessionUser | null) => void;
}

const DemoContext = createContext<DemoContextValue | undefined>(undefined);

const STORAGE_KEY_ROLE = 'em-demo-role';
const STORAGE_KEY_USER = 'em-session-user';

function userForRole(role: Role): SessionUser {
  const m = mockUsers.find((u) => u.role === role) ?? mockUsers[0];
  return { id: m.id, name: m.name, email: m.email, role: m.role };
}

export function DemoProvider({
  children,
  initialRole = 'admin',
}: {
  children: ReactNode;
  initialRole?: Role;
}) {
  const [role, setRoleState] = useState<Role>(initialRole);
  const [override, setOverride] = useState<SessionUser | null>(null);

  // Hidratar desde localStorage tras el montaje (evita mismatch SSR).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const storedRole = window.localStorage.getItem(STORAGE_KEY_ROLE) as Role | null;
    if (storedRole) setRoleState(storedRole);
    const storedUser = window.localStorage.getItem(STORAGE_KEY_USER);
    if (storedUser) {
      try {
        setOverride(JSON.parse(storedUser) as SessionUser);
      } catch {
        // JSON corrupto — lo limpiamos para evitar arrastrar el problema.
        window.localStorage.removeItem(STORAGE_KEY_USER);
      }
    }
  }, []);

  const setRole = useCallback((next: Role) => {
    setRoleState(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY_ROLE, next);
    }
  }, []);

  const setUser = useCallback((next: SessionUser | null) => {
    setOverride(next);
    if (typeof window !== 'undefined') {
      if (next) {
        window.localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(next));
        window.localStorage.setItem(STORAGE_KEY_ROLE, next.role);
        setRoleState(next.role);
      } else {
        window.localStorage.removeItem(STORAGE_KEY_USER);
      }
    }
  }, []);

  const user = override ?? userForRole(role);

  return (
    <DemoContext.Provider value={{ role, user, setRole, setUser }}>
      {children}
    </DemoContext.Provider>
  );
}

export function useDemo(): DemoContextValue {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error('useDemo debe usarse dentro de DemoProvider');
  return ctx;
}
