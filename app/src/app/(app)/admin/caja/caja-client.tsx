'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useState, useTransition } from 'react';
import { CircleCheckBig, Loader, Wallet, ClipboardList } from 'lucide-react';
import { formatMXN } from '@/data/mock';
import { validarEfectivoAction } from './actions';

export type TransferRow = {
  id: string;
  driver_name: string;
  contador_name: string;
  /** Nombre del admin que validó. '—' si está pendiente. */
  admin_name: string;
  amount: number;
  /** Cuándo el contador marcó "Recibí efectivo". */
  created_at: string | null;
  /** Cuándo el admin marcó "Validar pago". null si está pendiente. */
  admin_validated_at: string | null;
  notes: string | null;
};

type TabKey = 'por-validar' | 'validados';

/**
 * UI de /admin/caja con dos pestañas controladas por searchParam.
 *
 * Tab "Por validar" (status='recibido'):
 *   - Tabla: Chofer | Contador | Monto | Fecha recibido | botón "Validar"
 *   - Header: tarjeta amarilla con total pendiente.
 *
 * Tab "Validados" (status='validado'):
 *   - Tabla: Chofer | Contador | Monto | Fecha recibido | Fecha validado |
 *            Admin que validó.
 *   - Header: tarjeta verde con TOTAL VALIDADO del mes calendario actual.
 *   - Badge "Validado" verde por fila.
 *
 * Cada fila de "Por validar" tiene su propio estado pending/error para
 * no bloquear la tabla cuando el admin valida una sola.
 */
export function CajaClient({
  tab,
  pendingTransfers,
  validatedTransfers,
  pendingGrandTotal,
  validatedThisMonthTotal,
}: {
  tab: TabKey;
  pendingTransfers: TransferRow[];
  validatedTransfers: TransferRow[];
  pendingGrandTotal: number;
  validatedThisMonthTotal: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();

  function selectTab(next: TabKey) {
    const params = new URLSearchParams();
    if (next !== 'por-validar') params.set('tab', next);
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Validar Caja</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Confirma el efectivo recibido por el contador y revisa el
          historial validado.
        </p>
      </div>

      {/* Tabs */}
      <div
        className="flex gap-2"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <TabButton
          active={tab === 'por-validar'}
          onClick={() => selectTab('por-validar')}
        >
          <ClipboardList size={16} /> Por validar
          <span
            className="text-xs"
            style={{
              padding: '2px 8px',
              borderRadius: 9999,
              background: 'var(--bg-subtle)',
              color: 'var(--text-tertiary)',
            }}
          >
            {pendingTransfers.length}
          </span>
        </TabButton>
        <TabButton
          active={tab === 'validados'}
          onClick={() => selectTab('validados')}
        >
          <CircleCheckBig size={16} /> Validados
          <span
            className="text-xs"
            style={{
              padding: '2px 8px',
              borderRadius: 9999,
              background: 'var(--bg-subtle)',
              color: 'var(--text-tertiary)',
            }}
          >
            {validatedTransfers.length}
          </span>
        </TabButton>
      </div>

      {tab === 'por-validar' ? (
        <PendingTab
          transfers={pendingTransfers}
          grandTotal={pendingGrandTotal}
        />
      ) : (
        <ValidatedTab
          transfers={validatedTransfers}
          monthTotal={validatedThisMonthTotal}
        />
      )}
    </div>
  );
}

function PendingTab({
  transfers,
  grandTotal,
}: {
  transfers: TransferRow[];
  grandTotal: number;
}) {
  return (
    <>
      {/* Total pendiente — accent amarillo */}
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
              ? 'transferencia esperando'
              : 'transferencias esperando'}{' '}
            validación
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
                <th>Estado</th>
                <th className="text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {transfers.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    No hay efectivo pendiente de validar.
                  </td>
                </tr>
              ) : (
                transfers.map((t) => <PendingRow key={t.id} transfer={t} />)
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function ValidatedTab({
  transfers,
  monthTotal,
}: {
  transfers: TransferRow[];
  monthTotal: number;
}) {
  return (
    <>
      {/* Total del mes validado — accent verde */}
      <div
        className="card p-6 flex items-center gap-4"
        style={{
          background:
            monthTotal > 0
              ? 'linear-gradient(135deg, #DCFCE7 0%, #F0FDF4 100%)'
              : 'var(--bg-subtle)',
          border:
            monthTotal > 0
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
            background: monthTotal > 0 ? '#16A34A' : 'var(--text-tertiary)',
            color: '#fff',
            flexShrink: 0,
          }}
        >
          <CircleCheckBig size={28} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="text-xs uppercase tracking-wide"
            style={{
              color: monthTotal > 0 ? '#15803D' : 'var(--text-tertiary)',
              fontWeight: 600,
            }}
          >
            Total validado este mes
          </div>
          <div
            className="text-3xl font-bold leading-tight mt-1"
            style={{
              color: monthTotal > 0 ? '#15803D' : 'var(--text-tertiary)',
            }}
          >
            {formatMXN(monthTotal)}
          </div>
          <div
            className="text-xs mt-1"
            style={{ color: 'var(--text-tertiary)' }}
          >
            Mes calendario actual
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
                <th>Validado</th>
                <th>Admin</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {transfers.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Aún no hay transferencias validadas.
                  </td>
                </tr>
              ) : (
                transfers.map((t) => (
                  <tr key={t.id}>
                    <td className="font-medium">{t.driver_name}</td>
                    <td
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {t.contador_name}
                    </td>
                    <td className="font-bold" style={{ color: '#15803D' }}>
                      {formatMXN(t.amount)}
                    </td>
                    <td
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {formatDate(t.created_at)}
                    </td>
                    <td
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {formatDate(t.admin_validated_at)}
                    </td>
                    <td
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {t.admin_name}
                    </td>
                    <td>
                      <span className="badge badge-success">Validado</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function PendingRow({ transfer }: { transfer: TransferRow }) {
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
        <span className="badge badge-warning">Pendiente</span>
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
                <CircleCheckBig size={14} /> Validar
              </>
            )}
          </button>
        </div>
      </td>
    </tr>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 px-4 py-2 text-sm font-medium"
      style={{
        color: active ? 'var(--brand-primary)' : 'var(--text-secondary)',
        borderBottom: active
          ? '2px solid var(--brand-primary)'
          : '2px solid transparent',
        marginBottom: -1,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
      }}
      aria-pressed={active}
    >
      {children}
    </button>
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
