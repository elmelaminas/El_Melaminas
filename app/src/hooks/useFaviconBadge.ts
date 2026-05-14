'use client';

/**
 * Actualiza el favicon de la pestaña con un badge rojo en la esquina
 * superior derecha que muestra el contador de notificaciones no
 * leídas. Patrón clásico de Gmail/Slack — el usuario ve "hay algo
 * nuevo" sin necesidad de tener la pestaña activa.
 *
 * Estrategia:
 *   - Dibujamos un favicon de 32x32 sobre un <canvas> en memoria:
 *     fondo azul redondeado con "EM" + círculo rojo con N en la
 *     esquina superior derecha cuando count > 0.
 *   - Reemplazamos el <link rel="icon"> del <head> con el
 *     `canvas.toDataURL('image/png')`. Si no había link previo, lo
 *     creamos.
 *   - Cleanup: al desmontar restauramos el favicon original
 *     (/favicon.ico). Cuando el `count` cambia, el cleanup también
 *     corre y la fase de set vuelve a pintar — el flicker es
 *     imperceptible (~1 frame).
 *
 * Caveats:
 *   - `roundRect` requiere navegadores modernos (Chrome 99+, Firefox
 *     113+, Safari 16+). Si falla, caemos a `fillRect` cuadrado —
 *     suficiente como fallback.
 *   - Algunos navegadores cachean favicons agresivamente; el
 *     toDataURL cambia el bytestring cada vez, así que el browser
 *     debería actualizar. Si no, sumarle `?t=${Date.now()}` al href
 *     fuerza el refresh — no es necesario en testing.
 *   - SSR-safe: el primer chequeo bloquea si `typeof window ===
 *     'undefined'` para que el bundle del server no truene.
 */

import { useEffect } from 'react';

export function useFaviconBadge(count: number): void {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Fondo redondeado azul con "EM" centrado. roundRect puede no
    // existir en navegadores muy viejos — caemos a fillRect cuadrado.
    ctx.fillStyle = '#1B3A5C';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(0, 0, 32, 32, 6);
    } else {
      ctx.rect(0, 0, 32, 32);
    }
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('EM', 16, 16);

    // Badge rojo solo si hay notificaciones pendientes.
    if (count > 0) {
      ctx.fillStyle = '#DC2626';
      ctx.beginPath();
      ctx.arc(26, 6, 8, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(count > 9 ? '9+' : String(count), 26, 6);
    }

    // Reemplazar (o crear) el <link rel="icon"> del <head>. Si ya
    // existe uno, lo reutilizamos para no acumular múltiples nodos.
    let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    const createdHere = !link;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL('image/png');
    } catch (e) {
      // toDataURL puede tirar SecurityError si el canvas se cruzó
      // con una imagen tainted — no es nuestro caso (todo se dibuja
      // en cliente puro), pero por seguridad logueamos y abortamos.
      console.error('[useFaviconBadge] toDataURL falló:', e);
      return;
    }
    const previousHref = link.href;
    link.href = dataUrl;

    return () => {
      // Cleanup: al desmontar o cambiar `count`, restauramos. Si NO
      // creamos el link nosotros, volvemos al href previo (puede ser
      // el favicon original o un dataUrl anterior). Si lo creamos,
      // limpiamos el nodo del DOM.
      if (createdHere && link) {
        try {
          document.head.removeChild(link);
        } catch {
          /* swallow — el nodo pudo haber sido removido por otro hook */
        }
      } else if (link) {
        link.href = previousHref || '/favicon.ico';
      }
    };
  }, [count]);
}
