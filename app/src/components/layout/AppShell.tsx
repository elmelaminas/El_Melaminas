'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar from './Sidebar';
import Header from './Header';
import { useDemo } from '@/context/DemoContext';
import { useAutoStartTour } from '@/components/ui/AppTour';
import { usePageTour } from '@/hooks/usePageTour';

/**
 * AppShell — wrapper client component que envuelve la layout privada.
 *
 * Responsabilidades:
 *   - Mantiene el state `sidebarOpen` (drawer móvil).
 *   - Cierra el sidebar automáticamente al cambiar de ruta — UX
 *     estándar: el usuario clickea un nav-link, navega, y el drawer no
 *     se queda abierto tapando el contenido nuevo.
 *   - Renderiza el backdrop oscuro cuando el drawer está abierto en
 *     mobile; clic en el backdrop cierra.
 *
 * En desktop (>= lg, 1024px) el sidebar siempre está visible (CSS
 * `@media (max-width: 1024px)` en globals.css le aplica
 * `transform: translateX(-100%)` solo bajo ese breakpoint), así que
 * `sidebarOpen` no afecta la layout en pantallas grandes.
 *
 * El layout (`<main>`) usa `lg:ml-[var(--sidebar-width)]` para reservar
 * el ancho del sidebar SOLO en desktop. En mobile no hay margin —
 * el sidebar flota encima del contenido cuando se abre.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { role } = useDemo();

  // Auto-iniciar el tour la PRIMERA vez que el usuario entra a la
  // zona autenticada (gate por localStorage 'em_tour_completed').
  // Si el usuario aterrizó en una ruta con tour contextual, ese tour
  // se prefiere sobre el de rol (más relevante para donde está).
  // El hook tiene un delay corto para que Sidebar/Header/contenido ya
  // estén montados cuando driver.js resuelva los selectores.
  const pageSteps = usePageTour();
  useAutoStartTour(role, pageSteps);

  // Auto-close al cambiar de ruta. usePathname dispara con la URL nueva
  // antes de que el contenido del child re-renderee, así que el drawer
  // se cierra en el mismo tick que la navegación.
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  // Bloquear scroll del body cuando el drawer está abierto en mobile.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (sidebarOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [sidebarOpen]);

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-app)' }}>
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Backdrop — solo visible en mobile cuando el drawer está abierto */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 lg:hidden"
          style={{
            background: 'rgba(15,23,42,0.45)',
            zIndex: 35, // entre header (30) y sidebar (40)
          }}
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <div className="lg:ml-[var(--sidebar-width)]">
        <Header onMenuClick={() => setSidebarOpen(true)} />
        <main className="px-4 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-8 animate-fade">
          {children}
        </main>
      </div>
    </div>
  );
}
