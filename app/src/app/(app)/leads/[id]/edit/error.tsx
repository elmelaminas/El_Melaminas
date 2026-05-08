'use client';

import { useEffect } from 'react';

export default function EditLeadError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error('[leads/[id]/edit error.tsx]', error);
  }, [error]);

  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar el editor</h1>
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
