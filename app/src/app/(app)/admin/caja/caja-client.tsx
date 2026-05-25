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
import { adminReceivesDriverCashAction } from './actions';
import { PinConfirmModal } from '@/components/ui/PinConfirmModal';

export type TransferRow = {
  id: string;
  driver_name: string;
  /** Nombre de quien recibió (admin que tomó el efectivo del chofer).
   *  En el tab "pendientes" siempre es '—'. */
  received_by_name: string;
  amount: number;
  /** Cuándo el chofer reportó el efectivo (INSERT del transfer). */
  created_at: string | null;
  /** Reservado por compat futura. Actualmente null. */
  received_at: string | null;
  notes: string | null;
};

/** Un movimiento de la caja personal del admin actual (tab "Mi caja"). */
export type CashMovement = {
  id: string;
  amount: number;
  operation_type: 'ingreso' | 'egreso' | 'validacion';
  source: string;
  created_at: string | null;
  registered_by_name: string;
  notes: string | null;
};

type TabKey = 'efectivo-choferes' | 'validados' | 'mi-caja';

/**
 * UI de /admin/caja con tres pestañas controladas por searchParam.
 *
 * Tab "Efectivo de choferes" (status='pendiente'):
 *   - Tabla: Chofer | Monto | Fecha | botón "Recibí efectivo".
 *   - Header: tarjeta amarilla con total pendiente.
 *
 * Tab "Validados" (status='recibido'):
 *   - Tabla: Chofer | Recibido por | Monto | Fecha.
 *   - Historial de los efectivos que el admin ya recibió del chofer.
 *
 * Tab "Mi caja":
 *   - 3 cards: ingresos / egresos / saldo (mes).
 *   - Tabla con movimientos de admin_cash_register del admin actual.
 */
