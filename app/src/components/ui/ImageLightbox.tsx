'use client';

import { useEffect } from 'react';
import { X, ExternalLink } from 'lucide-react';

/**
 * Lightbox simple para mostrar imágenes en pantalla completa.
 *
 * Comportamiento:
 *   - Overlay oscuro fullscreen, bloquea scroll del body mientras
 *     está abierto.
 *   - La imagen se centra y respeta `max-width: 90vw` /
 *     `max-height: 88vh`. Sin zoom (KISS); si más adelante quieres
 *     pinch-to-zoom o pan, considera react-photo-view.
 *   - Cerrar:
 *       · click en overlay (no en la imagen),
 *       · botón X arriba a la derecha,
 *       · tecla Escape.
 *   - Botón secundario "Abrir original" abre el src en una nueva
 *     pestaña — útil cuando el usuario quiere descargar o inspeccionar
 *     metadata.
 *
 * Uso reutilizable en payments y admin/entregas (Grupo 4).
 */
export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  // Cerrar con Escape. Mounted/unmounted listener — el componente
  // padre controla la apertura, así que cuando el lightbox se
  // desmonta, el listener se limpia automáticamente.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    // Bloquear scroll del body (visualmente más limpio cuando el
    // overlay ocupa todo). Restauramos el overflow original al cerrar.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div
      // role/aria-* para accesibilidad: lectores de pantalla anuncian
      // que es un dialog modal.
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        background: 'rgba(15,23,42,0.85)',
        padding: 16,
        // Animación fade-in suave; respeta prefers-reduced-motion via
        // CSS global si existe la clase animate-fade.
        animation: 'fadeIn 120ms ease',
      }}
      onClick={onClose}
    >
      {/* Botón X — esquina superior derecha. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="btn btn-ghost"
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          padding: 8,
          background: 'rgba(255,255,255,0.1)',
          color: '#fff',
          borderRadius: 999,
        }}
        aria-label="Cerrar"
      >
        <X size={20} />
      </button>

      {/* Botón "Abrir original" — esquina superior izquierda. Útil
          cuando el usuario quiere descargar el archivo o ver metadata. */}
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="btn btn-ghost"
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          padding: '6px 12px',
          background: 'rgba(255,255,255,0.1)',
          color: '#fff',
          borderRadius: 6,
          fontSize: '0.875rem',
          textDecoration: 'none',
        }}
        aria-label="Abrir imagen en una nueva pestaña"
      >
        <ExternalLink size={14} /> Abrir original
      </a>

      {/* Imagen — stopPropagation para que un click sobre ella NO
          cierre el lightbox (solo lo hace el click en el overlay). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '90vw',
          maxHeight: '88vh',
          objectFit: 'contain',
          borderRadius: 8,
          background: '#1e293b',
          // Sombra suave para separarla del overlay sin distraer.
          boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
        }}
      />
    </div>
  );
}
