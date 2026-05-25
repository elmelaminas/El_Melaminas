'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import {
  DollarSign,
  Loader,
  CircleCheckBig,
  Wallet,
  Banknote,
  KeyRound,
  ShieldAlert,
  X,
} from 'lucide-react';
import { formatMXN } from '@/data/mock';
import {
  receiveAdminCashAction,
  receiveIndividualCashAction,
} from './actions';

/**
 * Un admin con su saldo de caja + ingresos del mes. Saldo = sum
 * ingresos − sum egresos en `admin_cash_register`.
 */
export type AdminWithCash = {
  admin_id: string;
  admin_name: string;
  role: 'admin' | 'admin2';
  balance: number;
  this_month: number;
};

/** Una fila del historial personal de validaciones del contador
 *  (`admin_cash_register` egresos donde registered_by = contador). */
export type ValidationHistoryRow = {
  id: string;
  admin_name: string;
  amount: number;
  created_at: string | null;
};

/**
 * Fila del historial de efectivo recibido directamente de un chofer.
 * Origen: `cash_transfers` donde `contador_id = contador autenticado`.
 * Refactor 2026-05: el flujo activo lo gestiona el admin desde
 * /admin/caja, pero los registros previos siguen vivos y se muestran
 * aquí para trazabilidad. `status` viene del enum DB; lo tipamos
 * defensivamente para evitar romper si aparece un valor nuevo.
 */
export type ReceivedCashHistoryRow = {
  id: string;
  driver_name: string;
  amount: number;
  status: 'pendiente' | 'recibido' | string;
  created_at: string | null;
};

/**
 * Fila de "Cobros en efectivo registrados" — un ingreso en
 * `admin_cash_register` con `source='pago_efectivo'`. Resolución de
 * `client_name` (via payment → lead) y `admin_name` (via profiles)
 * la hace el server; el cliente solo renderiza.
 *
 * `payment_id` es la llave que une el ingreso con su validación
 * (un egreso `source='validado_contador'` con el mismo payment_id).
 * `validated=true` cuando ese egreso ya existe — la UI oculta el
 * botón "✓ Recibí" y muestra badge verde "Validado".
 */
export type CashPaymentRow = {
  id: string;
  payment_id: string | null;
  client_name: string;
  admin_name: string;
  amount: number;
  created_at: string | null;
  validated: boolean;
};

/**
 * Vista del contador. Refactor 2026-05: solo valida la caja del admin.
 *
 * Layout:
 *   1. Card grande con total pendiente de validar (suma de saldos
 *      positivos de todos los admins).
 *   2. Sección "Efectivo del administrador" — tabla con admin, ingresos
 *      del mes y saldo actual.
 *   3. Sección "Validar efectivo" — botón por cada admin con saldo > 0.
 *   4. Historial personal del contador autenticado.
 */
export function ContadorClient({
  admins,
  grandTotal,
  history,
  receivedHistory,
  cashPayments,
  contadorHasPin,
}: {
  admins: AdminWithCash[];
  grandTotal: number;
  history: ValidationHistoryRow[];
  receivedHistory: ReceivedCashHistoryRow[];
  /** Cobros en efectivo del mes actual registrados por admins, con
   *  nombre del cliente y del admin ya resueltos en el server. */
  cashPayments: CashPaymentRow[];
  /** El contador autenticado tiene PIN configurado en su perfil.
   *  Cuando es `false`, el banner pide contactar al admin y los
   *  botones "✓ Recibí" quedan disabled. */
  contadorHasPin: boolean;
}) {
  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold">Caja</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Valida el efectivo acumulado en la caja de cada administrador.
        </p>
      </div>

      {/* SECCIÓN 0: Cobros en efectivo registrados por admins este mes.
          Va arriba porque es la novedad principal de esta vista — el
          contador entra y lo primero que ve es cuánto efectivo "real"
          está flotando en el sistema antes de cualquier validación. */}
      <CashPaymentsSection
        cashPayments={cashPayments}
        contadorHasPin={contadorHasPin}
      />

      {/* Card de total pendiente. */}
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
            {admins.filter((a) => a.balance > 0).length}{' '}
            {admins.filter((a) => a.balance > 0).length === 1
              ? 'admin con efectivo'
              : 'admins con efectivo'}
          </div>
        </div>
      </div>

      {/* SECCIÓN 1: Efectivo del administrador (reporte). */}
      <AdminCashReport admins={admins} />

      {/* SECCIÓN 2: Validar efectivo (acción). */}
      <AdminCashValidator admins={admins} />

      {/* SECCIÓN 3: Historial de efectivo recibido directamente de
          choferes (legacy / pre-refactor). Solo se renderiza si hay
          al menos una fila — sin movimientos el contador no necesita
          ver la tabla vacía. */}
      {receivedHistory.length > 0 && (
        <ReceivedCashHistory history={receivedHistory} />
      )}

      {/* SECCIÓN 4: Historial personal del contador (validaciones a admins). */}
      <ValidationHistory history={history} />
    </div>
  );
}

