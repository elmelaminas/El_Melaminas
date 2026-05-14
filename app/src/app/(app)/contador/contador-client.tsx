'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { DollarSign, Loader, CircleCheckBig, Wallet, Banknote } from 'lucide-react';
import { formatMXN } from '@/data/mock';
import { recibirEfectivoAction, receiveAdminCashAction } from './actions';

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
 * Un admin con su saldo en efectivo + cuánto cobró este mes.
 * `balance` es el acumulativo histórico (ingresos - egresos) — lo que
 * el contador "le va a recibir" cuando presione el botón.
 */
export type AdminWithCash = {
  admin_id: string;
  admin_name: string;
  role: 'admin' | 'admin2';
  /** Saldo acumulado: sum(ingresos) - sum(egresos). */
  balance: number;
  /** Cobros en efectivo del mes calendario actual (solo ingresos). */
  this_month: number;
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
  admins,
  adminCashGrandTotal,
}: {
  drivers: DriverWithCash[];
  grandTotal: number;
  /** Últimas 20 transferencias que este contador recibió (recibido +
   *  validado). Para que pueda ver qué ya entregó al admin y qué sigue
   *  esperando validación. */
  history: HistoryRow[];
  /** Lista de admins activos con su saldo acumulado en efectivo + lo
   *  cobrado del mes. Origen: `admin_cash_register`. */
  admins: AdminWithCash[];
  /** Suma del saldo positivo de todos los admins (efectivo total en
   *  manos de admins, pendiente de recibirse). */
  adminCashGrandTotal: number;
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

      {/* ── SECCIÓN 2: Efectivo del administrador (reporte del mes) ──
          Por cada admin activo, cuánto cobró en efectivo en el mes
          calendario actual. Lectura solamente: el botón de "recibir"
          vive en la sección 3 abajo. */}
      <AdminCashReport admins={admins} />

      {/* ── SECCIÓN 3: Validar efectivo del administrador ──
          Por cada admin con balance > 0, botón para que el contador
          marque "Recibí efectivo de {admin_name}". El server calcula
          el monto exacto al ejecutar la acción (anti-race-condition);
          el monto mostrado acá es informativo. */}
      <AdminCashValidator
        admins={admins}
        grandTotal={adminCashGrandTotal}
      />

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

/**
 * Sección informativa: por cada admin activo, cuánto cobró en
 * efectivo durante el mes calendario actual. Tabla simple + card con
 * el total acumulado. Sin acciones.
 */
function AdminCashReport({ admins }: { admins: AdminWithCash[] }) {
  const totalThisMonth = admins.reduce((s, a) => s + a.this_month, 0);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">Efectivo del administrador</h2>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          Cobros en efectivo directos de cada admin durante este mes.
        </p>
      </div>
      <div
        className="card p-4 flex items-center gap-4"
        style={{
          background:
            totalThisMonth > 0
              ? 'linear-gradient(135deg, #E0E7FF 0%, #EEF2FF 100%)'
              : 'var(--bg-subtle)',
          border:
            totalThisMonth > 0
              ? '1px solid rgba(67,56,202,0.25)'
              : '1px solid var(--border)',
        }}
      >
        <div
          className="flex items-center justify-center"
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: totalThisMonth > 0 ? '#4338CA' : 'var(--text-tertiary)',
            color: '#fff',
            flexShrink: 0,
          }}
        >
          <Banknote size={24} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="text-xs uppercase tracking-wide"
            style={{
              color: totalThisMonth > 0 ? '#3730A3' : 'var(--text-tertiary)',
              fontWeight: 600,
            }}
          >
            Total efectivo admin (mes)
          </div>
          <div
            className="text-2xl font-bold leading-tight mt-1"
            style={{
              color: totalThisMonth > 0 ? '#3730A3' : 'var(--text-tertiary)',
            }}
          >
            {formatMXN(totalThisMonth)}
          </div>
        </div>
      </div>

      <div className="tbl-wrap">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Administrador</th>
                <th className="text-right">Efectivo del mes</th>
              </tr>
            </thead>
            <tbody>
              {admins.length === 0 ? (
                <tr>
                  <td
                    colSpan={2}
                    className="text-center py-6 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Sin administradores activos.
                  </td>
                </tr>
              ) : (
                admins.map((a) => (
                  <tr key={a.admin_id}>
                    <td className="font-medium">{a.admin_name}</td>
                    <td
                      className="text-right font-bold"
                      style={{
                        color: a.this_month > 0 ? '#3730A3' : 'var(--text-tertiary)',
                      }}
                    >
                      {formatMXN(a.this_month)}
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

/**
 * Sección accionable: por cada admin con balance > 0, botón "Recibí
 * efectivo de {nombre}". Al click → server action recalcula el monto
 * exacto y lo registra como egreso. Optimismo simple: marcamos la
 * fila como "procesando" hasta que router.refresh trae el estado
 * fresco.
 */
function AdminCashValidator({
  admins,
  grandTotal,
}: {
  admins: AdminWithCash[];
  grandTotal: number;
}) {
  // Solo mostramos admins con balance > 0; el resto no tiene nada
  // que recibir.
  const eligible = admins.filter((a) => a.balance > 0);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">
          Validar efectivo del administrador
        </h2>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          Recibe el efectivo acumulado de cada admin. El monto exacto
          se recalcula al confirmar.
        </p>
      </div>
      <div
        className="card p-4 flex items-center gap-4"
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
            width: 48,
            height: 48,
            borderRadius: 12,
            background: grandTotal > 0 ? '#D97706' : 'var(--text-tertiary)',
            color: '#fff',
            flexShrink: 0,
          }}
        >
          <Wallet size={24} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="text-xs uppercase tracking-wide"
            style={{
              color: grandTotal > 0 ? '#92400E' : 'var(--text-tertiary)',
              fontWeight: 600,
            }}
          >
            Pendiente de admins
          </div>
          <div
            className="text-2xl font-bold leading-tight mt-1"
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
            {eligible.length}{' '}
            {eligible.length === 1 ? 'admin' : 'admins'} con efectivo
          </div>
        </div>
      </div>

      {eligible.length === 0 ? (
        <div
          className="card p-6 text-center text-sm"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Ningún admin tiene efectivo pendiente de recibirse.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {eligible.map((a) => (
            <AdminCashRow key={a.admin_id} admin={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function AdminCashRow({ admin: a }: { admin: AdminWithCash }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleReceive = () => {
    setError(null);
    setSuccess(null);
    const fd = new FormData();
    fd.set('admin_id', a.admin_id);

    startTransition(async () => {
      try {
        const result = await receiveAdminCashAction({ status: 'idle' }, fd);
        if (result.status === 'success') {
          setSuccess(
            `Recibiste ${formatMXN(result.received)} de ${a.admin_name}.`,
          );
          router.refresh();
        } else if (result.status === 'error') {
          setError(result.message);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error de red';
        setError(message);
      }
    });
  };

  return (
    <div
      className="card p-4 flex items-center gap-4 flex-wrap"
      style={{ border: '1px solid var(--border)' }}
    >
      <div
        className="flex items-center justify-center"
        style={{
          width: 40,
          height: 40,
          borderRadius: 9999,
          background: '#4338CA',
          color: '#fff',
          fontWeight: 700,
          fontSize: '0.875rem',
          flexShrink: 0,
        }}
      >
        {a.admin_name.charAt(0).toUpperCase()}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="font-semibold">{a.admin_name}</div>
        <div
          className="text-xs"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Saldo:{' '}
          <strong style={{ color: '#15803D' }}>{formatMXN(a.balance)}</strong>
        </div>
        {error && (
          <div
            role="alert"
            className="text-xs mt-1"
            style={{ color: 'var(--danger, #dc2626)' }}
          >
            {error}
          </div>
        )}
        {success && (
          <div
            role="status"
            className="text-xs mt-1 flex items-center gap-1"
            style={{ color: 'var(--success, #15803D)' }}
          >
            <CircleCheckBig size={12} />
            <span>{success}</span>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={handleReceive}
        disabled={pending}
        className="btn btn-primary"
        style={{ padding: '8px 14px', fontSize: '0.875rem' }}
        aria-busy={pending}
      >
        {pending ? (
          <>
            <Loader size={14} className="animate-spin" />
            <span style={{ marginLeft: 6 }}>Registrando…</span>
          </>
        ) : (
          <>
            <DollarSign size={14} /> Recibí efectivo de {a.admin_name.split(' ')[0]}
          </>
        )}
      </button>
    </div>
  );
}
