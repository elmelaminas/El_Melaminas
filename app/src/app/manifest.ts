import type { MetadataRoute } from 'next';

/**
 * Web App Manifest — habilita la instalación PWA en Android y la
 * pantalla de inicio "Agregar a inicio".
 *
 * Todos los íconos son archivos estáticos en `public/`, exportados
 * desde favicon.io a partir del logo oficial de EL MELAMINAS. La
 * convención `icon.tsx`/`apple-icon.tsx` de Next se eliminó: ahora
 * `public/favicon.ico` y `public/apple-touch-icon.png` los detecta
 * Next automáticamente para `<link rel="icon">` y
 * `<link rel="apple-touch-icon">` en el head.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'EL MELAMINAS',
    short_name: 'Melaminas',
    description: 'Sistema de Gestión Operativa',
    start_url: '/',
    display: 'standalone',
    background_color: '#F5F0E8',
    theme_color: '#8B6914',
    icons: [
      {
        src: '/android-chrome-192x192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/android-chrome-512x512.png',
        sizes: '512x512',
        type: 'image/png',
      },
      {
        src: '/apple-touch-icon.png',
        sizes: '180x180',
        type: 'image/png',
      },
    ],
  };
}
