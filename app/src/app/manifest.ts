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
    orientation: 'portrait',
    // Los PNGs de Android Chrome se declaran DOS veces: una como
    // `purpose: 'any'` (icono normal, sin recorte) y otra como
    // `purpose: 'maskable'` (Android los escala/recorta él mismo a la
    // silueta del launcher — círculo, cuadrado redondeado, etc.).
    // El web manifest spec permite "any maskable" en una sola entrada
    // pero el tipo de Next.js solo acepta un purpose por entrada;
    // duplicar la entrada da el mismo efecto y queda explícito.
    icons: [
      {
        src: '/android-chrome-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/android-chrome-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/android-chrome-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/android-chrome-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/apple-touch-icon.png',
        sizes: '180x180',
        type: 'image/png',
      },
      {
        src: '/favicon.ico',
        sizes: '48x48',
        type: 'image/x-icon',
      },
    ],
  };
}
