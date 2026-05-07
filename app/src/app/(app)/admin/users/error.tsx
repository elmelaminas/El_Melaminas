'use client';

/**
 * Error boundary del segmento /admin/users.
 *
 * Red de seguridad: el `try/catch` de `page.tsx` ya cubre throws síncronos del
 * Server Component (env vars faltantes, etc.) y los pinta como `<ErrorState>`.
 * Este boundary captura lo que escape — típicamente bugs de render en
 * `<UsersClient>` (Client Component) o throws posteriores al inicio de stream.
 *
 * Nota Next 16: el prop es `unstable_retry`, no `reset`. La doc explícita:
 * "In most cases, you should use unstable_retry() instead" — re-ejecuta el
 * Server Component (re-fetch) además de re-renderizar, mientras que `reset`
 * solo limpiaba el state del boundary. Ver
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md
 *
 * También la doc avisa: en producción los errores que provienen de Server
 * Components llegan al cliente con `message` genérico + un `digest` para
 * correlacionar con Vercel logs. Por eso mostramos el digest visible — el
 * admin lo puede pegar en logs para identificar el throw exacto.
 */

import { useEffect } from 'react';

export default function AdminUsersError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error('[admin/users error.tsx]', error);
  }, [error]);

  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar usuarios</h1>
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
