'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { DollarSign, Loader, CircleCheckBig, Wallet } from 'lucide-react';
import { formatMXN } from '@/data/mock';
import { recibirEfectivoAction } from './actions';

export type DriverWithCash = {
  driver_id: string;
  driver_name: string;
  amount: number;
};

/**
 * Una fila del historial personal del contador. `status` cubre los dos
 * estados post-pendiente (recibido = sigue esperando validación del
 * admin; validado = el ciclo terminó).
 */
export type HistoryRow = {
  id: string;
  driver_name: string;
  amount: number;
  status: 'recibido' | 'validado';
  created_at: string | null;
};

/**
 * Vista del contador.
 *
 * Layout:
 *   - Card grande arriba con el TOTAL en caja (suma de todos los choferes
 *     con efectivo pendiente).
 *   - Dropdown para seleccionar un chofer (si hay >1 con pendiente).
 *   - Card del chofer seleccionado: muestra su monto y un botón grande
 *     "Recibí efectivo de {nombre}".
 *   - Lista compacta debajo con cada chofer y su monto, para vista global.
 *
 * El submit no usa RHF (un solo dato: driver_id). Construimos FormData
 * mínimo para reusar el patrón de los demás actions.
 */
export function ContadorClient({
  drivers,
  grandTotal,
  history,
}: {
  drivers: DriverWithCash[];
  grandTotal: number;
  /** Últimas 20 transferencias que este contador recibió (recibido +
   *  validado). Para que pueda ver qué ya entregó al admin y qué sigue
   *  esperando validación. */
  history: HistoryRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useState<string>(drivers[0]?.driver_id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const selected = drivers.find((d) => d.driver_id === selectedId);

  const handleReceive = () => {
    setError(null);
    setSuccess(null);
    if (!selected) {
      setError('Selecciona un chofer.');
      return;
    }

    const fd = new FormData();
    fd.set('driver_id', selected.driver_id);

    startTransition(async () => {
      try {
        const result = await recibirEfectivoAction({ status: 'idle' }, fd);
        if (result.status === 'success') {
          setSuccess(
            `Recibiste ${formatMXN(result.received)} de ${selected.driver_name}.`,
          );
          // Refresh para que el server re-corra y la lista de choferes
          // pendientes se actualice (este chofer baja a 0 y desaparece).
          router.refresh();
        } else if (result.status === 'error') {
          let combined = result.message;
          if (result.fieldErrors) {
            const lines = Object.entries(result.fieldErrors)
              .filter(([, msgs]) => msgs && msgs[0])
              .map(([path, msgs]) => `· ${path}: ${msgs?.[0]}`);
            if (lines.length > 0) combined = `${result.message}\n${lines.join('\n')}`;
          }
          setError(combined);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error de red';
        console.error('[ContadorClient] excepción:', err);
        setError(message);
      }
    });
  };

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold">Caja</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Recibe el efectivo que los choferes traen de las entregas.
        </p>
      </div>

      {/* Total en caja */}
      <div
        className="card p-6 flex items-center gap-4"
        style={{
          background:
            grandTotal > 0
              ? 'linear-gradient(135deg, #DCFCE7 0%, #F0FDF4 100%)'
              : 'var(--bg-subtle)',
          border:
            grandTotal > 0
              ? '1px solid rgba(22,163,74,0.25)'
              : '1px solid var(--border)',
        }}
      >
        <div
          className="flex items-center justify-center"
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            background: grandTotal > 0 ? '#16A34A' : 'var(--text-tertiary)',
            color: '#fff',
            flexShrink: 0,
          }}
        >
          <Wallet size={28} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="text-xs uppercase tracking-wide"
            style={{
              color: grandTotal > 0 ? '#15803D' : 'var(--text-tertiary)',
              fontWeight: 600,
            }}
          >
            Efectivo pendiente total
          </div>
          <div
            className="text-3xl font-bold leading-tight mt-1"
            style={{
              color: grandTotal > 0 ? '#15803D' : 'var(--text-tertiary)',
            }}
          >
            {formatMXN(grandTotal)}
          </div>
          <div
            className="text-xs mt-1"
            style={{ color: 'var(--text-tertiary)' }}
          >
            Distribuido entre {drivers.length}{' '}
            {drivers.length === 1 ? 'chofer' : 'choferes'}
          </div>
        </div>
      </div>

      {drivers.length === 0 ? (
        <div
          className="card p-8 text-center text-sm"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Ningún chofer trae efectivo pendiente en este momento.
        </div>
      ) : (
        <>
          {/* Selector + acción */}
          <div className="card p-6">
            <label className="label">Chofer</label>
            <select
              className="select"
              value={selectedId}
              onChange={(e) => {
                setSelectedId(e.target.value);
                setError(null);
                setSuccess(null);
              }}
              disabled={pending}
            >
              {drivers.map((d) => (
                <option key={d.driver_id} value={d.driver_id}>
                  {d.driver_name} — {formatMXN(d.amount)}
                </option>
              ))}
            </select>

            {selected && (
              <div
                className="mt-4 p-4 rounded-lg flex items-center gap-3"
                style={{
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border)',
                }}
              >
                <DollarSign
                  size={20}
                  style={{ color: '#16A34A', flexShrink: 0 }}
                />
                <div className="text-sm" style={{ flex: 1 }}>
                  <strong>{selected.driver_name}</strong> trae{' '}
                  <strong>{formatMXN(selected.amount)}</strong> en efectivo.
                </div>
              </div>
            )}

            {error && (
              <div
                role="alert"
                className="text-sm mt-4"
                style={{
                  color: 'var(--danger, #dc2626)',
                  background: 'var(--danger-bg, rgba(220,38,38,0.08))',
                  border: '1px solid rgba(220,38,38,0.25)',
                  padding: '8px 12px',
                  borderRadius: 6,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {error}
              </div>
            )}

            {success && !pending && (
              <div
                role="status"
                className="text-sm mt-4 flex items-start gap-2"
                style={{
                  color: 'var(--success, #15803D)',
                  background: 'var(--success-bg, rgba(22,163,74,0.08))',
                  border: '1px solid rgba(22,163,74,0.25)',
                  padding: '8px 12px',
                  borderRadius: 6,
                }}
              >
                <CircleCheckBig
                  size={16}
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
                <span>{success}</span>
              </div>
            )}

            <button
              type="button"
              onClick={handleReceive}
              className="btn btn-primary w-full mt-4"
              style={{ height: 48, fontSize: '1rem', fontWeight: 600 }}
              disabled={pending || !selected}
              aria-busy={pending}
            >
              {pending ? (
                <>
                  <Loader size={18} className="animate-spin" />
                  <span style={{ marginLeft: 6 }}>Registrando…</span>
                </>
              ) : selected ? (
                <>Recibí efectivo de {selected.driver_name.split(' ')[0]}</>
              ) : (
                'Selecciona un chofer'
              )}
            </button>
          </div>

          {/* Lista compacta de TODOS los choferes con pendientes */}
          <div className="tbl-wrap">
            <div
              className="px-6 py-4 border-b"
              style={{ borderColor: 'var(--border)' }}
            >
              <h3 className="font-semibold">Choferes con efectivo pendiente</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Chofer</th>
                    <th className="text-right">Efectivo</th>
                  </tr>
                </thead>
                <tbody>
                  {drivers.map((d) => (
                    <tr
                      key={d.driver_id}
                      style={{
                        background:
                          d.driver_id === selectedId ? '#EFF6FF' : undefined,
                      }}
                    >
                      <td className="font-medium">{d.driver_name}</td>
                      <td
                        className="text-right font-bold"
                        style={{ color: '#15803D' }}
                      >
                        {formatMXN(d.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Historial personal — siempre visible aunque no haya pendientes */}
      <div className="tbl-wrap">
        <div
          className="px-6 py-4 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          <h3 className="font-semibold">Historial de efectivo recibido</h3>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            Tus últimas 20 recepciones. Estado{' '}
            <span className="badge badge-info" style={{ fontSize: '0.6875rem' }}>
              Recibido
            </span>{' '}
            = esperando validación del admin;{' '}
            <span
              className="badge badge-success"
              style={{ fontSize: '0.6875rem' }}
            >
              Validado
            </span>{' '}
            = ciclo cerrado.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Chofer</th>
                <th className="text-right">Monto</th>
                <th>Fecha</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="text-center py-6 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Aún no has recibido efectivo de ningún chofer.
                  </td>
                </tr>
              ) : (
                history.map((h) => (
                  <tr key={h.id}>
                    <td className="font-medium">{h.driver_name}</td>
                    <td
                      className="text-right font-bold"
                      style={{ color: '#15803D' }}
                    >
                      {formatMXN(h.amount)}
                    </td>
                    <td
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {formatDateTime(h.created_at)}
                    </td>
                    <td>
                      {h.status === 'validado' ? (
                        <span className="badge badge-success">Validado</span>
                      ) : (
                        <span className="badge badge-info">Recibido</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
