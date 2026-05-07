'use client';

/**
 * Error boundary del segmento /leads. Mismo patrón que /admin/users,
 * /admin/catalogs y /leads/new: el try/catch de page.tsx atrapa los
 * throws síncronos del Server Component y los pinta como `<ErrorState>`.
 * Este boundary captura lo que escape — bugs en LeadsClient durante
 * hydration, throws posteriores al inicio de stream, etc.
 *
 * Nota Next 16: prop es `unstable_retry` (añadido en 16.2.0).
 */

import { useEffect } from 'react';

export default function LeadsError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error('[leads error.tsx]', error);
  }, [error]);

  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar los leads</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {error.message || 'Error inesperado al renderizar la página.'}
      </p>
      {error.digest && (
        <p
          className="text-xs mt-2 font-mono"
          style={{ color: 'var(--text-tertiary)' }}
        >
          digest: {error.digest}
        </p>
      )}
      <div className="flex gap-2 mt-4">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => unstable_retry()}
        >
          Reintentar
        </button>
      </div>
    </div>
  );
}
