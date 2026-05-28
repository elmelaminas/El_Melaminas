'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  DollarSign,
  Loader,
  CircleCheckBig,
  Wallet,
  Banknote,
  ShieldAlert,
} from 'lucide-react';
import { formatMXN } from '@/data/mock';
import {
  receiveAdminCashAction,
  receiveIndividualCashAction,
  receiveFromContadorAction,
} from './actions';
import { PinConfirmModal } from '@/components/ui/PinConfirmModal';
import { formatDateTimeCDMX } from '@/lib/format-date';

/**
 * Saldo vivo de un contador: cuánto efectivo físico tiene en mano
 * (validaciones a admins − transferencias previas al admin).
 * Lo consume la sección "Efectivo disponible del contador" que solo ve
 * el rol 'admin'.
 */
export type ContadorBalanceRow = {
  id: string;
  name: string;
  balance: number;
};

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
/** Fila visible en la sección "💰 Cobros en efectivo registrados".
 *  `validated=true` significa que ya hay un egreso
 *  `source='validado_contador'` para este `payment_id`. `validator_name`
 *  proviene de `profiles.full_name` del usuario que insertó ese egreso
 *  (admin, admin2 o contador) — se muestra como "Por: X" debajo del
 *  badge "Validado" para auditoría rápida. */
