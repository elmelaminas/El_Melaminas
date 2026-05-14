'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  CircleCheckBig,
  Loader,
  Wallet,
  ClipboardList,
  Banknote,
} from 'lucide-react';
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

/** Resumen de la caja personal de cada admin (efectivo acumulado y
 *  del mes en curso). Origen: `admin_cash_register`. */
export type AdminCashSummary = {
  admin_id: string;
  admin_name: string;
  role: 'admin' | 'admin2';
  /** Sum total de ingresos históricos. */
  ingresos: number;
  /** Sum total de egresos históricos (validado_contador, etc.). */
  egresos: number;
  /** Saldo actual: ingresos - egresos. Puede ser negativo en casos raros. */
  balance: number;
  /** Solo ingresos del mes calendario actual (para reporte). */
  this_month_ingresos: number;
};

/** Una fila de la tabla de movimientos recientes. */
export type AdminCashMovement = {
  id: string;
  admin_name: string;
  amount: number;
  operation_type: 'ingreso' | 'egreso' | 'validacion';
  source: string;
  created_at: string | null;
  registered_by_name: string;
  notes: string | null;
};

type TabKey = 'por-validar' | 'validados' | 'efectivo-admin';

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
  validatedTotalLabel,
  monthFilterActive,
  adminCashSummaries,
  adminCashMovements,
  totalCashWithContador,
  totalCashWithAdmins,
  totalCashInSystem,
}: {
  tab: TabKey;
  pendingTransfers: TransferRow[];
  validatedTransfers: TransferRow[];
  pendingGrandTotal: number;
  validatedThisMonthTotal: number;
  /** Label dinámico del card del tab validados — varía si hay filtro
   *  mes/anio activo ("...en Mayo 2026") vs default ("...este mes"). */
  validatedTotalLabel: string;
  /** True cuando el page recibió `?mes=N&anio=N` válidos. Lo usamos
   *  para mostrar el sub-texto del card y la lista en consecuencia. */
  monthFilterActive: boolean;
  /** Resúmenes por admin (saldo + movimientos del mes). */
  adminCashSummaries: AdminCashSummary[];
  /** Últimos 50 movimientos para auditoría. */
  adminCashMovements: AdminCashMovement[];
  /** Efectivo que el contador tiene en mano (cash_transfers
   *  status='recibido'). */
  totalCashWithContador: number;
  /** Sum de saldos positivos de admins. */
  totalCashWithAdmins: number;
  /** totalCashWithContador + totalCashWithAdmins. */
  totalCashInSystem: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function selectTab(next: TabKey) {
    // Preservamos cualquier otro searchParam (mes, anio) para que el
    // filtro mes/anio sobreviva el cambio de tab. Sólo modificamos
    // `tab`. Si el tab destino es el default (por-validar), removemos
    // el param para tener una URL más limpia (?mes=...&anio=...).
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    if (next === 'por-validar') {
      params.delete('tab');
    } else {
      params.set('tab', next);
    }
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
          id="tab-por-validar"
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
          id="tab-validados"
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
        <TabButton
          id="tab-efectivo-admin"
          active={tab === 'efectivo-admin'}
          onClick={() => selectTab('efectivo-admin')}
        >
          <Banknote size={16} /> Efectivo Admin
        </TabButton>
      </div>

      {tab === 'por-validar' ? (
        <PendingTab
          transfers={pendingTransfers}
          grandTotal={pendingGrandTotal}
        />
      ) : tab === 'validados' ? (
        <ValidatedTab
          transfers={validatedTransfers}
          monthTotal={validatedThisMonthTotal}
          totalLabel={validatedTotalLabel}
          monthFilterActive={monthFilterActive}
        />
      ) : (
        <EfectivoAdminTab
          summaries={adminCashSummaries}
          movements={adminCashMovements}
          totalCashWithContador={totalCashWithContador}
          totalCashWithAdmins={totalCashWithAdmins}
          totalCashInSystem={totalCashInSystem}
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
  totalLabel,
  monthFilterActive,
}: {
  transfers: TransferRow[];
  monthTotal: number;
  totalLabel: string;
  monthFilterActive: boolean;
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
            {totalLabel}
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
            {monthFilterActive
              ? 'Filtrado por el mes seleccionado'
              : 'Mes calendario actual'}
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
  id,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  /** id DOM opcional — usado por el tour contextual para anclar
   *  popovers a un tab específico. */
  id?: string;
}) {
  return (
    <button
      id={id}
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

/**
 * Tab "Efectivo Admin" — vista de auditoría para admin/admin2:
 *
 *   - 3 cards arriba: efectivo en contador, en admins, total general.
 *   - Tabla por admin: ingresos / egresos / saldo / ingresos del mes.
 *   - Tabla de últimos 50 movimientos (ingresos + egresos + validaciones)
 *     con marca de tiempo y quién lo registró.
 *
 * Solo lectura — la validación se hace en el tab "Por validar" y la
 * recepción del contador desde /contador.
 */
function EfectivoAdminTab({
  summaries,
  movements,
  totalCashWithContador,
  totalCashWithAdmins,
  totalCashInSystem,
}: {
  summaries: AdminCashSummary[];
  movements: AdminCashMovement[];
  totalCashWithContador: number;
  totalCashWithAdmins: number;
  totalCashInSystem: number;
}) {
  return (
    <>
      {/* 3 cards de resumen */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryCard
          label="Efectivo en contador"
          value={totalCashWithContador}
          color="#D97706"
          subtle="cash_transfers status=recibido"
        />
        <SummaryCard
          label="Efectivo en admins"
          value={totalCashWithAdmins}
          color="#4338CA"
          subtle="saldo positivo acumulado"
        />
        <SummaryCard
          label="Total en el sistema"
          value={totalCashInSystem}
          color="#15803D"
          subtle="contador + admins"
        />
      </div>

      {/* Tabla por admin */}
      <div className="tbl-wrap">
        <div
          className="px-6 py-4 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          <h3 className="font-semibold">Saldo por administrador</h3>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            Acumulativo histórico + lo cobrado este mes.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Administrador</th>
                <th>Rol</th>
                <th className="text-right">Ingresos (total)</th>
                <th className="text-right">Egresos (total)</th>
                <th className="text-right">Saldo</th>
                <th className="text-right">Cobros del mes</th>
              </tr>
            </thead>
            <tbody>
              {summaries.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Sin administradores activos o sin movimientos registrados.
                  </td>
                </tr>
              ) : (
                summaries.map((a) => (
                  <tr key={a.admin_id}>
                    <td className="font-medium">{a.admin_name}</td>
                    <td
                      className="text-xs"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {a.role === 'admin2' ? 'Admin 2' : 'Admin'}
                    </td>
                    <td
                      className="text-right text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {formatMXN(a.ingresos)}
                    </td>
                    <td
                      className="text-right text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {formatMXN(a.egresos)}
                    </td>
                    <td
                      className="text-right font-bold"
                      style={{
                        color: a.balance > 0 ? '#15803D' : 'var(--text-tertiary)',
                      }}
                    >
                      {formatMXN(a.balance)}
                    </td>
                    <td
                      className="text-right text-sm"
                      style={{ color: '#3730A3', fontWeight: 600 }}
                    >
                      {formatMXN(a.this_month_ingresos)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Tabla de movimientos recientes */}
      <div className="tbl-wrap">
        <div
          className="px-6 py-4 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          <h3 className="font-semibold">Movimientos recientes (50 últimos)</h3>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            Auditoría: cada ingreso (pago en efectivo) y cada egreso
            (entrega al contador).
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Admin</th>
                <th>Operación</th>
                <th>Origen</th>
                <th className="text-right">Monto</th>
                <th>Registrado por</th>
              </tr>
            </thead>
            <tbody>
              {movements.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Sin movimientos registrados aún.
                  </td>
                </tr>
              ) : (
                movements.map((m) => (
                  <tr key={m.id}>
                    <td
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {formatDate(m.created_at)}
                    </td>
                    <td className="font-medium">{m.admin_name}</td>
                    <td>
                      {m.operation_type === 'ingreso' ? (
                        <span className="badge badge-success">Ingreso</span>
                      ) : m.operation_type === 'egreso' ? (
                        <span className="badge badge-warning">Egreso</span>
                      ) : (
                        <span className="badge badge-info">Validación</span>
                      )}
                    </td>
                    <td
                      className="text-xs"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {m.source}
                    </td>
                    <td
                      className="text-right font-bold"
                      style={{
                        color:
                          m.operation_type === 'ingreso'
                            ? '#15803D'
                            : '#B91C1C',
                      }}
                    >
                      {m.operation_type === 'ingreso' ? '+' : '−'}
                      {formatMXN(m.amount)}
                    </td>
                    <td
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {m.registered_by_name}
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

function SummaryCard({
  label,
  value,
  color,
  subtle,
}: {
  label: string;
  value: number;
  color: string;
  subtle: string;
}) {
  return (
    <div
      className="card p-4 flex items-center gap-3"
      style={{ border: '1px solid var(--border)' }}
    >
      <div
        className="flex items-center justify-center"
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: value > 0 ? color : 'var(--text-tertiary)',
          color: '#fff',
          flexShrink: 0,
        }}
      >
        <Banknote size={22} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="text-xs uppercase tracking-wide"
          style={{ color: 'var(--text-tertiary)', fontWeight: 600 }}
        >
          {label}
        </div>
        <div
          className="text-xl font-bold leading-tight mt-1"
          style={{ color: value > 0 ? color : 'var(--text-tertiary)' }}
        >
          {formatMXN(value)}
        </div>
        <div
          className="text-[11px] mt-0.5"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {subtle}
        </div>
      </div>
    </div>
  );
}
