import type { MetadataRoute } from 'next';

/**
 * Web App Manifest — habilita la instalación PWA en Android y la
 * pantalla de inicio "Agregar a inicio". El `apple-icon.tsx` ya cubre
 * iOS vía `<link rel="apple-touch-icon">` en el head, así que no lo
 * referenciamos acá.
 *
 * Los iconos 192 y 512 son las rutas servidas por `/icon-192` y
 * `/icon-512` (route handlers que devuelven `ImageResponse`).
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
      { src: '/icon-192', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512', sizes: '512x512', type: 'image/png' },
    ],
  };
}
