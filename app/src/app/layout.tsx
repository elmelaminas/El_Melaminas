import type { Metadata } from 'next';
import './globals.css';
import { DemoProvider } from '@/context/DemoContext';

export const metadata: Metadata = {
  title: 'EL MELAMINAS — Sistema de Gestión Operativa',
  description:
    'Prototipo visual del sistema operativo de EL MELAMINAS: leads, pagos, almacén y entregas.',
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
