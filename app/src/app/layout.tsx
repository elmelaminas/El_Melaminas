import type { Metadata, Viewport } from 'next';
import './globals.css';
import { DemoProvider } from '@/context/DemoContext';

export const metadata: Metadata = {
  title: 'EL MELAMINAS',
  description: 'Sistema de Gestión Operativa',
  // Link explícito al manifest. Next.js lo expone automáticamente
  // cuando hay `manifest.ts`, pero declararlo aquí garantiza el
  // `<link rel="manifest">` tal cual lo busca Android al instalar.
  manifest: '/manifest.webmanifest',
  // Iconos para el `<head>`. Next ya los detecta por convención
  // (favicon.ico / apple-touch-icon.png en `public/`), pero
  // explicitar `icon` + `apple` + `shortcut` blinda contra cualquier
  // overlay que tenga el plugin de PWA del navegador.
  icons: {
    icon: '/favicon.ico',
    apple: '/apple-touch-icon.png',
    shortcut: '/favicon.ico',
  },
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
  // Fija el color scheme para que Android y Chrome no apliquen
  // dark-mode automático sobre el splash/status bar de la PWA.
  colorScheme: 'light',
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
