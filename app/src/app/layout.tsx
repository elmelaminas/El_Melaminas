import type { Metadata, Viewport } from 'next';
import './globals.css';
import { DemoProvider } from '@/context/DemoContext';

export const metadata: Metadata = {
  title: 'EL MELAMINAS',
  description: 'Sistema de Gestión Operativa',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'EL MELAMINAS',
  },
};

// `themeColor` se declara en `viewport` (no en `metadata`) desde
// Next 14 — exportarlo en `metadata` muestra un warning.
export const viewport: Viewport = {
  themeColor: '#8B6914',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es-MX">
      <body>
        <DemoProvider>{children}</DemoProvider>
      </body>
    </html>
  );
}