export type CashPaymentRow = {
  id: string;
  payment_id: string | null;
  client_name: string;
  admin_name: string;
  amount: number;
  created_at: string | null;
  validated: boolean;
  /** Nombre del usuario que registró la validación
   *  (`admin_cash_register.registered_by`). null si la fila aún no
   *  está validada o si no se pudo resolver el nombre. */
  validator_name: string | null;
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
  hasPin,
  viewerRole,
  contadorBalances,
  myContadorBalance,
}: {
  admins: AdminWithCash[];
  grandTotal: number;
  history: ValidationHistoryRow[];
  receivedHistory: ReceivedCashHistoryRow[];
  /** Cobros en efectivo del mes actual registrados por admins, con
   *  nombre del cliente y del admin ya resueltos en el server. */
  cashPayments: CashPaymentRow[];
  /** El usuario autenticado (contador, admin o admin2) tiene PIN
   *  válido de 4 dígitos configurado en su perfil. Cuando es `false`,
   *  el banner amarillo pide contactar al admin y los botones
   *  "✓ Recibí" quedan disabled. Comprobado server-side en page.tsx
   *  con `^\d{4}$` — el valor también es el que la action exige. */
  hasPin: boolean;
  /** Rol del usuario que ve esta pantalla. La sección "Efectivo
   *  disponible del contador" solo aparece cuando viewerRole='admin'. */
  viewerRole: '' | 'admin' | 'admin2' | 'contador';
  /** Lista de contadores activos con su saldo en mano. Solo se usa
   *  cuando viewerRole='admin'. */
  contadorBalances: ContadorBalanceRow[];
  /** Saldo vivo del contador autenticado. Solo positivo si
   *  viewerRole='contador'; para admin/admin2 viene en 0. */
  myContadorBalance: number;
}) {
  const isAdminViewer = viewerRole === 'admin';
  const totalAvailable = contadorBalances.reduce((s, c) => s + c.balance, 0);
  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold">Caja</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {isAdminViewer
            ? 'Recibe el efectivo acumulado en la caja del contador y valida el efectivo del resto del equipo.'
            : 'Valida el efectivo acumulado en la caja de cada administrador.'}
        </p>
      </div>

      {/* SECCIÓN ADMIN ONLY: efectivo disponible del contador. Va al
          inicio para que el admin la vea primero al entrar. */}
      {isAdminViewer && (
        <ContadorAvailableSection
          totalAvailable={totalAvailable}
          contadorBalances={contadorBalances}
        />
      )}

      {/* SECCIÓN CONTADOR ONLY: card pequeña con mi saldo vivo. */}
      {viewerRole === 'contador' && (
        <MyContadorBalanceCard balance={myContadorBalance} />
      )}

      {/* SECCIÓN 0: Cobros en efectivo registrados por admins este mes.
          Va arriba porque es la novedad principal de esta vista — el
          contador entra y lo primero que ve es cuánto efectivo "real"
          está flotando en el sistema antes de cualquier validación. */}
      <CashPaymentsSection
        cashPayments={cashPayments}
        hasPin={hasPin}
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
  hasPin,
}: {
  cashPayments: CashPaymentRow[];
  hasPin: boolean;
}) {
  const router = useRouter();
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
      {!hasPin && count > 0 && (
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
              Para validar cobros necesitas un PIN de 4 dígitos
            </div>
            <div
              className="text-xs mt-1"
              style={{ color: '#92400E' }}
            >
              Contacta a Carlos Mena (Administrador) para que te asigne
              tu PIN desde Usuarios → Editar tu perfil.
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
                        <div className="flex flex-col items-start gap-0.5">
                          <span className="badge badge-success">
                            ✅ Validado
                          </span>
                          {p.validator_name && (
                            <span
                              className="text-[10px]"
                              style={{ color: 'var(--text-tertiary)' }}
                              title={`Validado por ${p.validator_name}`}
                            >
                              Por: {p.validator_name}
                            </span>
                          )}
                        </div>
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
                          disabled={!hasPin}
                          className="btn"
                          style={{
                            padding: '4px 10px',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            background: hasPin
                              ? '#16A34A'
                              : 'var(--bg-muted)',
                            color: hasPin
                              ? '#fff'
                              : 'var(--text-tertiary)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            cursor: hasPin
                              ? 'pointer'
                              : 'not-allowed',
                          }}
                          aria-label={`Validar cobro de ${p.client_name}`}
                          title={
                            hasPin
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

      <PinConfirmModal
        isOpen={pendingRow != null}
        onClose={() => setPendingRow(null)}
        title="Confirmar recepción de efectivo"
        details={
          pendingRow
            ? [
                { label: 'Cliente', value: pendingRow.client_name },
                {
                  label: 'Monto',
                  value: (
                    <strong style={{ color: '#15803D' }}>
                      {formatMXN(pendingRow.amount)}
                    </strong>
                  ),
                },
                { label: 'Admin', value: pendingRow.admin_name },
              ]
            : []
        }
        onConfirm={async (pin) => {
          if (!pendingRow?.payment_id) {
            return {
              success: false,
              error: 'Este cobro no tiene un pago asociado.',
            };
          }
          const result = await receiveIndividualCashAction(
            pendingRow.payment_id,
            pin,
          );
          if (result.status === 'success') {
            router.refresh();
            return { success: true };
          }
          if (result.status === 'error') {
            // `already_validated` también refresca para que la UI
            // sincronice el badge — luego mostramos el error.
            if (result.reason === 'already_validated') {
              router.refresh();
            }
            return {
              success: false,
              error: result.message,
              reason: result.reason,
            };
          }
          return { success: false, error: 'Estado inesperado.' };
        }}
      />
    </div>
  );
}

// Helper local renombrado al shared `formatDateTimeCDMX` para que toda
// la app comparta el mismo formato + timezone México.
const formatDateTime = formatDateTimeCDMX;

/**
 * Sección admin-only: card grande con el total disponible en el sistema
 * + tabla de contadores con su saldo y botón "Recibir efectivo".
 * Si el rol del viewer no es 'admin', el padre la oculta antes de
 * renderizarla.
 */
function ContadorAvailableSection({
  totalAvailable,
  contadorBalances,
}: {
  totalAvailable: number;
  contadorBalances: ContadorBalanceRow[];
}) {
  const router = useRouter();
  // El modal de recepción opera con una sola fila a la vez. `pickedRow`
  // null = modal cerrado. Al confirmar exitosamente refrescamos los
  // datos del server.
  const [pickedRow, setPickedRow] = useState<ContadorBalanceRow | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">
          💰 Efectivo disponible del contador
        </h2>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          Saldo físico que cada contador tiene en su caja, listo para
          transferir al admin.
        </p>
      </div>

      <div
        className="card p-5 flex items-center gap-4"
        style={{
          background:
            totalAvailable > 0
              ? 'linear-gradient(135deg, #DCFCE7 0%, #F0FDF4 100%)'
              : 'var(--bg-subtle)',
          border:
            totalAvailable > 0
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
            background: totalAvailable > 0 ? '#16A34A' : 'var(--text-tertiary)',
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
              color: totalAvailable > 0 ? '#15803D' : 'var(--text-tertiary)',
              fontWeight: 600,
            }}
          >
            Efectivo disponible en caja contador
          </div>
          <div
            className="text-2xl font-bold leading-tight mt-1"
            style={{
              color: totalAvailable > 0 ? '#15803D' : 'var(--text-tertiary)',
            }}
          >
            {formatMXN(totalAvailable)}
          </div>
          <div
            className="text-xs mt-1"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {contadorBalances.filter((c) => c.balance > 0).length}{' '}
            {contadorBalances.filter((c) => c.balance > 0).length === 1
              ? 'contador con saldo'
              : 'contadores con saldo'}
          </div>
        </div>
      </div>

      {/* Tabla por contador */}
      <div className="tbl-wrap">
        <div className="overflow-x-auto">
          <table className="tbl table-to-cards">
            <thead>
              <tr>
                <th>Contador</th>
                <th className="text-right">Saldo disponible</th>
                <th className="text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {contadorBalances.length === 0 ? (
                <tr>
                  <td
                    colSpan={3}
                    className="text-center py-6 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Sin contadores activos.
                  </td>
                </tr>
              ) : (
                contadorBalances.map((c) => (
                  <tr key={c.id}>
                    <td data-label="Contador" className="font-medium">
                      {c.name}
                    </td>
                    <td
                      data-label="Saldo"
                      className="text-right font-bold"
                      style={{
                        color:
                          c.balance > 0 ? '#15803D' : 'var(--text-tertiary)',
                      }}
                    >
                      {formatMXN(c.balance)}
                    </td>
                    <td data-label="Acción" className="text-right">
                      {c.balance > 0 ? (
                        <button
                          type="button"
                          onClick={() => setPickedRow(c)}
                          className="btn"
                          style={{
                            padding: '6px 12px',
                            fontSize: '0.8125rem',
                            fontWeight: 600,
                            background: '#16A34A',
                            color: '#fff',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                          aria-label={`Recibir efectivo de ${c.name}`}
                        >
                          <DollarSign size={14} /> Recibir efectivo
                        </button>
                      ) : (
                        <span
                          className="text-xs"
                          style={{ color: 'var(--text-tertiary)' }}
                        >
                          Sin saldo
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {pickedRow && (
        <ReceiveFromContadorModal
          contador={pickedRow}
          onClose={() => setPickedRow(null)}
          onSuccess={() => {
            setPickedRow(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * Modal de dos pasos para recibir efectivo del contador.
 *
 * Paso 1 (custom): muestra el contador + saldo disponible + un input
 * editable para el monto a recibir (default = saldo total). El usuario
 * confirma "Sí, continuar →".
 * Paso 2: delega en `<PinConfirmModal>` con `intro` y `details` que
 * incluyen el monto seleccionado; `onConfirm` invoca
 * `receiveFromContadorAction`.
 *
 * Por qué un wrapper en vez de extender PinConfirmModal: ese componente
 * está optimizado para resumen estático (key/value); inyectar un input
 * editable complicaría su API. Mantenerlo simple aquí y darle al
 * PinConfirmModal sólo el detalle ya elegido.
 */
function ReceiveFromContadorModal({
  contador,
  onClose,
  onSuccess,
}: {
  contador: ContadorBalanceRow;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [amount, setAmount] = useState<number>(contador.balance);
  const [step, setStep] = useState<'amount' | 'pin'>('amount');

  // Sólo aceptamos amounts > 0 y ≤ saldo. Si el usuario edita a 0 o
  // sobrepasa, deshabilitamos "Continuar" en lugar de auto-clampear
  // para que el campo se mantenga predecible mientras escribe.
  const amountValid = amount > 0 && amount <= contador.balance;

  if (step === 'pin') {
    return (
      <PinConfirmModal
        isOpen
        onClose={onClose}
        title={`Recibir efectivo de ${contador.name}`}
        intro="Vas a registrar la recepción de:"
        confirmText="Confirmar recepción"
        details={[
          { label: 'Contador', value: contador.name },
          { label: 'Saldo disponible', value: formatMXN(contador.balance) },
          {
            label: 'Monto a recibir',
            value: <strong>{formatMXN(amount)}</strong>,
          },
        ]}
        onConfirm={async (pin) => {
          const result = await receiveFromContadorAction(
            contador.id,
            amount,
            pin,
          );
          if (result.status === 'success') {
            onSuccess();
            return { success: true };
          }
          if (result.status === 'error') {
            // PinConfirmResult.reason no incluye 'insufficient_balance';
            // lo mapeamos a 'other' para que el modal lo muestre como
            // mensaje sin reintento (el admin debe cerrar y ajustar el
            // monto).
            const r = result.reason;
            const mapped: 'pin_incorrect' | 'pin_missing' | 'other' =
              r === 'pin_incorrect' || r === 'pin_missing' ? r : 'other';
            return {
              success: false,
              error: result.message,
              reason: mapped,
            };
          }
          return { success: false, error: 'Estado inesperado.' };
        }}
      />
    );
  }

  // Paso 1: amount picker. Lo renderizamos como un modal custom liviano
  // (mismo overlay que PinConfirmModal para coherencia visual).
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(15,23,42,0.55)' }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="receive-contador-title"
    >
      <div
        className="card w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          id="receive-contador-title"
          className="font-semibold text-lg flex items-center gap-2 mb-4"
        >
          <ShieldAlert size={18} style={{ color: '#D97706' }} />
          Recibir efectivo del contador
        </h3>
        <p
          className="text-sm mb-3"
          style={{ color: 'var(--text-secondary)' }}
        >
          ¿Estás recibiendo efectivo de:
        </p>
        <div
          className="card p-4 mb-4"
          style={{
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border)',
          }}
        >
          <div className="flex justify-between text-sm py-1">
            <span style={{ color: 'var(--text-tertiary)' }}>Contador:</span>
            <span style={{ color: 'var(--text-primary)' }}>
              {contador.name}
            </span>
          </div>
          <div className="flex justify-between text-sm py-1">
            <span style={{ color: 'var(--text-tertiary)' }}>
              Monto disponible:
            </span>
            <span
              style={{ color: 'var(--text-primary)', fontWeight: 600 }}
            >
              {formatMXN(contador.balance)}
            </span>
          </div>
        </div>

        <label
          className="text-xs font-medium mb-1 block"
          style={{ color: 'var(--text-secondary)' }}
          htmlFor="receive-amount-input"
        >
          Monto a recibir
        </label>
        <input
          id="receive-amount-input"
          type="number"
          className="input mb-1"
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          min={0}
          max={contador.balance}
          step="0.01"
          style={{ fontSize: '1rem', height: 48 }}
        />
        <p
          className="text-xs mb-4"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Default = saldo total. Editable si decides recibir solo una
          parte.
        </p>

        {!amountValid && amount > contador.balance && (
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
            El monto no puede exceder el saldo disponible.
          </div>
        )}

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
            disabled={!amountValid}
            onClick={() => setStep('pin')}
          >
            Sí, continuar →
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Card pequeña para el contador autenticado: cuánto efectivo físico
 * tiene en mano ahora mismo. No interactiva; sólo informativa.
 */
function MyContadorBalanceCard({ balance }: { balance: number }) {
  return (
    <div
      className="card p-5 flex items-center gap-4"
      style={{
        background:
          balance > 0
            ? 'linear-gradient(135deg, #E0E7FF 0%, #EEF2FF 100%)'
            : 'var(--bg-subtle)',
        border:
          balance > 0
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
          background: balance > 0 ? '#4338CA' : 'var(--text-tertiary)',
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
            color: balance > 0 ? '#3730A3' : 'var(--text-tertiary)',
            fontWeight: 600,
          }}
        >
          Mi saldo disponible
        </div>
        <div
          className="text-2xl font-bold leading-tight mt-1"
          style={{
            color: balance > 0 ? '#3730A3' : 'var(--text-tertiary)',
          }}
        >
          {formatMXN(balance)}
        </div>
        <div
          className="text-xs mt-1"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Efectivo físico que has acumulado de validaciones al admin.
        </div>
      </div>
    </div>
  );
}
