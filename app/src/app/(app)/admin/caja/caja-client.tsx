'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { CircleCheckBig, Loader, Wallet } from 'lucide-react';
import { formatMXN } from '@/data/mock';
import { validarEfectivoAction } from './actions';

export type TransferRow = {
  id: string;
  driver_name: string;
  contador_name: string;
  amount: number;
  created_at: string | null;
  notes: string | null;
};

/**
 * Tabla de transferencias en estado 'recibido' (esperan validación del
 * admin). Cada fila tiene un botón "Validar pago" que dispara
 * validarEfectivoAction(transfer_id).
 *
 * Cada fila lleva su propio state pending/error para no bloquear toda la
 * tabla cuando el admin valida una sola.
 */
export function CajaClient({
  transfers,
  grandTotal,
}: {
  transfers: TransferRow[];
  grandTotal: number;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Validar Caja</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Confirma que el contador te entregó físicamente el efectivo
          que recibió de cada chofer.
        </p>
      </div>

      {/* Total pendiente de validar */}
      <div
        className="card p-6 flex items-center gap-4"
        style={{
          background:
            grandTotal > 0
              ? 'linear-gradient(135deg, #FEF3C7 0%, #FFFBEB 100%)'
              : 'var(--bg-subtle)',
          border:
            grandTotal > 0
              ? '1px solid rgba(217,119,6,0.25)'
              : '1px solid var(--border)',
        }}
      >
        <div
          className="flex items-center justify-center"
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            background: grandTotal > 0 ? '#D97706' : 'var(--text-tertiary)',
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
              color: grandTotal > 0 ? '#92400E' : 'var(--text-tertiary)',
              fontWeight: 600,
            }}
          >
            Pendiente de validar
          </div>
          <div
            className="text-3xl font-bold leading-tight mt-1"
            style={{
              color: grandTotal > 0 ? '#92400E' : 'var(--text-tertiary)',
            }}
          >
            {formatMXN(grandTotal)}
          </div>
          <div
            className="text-xs mt-1"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {transfers.length}{' '}
            {transfers.length === 1
              ? 'transferencia esperando validación'
              : 'transferencias esperando validación'}
          </div>
        </div>
      </div>

      <div className="tbl-wrap">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Chofer</th>
                <th>Contador</th>
                <th>Monto</th>
                <th>Recibido</th>
                <th className="text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {transfers.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    No hay efectivo pendiente de validar.
                  </td>
                </tr>
              ) : (
                transfers.map((t) => <Row key={t.id} transfer={t} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Row({ transfer }: { transfer: TransferRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleValidate = () => {
    setError(null);
    const fd = new FormData();
    fd.set('transfer_id', transfer.id);

    startTransition(async () => {
      try {
        const r = await validarEfectivoAction({ status: 'idle' }, fd);
        if (r.status === 'success') {
          // Marcamos done para feedback visual antes del refresh.
          setDone(true);
          router.refresh();
        } else if (r.status === 'error') {
          setError(r.message);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error de red';
        setError(message);
      }
    });
  };

  return (
    <tr
      style={{
        opacity: done ? 0.4 : 1,
        transition: 'opacity 200ms ease',
      }}
    >
      <td className="font-medium">{transfer.driver_name}</td>
      <td className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {transfer.contador_name}
      </td>
      <td className="font-bold" style={{ color: '#15803D' }}>
        {formatMXN(transfer.amount)}
      </td>
      <td className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {formatDate(transfer.created_at)}
      </td>
      <td>
        <div className="flex justify-end items-center gap-2">
          {error && (
            <span
              className="text-xs"
              style={{ color: 'var(--danger, #dc2626)' }}
              role="alert"
            >
              {error}
            </span>
          )}
          <button
            type="button"
            className="btn btn-primary"
            style={{ padding: '6px 14px', fontSize: '0.875rem' }}
            onClick={handleValidate}
            disabled={pending || done}
            aria-busy={pending}
          >
            {pending ? (
              <>
                <Loader size={14} className="animate-spin" />
                <span style={{ marginLeft: 6 }}>Validando…</span>
              </>
            ) : (
              <>
                <CircleCheckBig size={14} /> Validar pago
              </>
            )}
          </button>
        </div>
      </td>
    </tr>
  );
}

function formatDate(iso: string | null): string {
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
