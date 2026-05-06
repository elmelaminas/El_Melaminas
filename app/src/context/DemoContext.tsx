/* ═══════════════════════════════════════════
   DEMO CONTEXT — EL MELAMINAS
   Mantiene el rol activo y el usuario simulado.
   En producción esto vendrá de Supabase Auth.
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
import { mockUsers, type MockUser, type Role } from '@/data/mock';

interface DemoContextValue {
  role: Role;
  user: MockUser;
  setRole: (role: Role) => void;
}

const DemoContext = createContext<DemoContextValue | undefined>(undefined);

const STORAGE_KEY = 'em-demo-role';

function userForRole(role: Role): MockUser {
  return mockUsers.find((u) => u.role === role) ?? mockUsers[0];
}

export function DemoProvider({
  children,
  initialRole = 'admin',
}: {
  children: ReactNode;
  initialRole?: Role;
}) {
  const [role, setRoleState] = useState<Role>(initialRole);

  // Hidratar desde localStorage tras el montaje (evita mismatch SSR)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(STORAGE_KEY) as Role | null;
    if (stored) setRoleState(stored);
  }, []);

  const setRole = useCallback((next: Role) => {
    setRoleState(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  }, []);

  const user = userForRole(role);

  return (
    <DemoContext.Provider value={{ role, user, setRole }}>
      {children}
    </DemoContext.Provider>
  );
}

export function useDemo(): DemoContextValue {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error('useDemo debe usarse dentro de DemoProvider');
  return ctx;
}