export function CajaClient({
  tab,
  pendingTransfers,
  receivedTransfers,
  pendingGrandTotal,
  myMovements,
  myIngresosTotal,
  myEgresosTotal,
  myBalance,
  myIngresosThisMonth,
  myEgresosThisMonth,
}: {
  tab: TabKey;
  pendingTransfers: TransferRow[];
  receivedTransfers: TransferRow[];
  pendingGrandTotal: number;
  myMovements: CashMovement[];
  myIngresosTotal: number;
  myEgresosTotal: number;
  myBalance: number;
  myIngresosThisMonth: number;
  myEgresosThisMonth: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function selectTab(next: TabKey) {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    if (next === 'efectivo-choferes') {
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
        <h1 className="text-2xl font-bold">Caja</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Recibe el efectivo que los choferes traen y consulta tu caja
          personal.
        </p>
      </div>

      {/* Tabs */}
      <div
        className="flex gap-2 flex-wrap"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <TabButton
          id="tab-choferes"
          active={tab === 'efectivo-choferes'}
          onClick={() => selectTab('efectivo-choferes')}
        >
          <ClipboardList size={16} /> Efectivo de choferes
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
            {receivedTransfers.length}
          </span>
        </TabButton>
        <TabButton
          id="tab-mi-caja"
          active={tab === 'mi-caja'}
          onClick={() => selectTab('mi-caja')}
        >
          <Banknote size={16} /> Mi caja
        </TabButton>
      </div>

      {tab === 'efectivo-choferes' ? (
        <PendingTab
          transfers={pendingTransfers}
          grandTotal={pendingGrandTotal}
        />
      ) : tab === 'validados' ? (
        <ReceivedTab transfers={receivedTransfers} />
      ) : (
        <MyCajaTab
          movements={myMovements}
          ingresosTotal={myIngresosTotal}
          egresosTotal={myEgresosTotal}
          balance={myBalance}
          ingresosThisMonth={myIngresosThisMonth}
          egresosThisMonth={myEgresosThisMonth}
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
            Pendiente de recibir del chofer
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
              ? 'chofer trae efectivo'
              : 'choferes traen efectivo'}
          </div>
        </div>
      </div>

      <div className="tbl-wrap">
        <div className="overflow-x-auto">
          <table className="tbl table-to-cards">
            <thead>
              <tr>
                <th>Chofer</th>
                <th>Monto</th>
                <th>Fecha</th>
                <th>Estado</th>
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
                    Ningún chofer tiene efectivo pendiente.
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

function ReceivedTab({ transfers }: { transfers: TransferRow[] }) {
  const grandTotal = transfers.reduce((s, t) => s + t.amount, 0);
  return (
    <>
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
          <CircleCheckBig size={28} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="text-xs uppercase tracking-wide"
            style={{
              color: grandTotal > 0 ? '#15803D' : 'var(--text-tertiary)',
              fontWeight: 600,
            }}
          >
            Total recibido de choferes
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
            {transfers.length}{' '}
            {transfers.length === 1 ? 'transferencia' : 'transferencias'}{' '}
            registradas
          </div>
        </div>
      </div>

      <div className="tbl-wrap">
        <div className="overflow-x-auto">
          <table className="tbl table-to-cards">
            <thead>
              <tr>
                <th>Chofer</th>
                <th>Recibido por</th>
                <th>Monto</th>
                <th>Fecha</th>
                <th>Estado</th>
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
                    Aún no se ha recibido efectivo de choferes.
                  </td>
                </tr>
              ) : (
                transfers.map((t) => (
                  <tr key={t.id}>
                    <td data-label="Chofer" className="font-medium">
                      {t.driver_name}
                    </td>
                    <td
                      data-label="Recibido por"
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {t.received_by_name}
                    </td>
                    <td
                      data-label="Monto"
                      className="font-bold"
                      style={{ color: '#15803D' }}
                    >
                      {formatMXN(t.amount)}
                    </td>
                    <td
                      data-label="Fecha"
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {formatDate(t.created_at)}
                    </td>
                    <td data-label="Estado">
                      <span className="badge badge-success">Recibido</span>
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

function MyCajaTab({
  movements,
  ingresosTotal,
  egresosTotal,
  balance,
  ingresosThisMonth,
  egresosThisMonth,
}: {
  movements: CashMovement[];
  ingresosTotal: number;
  egresosTotal: number;
  balance: number;
  ingresosThisMonth: number;
  egresosThisMonth: number;
}) {
  return (
    <>
      {/* 3 cards: ingresos, egresos, saldo. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <BalanceCard
          label="Ingresos del mes"
          value={ingresosThisMonth}
          subtle={`Total histórico: ${formatMXN(ingresosTotal)}`}
          color="#15803D"
          icon="ingreso"
        />
        <BalanceCard
          label="Egresos del mes"
          value={egresosThisMonth}
          subtle={`Total histórico: ${formatMXN(egresosTotal)}`}
          color="#B91C1C"
          icon="egreso"
        />
        <BalanceCard
          label="Saldo actual"
          value={balance}
          subtle="ingresos − egresos"
          color={balance > 0 ? '#4338CA' : '#475569'}
          icon="saldo"
          highlight
        />
      </div>

      <div className="tbl-wrap">
        <div
          className="px-6 py-4 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          <h3 className="font-semibold">Mis movimientos</h3>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            Últimos 100 movimientos de tu caja personal.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl table-to-cards">
            <thead>
              <tr>
                <th>Fecha</th>
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
                    colSpan={5}
                    className="text-center py-8 text-sm"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    Sin movimientos en tu caja todavía.
                  </td>
                </tr>
              ) : (
                movements.map((m) => (
                  <tr key={m.id}>
                    <td
                      data-label="Fecha"
                      className="text-sm"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {formatDate(m.created_at)}
                    </td>
                    <td data-label="Operación">
                      {m.operation_type === 'ingreso' ? (
                        <span className="badge badge-success">Ingreso</span>
                      ) : (
                        <span className="badge badge-warning">Egreso</span>
                      )}
                    </td>
                    <td
                      data-label="Origen"
                      className="text-xs"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {m.source}
                    </td>
                    <td
                      data-label="Monto"
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
                      data-label="Registrado por"
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

function BalanceCard({
  label,
  value,
  subtle,
  color,
  icon,
  highlight,
}: {
  label: string;
  value: number;
  subtle: string;
  color: string;
  icon: 'ingreso' | 'egreso' | 'saldo';
  highlight?: boolean;
}) {
  return (
    <div
      className="card p-4 flex items-center gap-3"
      style={{
        border: '1px solid var(--border)',
        background: highlight
          ? 'linear-gradient(135deg, #EEF2FF 0%, #F5F3FF 100%)'
          : undefined,
      }}
    >
      <div
        className="flex items-center justify-center"
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: color,
          color: '#fff',
          flexShrink: 0,
        }}
      >
        {icon === 'ingreso' ? (
          <Banknote size={22} />
        ) : icon === 'egreso' ? (
          <CircleCheckBig size={22} />
        ) : (
          <Wallet size={22} />
        )}
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
          style={{ color }}
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

function PendingRow({ transfer }: { transfer: TransferRow }) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [done, setDone] = useState(false);
  // Pending visual cuando el modal está activo. La server action
  // ahora se invoca desde el modal (no startTransition aquí). No
  // hay loader inline.
  void useTransition;
  return (
    <tr
      style={{
        opacity: done ? 0.4 : 1,
        transition: 'opacity 200ms ease',
      }}
    >
      <td data-label="Chofer" className="font-medium">
        {transfer.driver_name}
      </td>
      <td data-label="Monto" className="font-bold" style={{ color: '#15803D' }}>
        {formatMXN(transfer.amount)}
      </td>
      <td
        data-label="Fecha"
        className="text-sm"
        style={{ color: 'var(--text-secondary)' }}
      >
        {formatDate(transfer.created_at)}
      </td>
      <td data-label="Estado">
        <span className="badge badge-warning">Pendiente</span>
      </td>
      <td data-label="Acción">
        <div className="flex justify-end items-center gap-2 flex-wrap">
          <button
            type="button"
            className="btn btn-primary"
            style={{ padding: '6px 14px', fontSize: '0.875rem' }}
            onClick={() => setModalOpen(true)}
            disabled={done}
            aria-label={`Recibir efectivo de ${transfer.driver_name}`}
          >
            <CircleCheckBig size={14} /> Recibí efectivo
          </button>
        </div>
        <PinConfirmModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          title="Confirmar recepción de efectivo"
          details={[
            { label: 'Chofer', value: transfer.driver_name },
            {
              label: 'Monto',
              value: (
                <strong style={{ color: '#15803D' }}>
                  {formatMXN(transfer.amount)}
                </strong>
              ),
            },
          ]}
          onConfirm={async (pin) => {
            const r = await adminReceivesDriverCashAction(transfer.id, pin);
            if (r.status === 'success') {
              setDone(true);
              router.refresh();
              return { success: true };
            }
            if (r.status === 'error') {
              if (r.reason === 'already_received') {
                router.refresh();
              }
              return {
                success: false,
                error: r.message,
                reason: r.reason,
              };
            }
            return { success: false, error: 'Estado inesperado.' };
          }}
        />
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