function AdminCashReport({ admins }: { admins: AdminWithCash[] }) {
  const totalThisMonth = admins.reduce((s, a) => s + a.this_month, 0);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">Efectivo del administrador</h2>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          Ingresos en efectivo de cada admin este mes y su saldo actual.
        </p>
      </div>

      <div className="tbl-wrap">
        <div
          className="px-6 py-3 border-b text-xs"
          style={{
            borderColor: 'var(--border)',
            color: 'var(--text-secondary)',
          }}
        >
          Total ingresado este mes:{' '}
          <strong style={{ color: '#3730A3' }}>
            {formatMXN(totalThisMonth)}
          </strong>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl table-to-cards">
            <thead>
              <tr>
                <th>Administrador</th>
                <th className="text-right">Ingresos del mes</th>
                <th className="text-right">Saldo actual</th>
              </tr>
            </thead>
            <tbody>
              {admins.length === 0 ? (
                <tr>
                  <td
                    colSpan={3}
                    className="text-center py-6 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Sin administradores activos.
                  </td>
                </tr>
              ) : (
                admins.map((a) => (
                  <tr key={a.admin_id}>
                    <td data-label="Admin" className="font-medium">
                      {a.admin_name}
                    </td>
                    <td
                      data-label="Ingresos mes"
                      className="text-right font-bold"
                      style={{
                        color:
                          a.this_month > 0 ? '#3730A3' : 'var(--text-tertiary)',
                      }}
                    >
                      {formatMXN(a.this_month)}
                    </td>
                    <td
                      data-label="Saldo"
                      className="text-right font-bold"
                      style={{
                        color: a.balance > 0 ? '#15803D' : 'var(--text-tertiary)',
                      }}
                    >
                      {formatMXN(a.balance)}
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

function AdminCashValidator({ admins }: { admins: AdminWithCash[] }) {
  // Solo admins con balance > 0 son válidos para validar.
  const eligible = admins.filter((a) => a.balance > 0);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">Validar efectivo</h2>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          El monto se recalcula en el servidor al confirmar (anti-race).
        </p>
      </div>
      {eligible.length === 0 ? (
        <div
          className="card p-6 text-center text-sm"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Ningún admin tiene efectivo pendiente de validar.
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
        style={{ padding: '10px 16px', fontSize: '0.875rem' }}
        aria-busy={pending}
      >
        {pending ? (
          <>
            <Loader size={14} className="animate-spin" />
            <span style={{ marginLeft: 6 }}>Registrando…</span>
          </>
        ) : (
          <>
            <DollarSign size={14} /> Recibí efectivo de{' '}
            {a.admin_name.split(' ')[0]} — {formatMXN(a.balance)}
          </>
        )}
      </button>
    </div>
  );
}

/**
 * Tabla "Historial de efectivo recibido" — cash_transfers donde el
 * contador autenticado es `contador_id`. Columnas: CHOFER, MONTO,
 * FECHA, ESTADO. El estado puede ser 'pendiente' o 'recibido'
 * (cualquier valor distinto se muestra literal).
 */
function ReceivedCashHistory({
  history,
}: {
  history: ReceivedCashHistoryRow[];
}) {
  return (
    <div className="tbl-wrap">
      <div
        className="px-6 py-4 border-b"
        style={{ borderColor: 'var(--border)' }}
      >
        <h3 className="font-semibold">Historial de efectivo recibido</h3>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          Últimas 20 transferencias de efectivo de choferes que cerraste.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="tbl table-to-cards">
          <thead>
            <tr>
              <th>Chofer</th>
              <th className="text-right">Monto</th>
              <th>Fecha</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {history.map((r) => (
              <tr key={r.id}>
                <td data-label="Chofer" className="font-medium">
                  {r.driver_name}
                </td>
                <td
                  data-label="Monto"
                  className="text-right font-bold"
                  style={{ color: '#15803D' }}
                >
                  <Banknote
                    size={14}
                    style={{
                      display: 'inline',
                      verticalAlign: 'middle',
                      marginRight: 4,
                      color: '#15803D',
                    }}
                  />
                  {formatMXN(r.amount)}
                </td>
                <td
                  data-label="Fecha"
                  className="text-sm"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {formatDateTime(r.created_at)}
                </td>
                <td data-label="Estado">
                  {r.status === 'recibido' ? (
                    <span className="badge badge-success">Recibido</span>
                  ) : r.status === 'pendiente' ? (
                    <span className="badge badge-warning">Pendiente</span>
                  ) : (
                    <span className="badge badge-neutral">{r.status}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ValidationHistory({
  history,
}: {
  history: ValidationHistoryRow[];
}) {
  return (
    <div className="tbl-wrap">
      <div
        className="px-6 py-4 border-b"
        style={{ borderColor: 'var(--border)' }}
      >
        <h3 className="font-semibold">Mi historial de validaciones</h3>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          Últimas 20 cajas que validaste.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="tbl table-to-cards">
          <thead>
            <tr>
              <th>Administrador</th>
              <th className="text-right">Monto</th>
              <th>Fecha</th>
            </tr>
          </thead>
          <tbody>
            {history.length === 0 ? (
              <tr>
                <td
                  colSpan={3}
                  className="text-center py-6 text-sm"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Aún no has validado efectivo de ningún admin.
                </td>
              </tr>
            ) : (
              history.map((h) => (
                <tr key={h.id}>
                  <td data-label="Admin" className="font-medium">
                    {h.admin_name}
                  </td>
                  <td
                    data-label="Monto"
                    className="text-right font-bold"
                    style={{ color: '#15803D' }}
                  >
                    <span style={{ marginRight: 4 }}>
                      <Banknote
                        size={14}
                        style={{
                          display: 'inline',
                          verticalAlign: 'middle',
                          marginRight: 4,
                          color: '#15803D',
                        }}
                      />
                    </span>
                    {formatMXN(h.amount)}
                  </td>
                  <td
                    data-label="Fecha"
                    className="text-sm"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {formatDateTime(h.created_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Sección "💰 Cobros en efectivo registrados" — card resumen +
 * tabla de detalle del mes en curso. Cada fila corresponde a un
 * ingreso en `admin_cash_register` con `source='pago_efectivo'`,
 * con el cliente y el admin ya resueltos por el server.
 */
function CashPaymentsSection({
  cashPayments,
  contadorHasPin,
}: {
  cashPayments: CashPaymentRow[];
  contadorHasPin: boolean;
}) {
  const total = cashPayments.reduce((s, p) => s + p.amount, 0);
  const count = cashPayments.length;
  // Fila seleccionada para el flujo de confirmación. null = modal
  // cerrado. Cuando hay una fila seleccionada, el componente
  // `<PinConfirmModal>` se monta en overlay.
  const [pendingRow, setPendingRow] = useState<CashPaymentRow | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">
          💰 Cobros en efectivo registrados
        </h2>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          Pagos en efectivo que los administradores registraron este mes.
        </p>
      </div>

      {/* Banner cuando el contador no tiene PIN configurado: bloquea
          la validación con mensaje claro y deja la lista visible. */}
      {!contadorHasPin && count > 0 && (
        <div
          role="alert"
          className="card p-4 flex items-start gap-3"
          style={{
            background: '#FEF3C7',
            border: '1px solid #FCD34D',
          }}
        >
          <ShieldAlert
            size={20}
            style={{ color: '#92400E', flexShrink: 0, marginTop: 2 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              className="text-sm font-semibold"
              style={{ color: '#92400E' }}
            >
              No tienes PIN de confirmación configurado
            </div>
            <div
              className="text-xs mt-1"
              style={{ color: '#92400E' }}
            >
              Contacta al administrador para que te asigne un PIN
              desde /admin/users antes de validar cobros.
            </div>
          </div>
        </div>
      )}

      {/* Card resumen */}
      <div
        className="card p-5 flex items-center gap-4"
        style={{
          background:
            count > 0
              ? 'linear-gradient(135deg, #DCFCE7 0%, #F0FDF4 100%)'
              : 'var(--bg-subtle)',
          border:
            count > 0
              ? '1px solid rgba(22,163,74,0.25)'
              : '1px solid var(--border)',
        }}
      >
        <div
          className="flex items-center justify-center"
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            background: count > 0 ? '#16A34A' : 'var(--text-tertiary)',
            color: '#fff',
            flexShrink: 0,
          }}
        >
          <DollarSign size={24} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="text-xs uppercase tracking-wide"
            style={{
              color: count > 0 ? '#15803D' : 'var(--text-tertiary)',
              fontWeight: 600,
            }}
          >
            Efectivo en sistema
          </div>
          <div
            className="text-2xl font-bold leading-tight mt-1"
            style={{
              color: count > 0 ? '#15803D' : 'var(--text-tertiary)',
            }}
          >
            {formatMXN(total)}
          </div>
          <div
            className="text-xs mt-1"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {count} {count === 1 ? 'cobro' : 'cobros'} este mes
          </div>
        </div>
      </div>

      {/* Tabla de detalle */}
      <div className="tbl-wrap">
        <div className="overflow-x-auto">
          <table className="tbl table-to-cards">
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Admin</th>
                <th className="text-right">Monto</th>
                <th>Fecha</th>
                <th>Estado</th>
                <th className="text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {cashPayments.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="text-center py-6 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    No hay cobros en efectivo este mes.
                  </td>
                </tr>
              ) : (
                cashPayments.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Cliente" className="font-medium">
                      {p.client_name}
                    </td>
                    <td
                      data-label="Admin"
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {p.admin_name}
                    </td>
                    <td
                      data-label="Monto"
                      className="text-right font-bold"
                      style={{ color: '#15803D' }}
                    >
                      <Banknote
                        size={14}
                        style={{
                          display: 'inline',
                          verticalAlign: 'middle',
                          marginRight: 4,
                          color: '#15803D',
                        }}
                      />
                      {formatMXN(p.amount)}
                    </td>
                    <td
                      data-label="Fecha"
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {formatDateTime(p.created_at)}
                    </td>
                    <td data-label="Estado">
                      {p.validated ? (
                        <span className="badge badge-success">
                          ✓ Validado
                        </span>
                      ) : (
                        <span className="badge badge-warning">
                          Pendiente
                        </span>
                      )}
                    </td>
                    <td data-label="Acción" className="text-right">
                      {!p.validated && p.payment_id && (
                        <button
                          type="button"
                          onClick={() => setPendingRow(p)}
                          disabled={!contadorHasPin}
                          className="btn"
                          style={{
                            padding: '4px 10px',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            background: contadorHasPin
                              ? '#16A34A'
                              : 'var(--bg-muted)',
                            color: contadorHasPin
                              ? '#fff'
                              : 'var(--text-tertiary)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            cursor: contadorHasPin
                              ? 'pointer'
                              : 'not-allowed',
                          }}
                          aria-label={`Validar cobro de ${p.client_name}`}
                          title={
                            contadorHasPin
                              ? `Validar cobro de ${p.client_name}`
                              : 'Necesitas un PIN configurado para validar'
                          }
                        >
                          <CircleCheckBig size={12} /> Recibí
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {cashPayments.length > 0 && (
          <div
            className="px-6 py-3 border-t text-xs flex justify-end"
            style={{
              borderColor: 'var(--border)',
              color: 'var(--text-secondary)',
            }}
          >
            Total en efectivo este mes:{' '}
            <strong style={{ color: '#15803D', marginLeft: 4 }}>
              {formatMXN(total)}
            </strong>
          </div>
        )}
      </div>

      {pendingRow && (
        <PinConfirmModal
          row={pendingRow}
          onClose={() => setPendingRow(null)}
        />
      )}
    </div>
  );
}

/**
 * Modal de confirmación en dos pasos:
 *   1) Resumen del cobro (cliente, monto, admin) — el contador
 *      confirma que está físicamente recibiendo ese efectivo.
 *   2) Input de PIN de 4 dígitos. Hasta 3 intentos fallidos seguidos
 *      antes de bloquear el modal por 30 segundos (anti-bruteforce
 *      básico — la última línea de defensa vive en el servidor que
 *      sigue comparando el PIN contra el almacenado en `profiles`).
 *
 * Al éxito → `router.refresh()` y cierre del modal. Al ser
 * exitoso el server marca la fila como `validated=true` en el
 * próximo render → desaparece el botón "✓ Recibí" y aparece el
 * badge verde "✓ Validado".
 */
function PinConfirmModal({
  row,
  onClose,
}: {
  row: CashPaymentRow;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState<'confirm' | 'pin'>('confirm');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  // Lockout: cuando llega a 3 intentos fallidos, fijamos un timestamp
  // para 30s en el futuro. Mientras `lockUntil > Date.now()` el botón
  // de confirmar queda disabled y el contador ve un mensaje con
  // segundos restantes que se autoactualiza cada segundo.
  const [lockUntil, setLockUntil] = useState<number | null>(null);
  const [, forceTick] = useState(0);
  const pinInputRef = useRef<HTMLInputElement>(null);

  // ESC para cerrar — coherente con el resto de modales del módulo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  // Auto-focus al entrar al paso PIN.
  useEffect(() => {
    if (step === 'pin') {
      pinInputRef.current?.focus();
    }
  }, [step]);

  // Tick de 1s mientras hay lockout activo para refrescar el contador.
  useEffect(() => {
    if (lockUntil == null) return;
    const id = setInterval(() => {
      if (lockUntil <= Date.now()) {
        setLockUntil(null);
        setAttempts(0);
      } else {
        forceTick((n) => n + 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [lockUntil]);

  const lockedSecondsLeft =
    lockUntil != null
      ? Math.max(0, Math.ceil((lockUntil - Date.now()) / 1000))
      : 0;
  const isLocked = lockedSecondsLeft > 0;

  const handleSubmit = () => {
    if (!row.payment_id) {
      setError('Este cobro no tiene un pago asociado.');
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      setError('Ingresa los 4 dígitos del PIN.');
      return;
    }
    if (isLocked) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await receiveIndividualCashAction(
          row.payment_id as string,
          pin,
        );
        if (result.status === 'success') {
          // Refresh + cierre. La fila reaparece como `validated`
          // tras el siguiente fetch del Server Component.
          router.refresh();
          onClose();
          return;
        }
        if (result.status !== 'error') return;
        if (result.reason === 'pin_incorrect') {
          const next = attempts + 1;
          setAttempts(next);
          setPin('');
          if (next >= 3) {
            setLockUntil(Date.now() + 30_000);
            setError(
              'Demasiados intentos fallidos. Espera 30 segundos antes de reintentar.',
            );
          } else {
            setError(
              `PIN incorrecto. Intento ${next} de 3.`,
            );
          }
        } else if (result.reason === 'pin_missing') {
          setError(result.message);
          // Sin PIN configurado, no tiene sentido permitir más
          // intentos en este modal — el contador debe contactar
          // al admin. Bloqueamos el botón sin lockout temporal.
          setLockUntil(Number.MAX_SAFE_INTEGER);
        } else if (result.reason === 'already_validated') {
          setError(result.message);
          // Refresh para que la UI muestre el badge "✓ Validado".
          router.refresh();
        } else {
          setError(result.message);
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Error de red';
        setError(message);
      }
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.55)' }}
      onClick={() => {
        if (!pending) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pin-modal-title"
    >
      <div
        className="card w-full max-w-md p-6 animate-fade"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3
            id="pin-modal-title"
            className="font-semibold text-lg flex items-center gap-2"
          >
            {step === 'confirm' ? (
              <>
                <ShieldAlert size={18} style={{ color: '#D97706' }} />
                Confirmar recepción de efectivo
              </>
            ) : (
              <>
                <KeyRound size={18} style={{ color: '#4338CA' }} />
                Ingresa tu PIN de confirmación
              </>
            )}
          </h3>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ padding: '6px' }}
            onClick={onClose}
            disabled={pending}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        {step === 'confirm' ? (
          <>
            <p
              className="text-sm mb-4"
              style={{ color: 'var(--text-secondary)' }}
            >
              ¿Estás recibiendo el efectivo de:
            </p>
            <div
              className="card p-4 mb-4"
              style={{
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border)',
              }}
            >
              <ConfirmRow label="Cliente" value={row.client_name} />
              <ConfirmRow
                label="Monto"
                value={
                  <strong style={{ color: '#15803D' }}>
                    {formatMXN(row.amount)}
                  </strong>
                }
              />
              <ConfirmRow label="Admin" value={row.admin_name} />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-outline flex-1"
                onClick={onClose}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-primary flex-1"
                onClick={() => setStep('pin')}
              >
                Sí, continuar →
              </button>
            </div>
          </>
        ) : (
          <>
            <input
              ref={pinInputRef}
              type="password"
              inputMode="numeric"
              pattern="[0-9]{4}"
              maxLength={4}
              autoComplete="off"
              className="input mb-2"
              style={{
                textAlign: 'center',
                fontSize: '1.5rem',
                letterSpacing: '0.6em',
                paddingLeft: '0.6em',
              }}
              placeholder="••••"
              value={pin}
              onChange={(e) => {
                // Sanitize: solo dígitos, máximo 4.
                const onlyDigits = e.target.value.replace(/\D/g, '').slice(0, 4);
                setPin(onlyDigits);
                if (error && !isLocked) setError(null);
              }}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  pin.length === 4 &&
                  !pending &&
                  !isLocked
                ) {
                  handleSubmit();
                }
              }}
              disabled={pending || isLocked}
            />
            <p
              className="text-xs mb-3"
              style={{ color: 'var(--text-tertiary)' }}
            >
              4 dígitos numéricos. Si no tienes PIN, contacta al admin.
            </p>

            {error && (
              <div
                role="alert"
                className="text-sm mb-3"
                style={{
                  color: 'var(--danger, #dc2626)',
                  background: 'var(--danger-bg, rgba(220,38,38,0.08))',
                  border: '1px solid rgba(220,38,38,0.25)',
                  padding: '8px 12px',
                  borderRadius: 6,
                }}
              >
                {error}
                {isLocked && lockedSecondsLeft < 60 && (
                  <span style={{ marginLeft: 4 }}>
                    ({lockedSecondsLeft}s)
                  </span>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-outline flex-1"
                onClick={onClose}
                disabled={pending}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-primary flex-1"
                onClick={handleSubmit}
                disabled={pending || isLocked || pin.length !== 4}
                aria-busy={pending}
              >
                {pending ? (
                  <>
                    <Loader size={14} className="animate-spin" />
                    <span style={{ marginLeft: 6 }}>Validando…</span>
                  </>
                ) : (
                  'Confirmar recepción'
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Fila clave-valor del bloque de confirmación (paso 1 del modal). */
function ConfirmRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm py-1">
      <span style={{ color: 'var(--text-tertiary)' }}>{label}:</span>
      <span style={{ color: 'var(--text-primary)', textAlign: 'right' }}>
        {value}
      </span>
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
