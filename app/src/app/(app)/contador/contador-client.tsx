'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

/** Tab keys de la sección "Cobros en efectivo registrados". Espejado
 *  desde page.tsx para que el padre y este componente compartan el
 *  mismo dominio sin acoplar el tipo a su archivo. */
export type CashTabKey = 'pendientes' | 'validados' | 'recibidos';
import { MonthYearSelector } from '@/components/ui/MonthYearSelector';
import {
  DollarSign,
  Loader,
  CircleCheckBig,
  Wallet,
  Banknote,
  ShieldAlert,
  Search,
  X,
} from 'lucide-react';
import { formatMXN } from '@/data/mock';
import {
  bulkReceiveCashContadorAction,
  adminReceiveDirectOrContadorBulkAction,
} from './actions';
import { PinConfirmModal } from '@/components/ui/PinConfirmModal';
import { formatDateTimeCDMX } from '@/lib/format-date';
import { normalizeSearch } from '@/lib/normalize-search';

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
  /** `true` cuando algún admin ya recibió esta fila del contador
   *  (existe un ingreso `source='recibido_contador'` con el mismo
   *  payment_id). El admin viewer usa esto para ocultar el botón
   *  "Recibí del contador" tras la transferencia. */
  received_by_admin: boolean;
  /** Nombre del admin que recibió del contador; null si aún no
   *  recibido. Se muestra como "Por jefe: X" en la columna Estado. */
  receiver_name: string | null;
  /** `true` cuando un admin recibió esta fila DIRECTO sin pasar por
   *  el contador (existe un ingreso `source='recibido_directo_admin'`
   *  con el mismo payment_id). Estado terminal: la fila no aparece
   *  como seleccionable en ningún rol. */
  received_directly: boolean;
  /** Nombre del admin que recibió directo; null si no. Se muestra
   *  como "Directo: X" en la columna Estado. */
  direct_receiver_name: string | null;
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
  mes,
  anio,
  cashTab,
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
  /** Mes seleccionado (1-12) — pasado al `<MonthYearSelector>`. */
  mes: number;
  /** Año seleccionado (4 dígitos). */
  anio: number;
  /** Tab activo de "Cobros en efectivo registrados". Se lee del
   *  searchParam `tab` en page.tsx y se pasa por prop para que el
   *  cliente sepa qué sección mostrar y para que los `TabButton`
   *  pinten su estado activo. */
  cashTab: CashTabKey;
}) {
  // Eduardo (admin2) también opera caja: la sección de recibir
  // efectivo del contador debe estar visible para ambos roles admin*.
  // El gating fino del PIN ya bloquea la acción si el rol no debiera
  // proceder (admin / admin2 con PIN configurado).
  const isAdminViewer = viewerRole === 'admin' || viewerRole === 'admin2';
  const totalAvailable = contadorBalances.reduce((s, c) => s + c.balance, 0);
  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Caja</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {isAdminViewer
              ? 'Recibe el efectivo acumulado en la caja del contador y valida el efectivo del resto del equipo.'
              : 'Valida el efectivo acumulado en la caja de cada administrador.'}
          </p>
        </div>
        <MonthYearSelector mes={mes} anio={anio} />
      </div>

      {/* SECCIÓN ADMIN+ADMIN2: efectivo disponible del contador. Va al
          inicio para que sea lo primero que se ve al entrar. La sección
          se muestra SIEMPRE para administradores, incluso si los
          contadores no tienen saldo aún — la tabla informa el estado
          actual y deja claro que no hay nada por recibir. */}
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
          está flotando en el sistema antes de cualquier validación.
          El viewerRole cambia las acciones por fila: el contador valida
          al admin, el admin recibe del contador. */}
      <CashPaymentsSection
        cashPayments={cashPayments}
        hasPin={hasPin}
        viewerRole={viewerRole}
        cashTab={cashTab}
      />

      {/* Las secciones "Pendiente de validar" + "Efectivo del
          administrador" + "Validar efectivo" (con el botón
          `$ Recibí efectivo de {admin}`) fueron eliminadas. Ese
          flujo bulk ya no aplica:
            - El contador valida cliente por cliente (con PIN) desde
              "Cobros en efectivo registrados" arriba.
            - El admin recibe del contador con checkboxes desde la
              misma tabla.
          La data sigue computándose en page.tsx (admins / grandTotal)
          y se pasa por compat pero no se renderiza acá. */}

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
  viewerRole,
  cashTab,
}: {
  cashPayments: CashPaymentRow[];
  hasPin: boolean;
  /** El rol decide qué acciones por fila aparecen:
   *    contador → "✓ Recibí" (valida al admin)
   *    admin / admin2 → "✓ Recibí del contador" (recibe del contador)
   *  Si el rol no encaja en ninguno (caso defensivo) no se muestran
   *  botones de acción — la tabla queda informativa. */
  viewerRole: '' | 'admin' | 'admin2' | 'contador';
  /** Tab activo (`pendientes`/`validados`/`recibidos`). Solo el de
   *  ese tab se renderiza; los otros permanecen ocultos pero las
   *  selecciones cruzadas siguen vivas en el set y contribuyen al
   *  total de la barra sticky. */
  cashTab: CashTabKey;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, tabStartTransition] = useTransition();

  /** Cambia el tab activo preservando todos los demás searchParams
   *  (mes, anio, etc.). El buscador local (`q`) NO está en la URL
   *  así que su valor se conserva automáticamente al re-renderizar. */
  function selectCashTab(next: CashTabKey) {
    if (next === cashTab) return;
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    if (next === 'pendientes') {
      // Default — limpiamos para mantener URL compacta.
      params.delete('tab');
    } else {
      params.set('tab', next);
    }
    const qs = params.toString();
    tabStartTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }
  const total = cashPayments.reduce((s, p) => s + p.amount, 0);
  const count = cashPayments.length;
  const isAdminViewer = viewerRole === 'admin' || viewerRole === 'admin2';
  const isContadorViewer = viewerRole === 'contador';

  // Bulk selection compartido entre ambos roles (con reglas distintas
  // de qué filas son seleccionables). Set de payment_ids + bandera
  // para abrir el modal único de PIN.
  const [selectedPaymentIds, setSelectedPaymentIds] = useState<Set<string>>(
    new Set(),
  );
  const [bulkModalOpen, setBulkModalOpen] = useState(false);

  // Búsqueda local por nombre del cliente, reactiva: el filtro se
  // recalcula en cada keystroke (es JS en memoria sobre las filas ya
  // cargadas, costo O(n)). Enter / botón / X siguen ahí pero solo
  // como atajos de UX — no hace falta presionarlos para que la tabla
  // reaccione. El input ya no usa dos estados (qInput + q committed)
  // porque no hay round-trip a Supabase que defender.
  // Importante: el filtro NO afecta la selección bulk — si un cliente
  // quedó marcado y el filtro lo oculta, sigue contando para el total
  // y se incluirá al confirmar.
  const [qInput, setQInput] = useState('');
  const q = qInput;
  function commitSearch(_next: string) {
    // No-op: la búsqueda ya es reactiva al escribir. La función se
    // conserva como punto de extensión por si el día de mañana
    // queremos volver a tener un "commit" (p.ej. con debounce a una
    // RPC server-side).
  }
  function clearSearch() {
    setQInput('');
  }
  const filteredCashPayments = q
    ? (() => {
        const needle = normalizeSearch(q);
        return cashPayments.filter((p) =>
          normalizeSearch(p.client_name ?? '').includes(needle),
        );
      })()
    : cashPayments;

  // Reglas de selectabilidad por rol:
  //   - contador: filas en estado "pendiente" (no validadas, no
  //     recibidas por ningún admin) — validar bulk.
  //   - admin/admin2: filas no recibidas por ningún admin, sin
  //     importar si el contador ya validó o no. Mixto permite
  //     direct + via-contador en el mismo bulk.
  // Estado terminal `received_directly` o `received_by_admin` saca a
  // la fila del set selecionable en ambos roles.
  function rowIsSelectable(p: CashPaymentRow): boolean {
    if (typeof p.payment_id !== 'string') return false;
    if (p.received_directly || p.received_by_admin) return false;
    if (isContadorViewer) return !p.validated;
    if (isAdminViewer) return true;
    return false;
  }
  // `selectedRows` recorre el listado COMPLETO (no filtrado) para que
  // las selecciones que el filtro oculta sigan contribuyendo al total.
  const selectedRows = cashPayments.filter(
    (p) =>
      typeof p.payment_id === 'string' &&
      selectedPaymentIds.has(p.payment_id),
  );
  const selectedTotal = selectedRows.reduce((s, p) => s + p.amount, 0);

  // Partición por estado de la tabla — tres secciones con headers
  // dedicados: ⏳ Pendientes / ✅ Validados / 💰 Recibidos. Las tres
  // arrancan del listado YA filtrado por el buscador para que la
  // búsqueda recorte cada sección por separado.
  const pendingRows = filteredCashPayments.filter(
    (r) => !r.validated && !r.received_by_admin && !r.received_directly,
  );
  const validatedRows = filteredCashPayments.filter(
    (r) => r.validated && !r.received_by_admin && !r.received_directly,
  );
  const receivedRows = filteredCashPayments.filter(
    (r) => r.received_by_admin || r.received_directly,
  );

  // Totales monetarios por estado (reflejan el filtro de búsqueda — si
  // q está activo, ya viene aplicado en filteredCashPayments). Sirven
  // para los pills de cada tab y el subtítulo de la sección activa.
  const pendingTotal = pendingRows.reduce((s, r) => s + r.amount, 0);
  const validatedTotal = validatedRows.reduce((s, r) => s + r.amount, 0);
  const receivedTotal = receivedRows.reduce((s, r) => s + r.amount, 0);

  // "Master checkbox" por sección. Cada uno selecciona/des-selecciona
  // SOLO las filas seleccionables visibles de SU sección, sin tocar
  // las de otras. Esto evita que un admin clickee "todos" en
  // Pendientes y por accidente arrastre Validados al set.
  const pendingSelectable = pendingRows.filter(rowIsSelectable);
  const validatedSelectable = validatedRows.filter(rowIsSelectable);
  const allPendingSelected =
    pendingSelectable.length > 0 &&
    pendingSelectable.every(
      (r) =>
        typeof r.payment_id === 'string' &&
        selectedPaymentIds.has(r.payment_id),
    );
  const allValidatedSelected =
    validatedSelectable.length > 0 &&
    validatedSelectable.every(
      (r) =>
        typeof r.payment_id === 'string' &&
        selectedPaymentIds.has(r.payment_id),
    );

  function toggleAllPending() {
    setSelectedPaymentIds((prev) => {
      const next = new Set(prev);
      if (allPendingSelected) {
        for (const r of pendingSelectable) {
          if (typeof r.payment_id === 'string') next.delete(r.payment_id);
        }
      } else {
        for (const r of pendingSelectable) {
          if (typeof r.payment_id === 'string') next.add(r.payment_id);
        }
      }
      return next;
    });
  }
  function toggleAllValidated() {
    setSelectedPaymentIds((prev) => {
      const next = new Set(prev);
      if (allValidatedSelected) {
        for (const r of validatedSelectable) {
          if (typeof r.payment_id === 'string') next.delete(r.payment_id);
        }
      } else {
        for (const r of validatedSelectable) {
          if (typeof r.payment_id === 'string') next.add(r.payment_id);
        }
      }
      return next;
    });
  }
  function toggleRow(paymentId: string) {
    setSelectedPaymentIds((prev) => {
      const next = new Set(prev);
      if (next.has(paymentId)) next.delete(paymentId);
      else next.add(paymentId);
      return next;
    });
  }
  // Partición admin: una fila va por "directo" si NO fue validada por
  // el contador todavía; va por "vía contador" si SÍ. La server
  // action `adminReceiveDirectOrContadorBulkAction` recibe los dos
  // arrays para procesarlos con el source correcto cada uno.
  const adminPendingSelected = selectedRows.filter(
    (r) => typeof r.payment_id === 'string' && !r.validated,
  );
  const adminValidatedSelected = selectedRows.filter(
    (r) => typeof r.payment_id === 'string' && r.validated,
  );
  // Copy de la barra sticky para admin viewer según la mezcla.
  let adminMixHint = '';
  if (isAdminViewer && selectedRows.length > 0) {
    if (adminPendingSelected.length > 0 && adminValidatedSelected.length === 0) {
      adminMixHint = 'Recibirás directo — sin pasar por contador';
    } else if (
      adminValidatedSelected.length > 0 &&
      adminPendingSelected.length === 0
    ) {
      adminMixHint = 'Recibirás del contador';
    } else if (
      adminPendingSelected.length > 0 &&
      adminValidatedSelected.length > 0
    ) {
      adminMixHint = `Mezcla: ${adminPendingSelected.length} directo + ${adminValidatedSelected.length} del contador`;
    }
  }
  // Nombres de contador para mostrar en el modal cuando aplica.
  const selectedValidatorNames = new Set(
    adminValidatedSelected
      .map((r) => r.validator_name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0),
  );
  const contadorLabel =
    selectedValidatorNames.size === 1
      ? Array.from(selectedValidatorNames)[0]
      : selectedValidatorNames.size > 1
        ? '(varios)'
        : '—';

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

      {/* Buscador por nombre del cliente — filtro local sobre la
          tabla, no toca Supabase. Mismo patrón que /leads: la
          navegación solo se commita al Enter / botón / botón X. */}
      <div className="flex gap-2 items-stretch">
        <div className="relative" style={{ flex: 1, minWidth: 0 }}>
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--text-tertiary)' }}
          />
          <input
            type="text"
            placeholder="Buscar por nombre del cliente…"
            className="input"
            style={{
              paddingLeft: 36,
              paddingRight: qInput ? 36 : undefined,
              borderTopRightRadius: 0,
              borderBottomRightRadius: 0,
            }}
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitSearch(qInput);
              }
            }}
            aria-label="Buscar cobros por cliente"
          />
          {qInput && (
            <button
              type="button"
              className="absolute top-1/2 -translate-y-1/2"
              style={{
                right: 8,
                background: 'transparent',
                border: 'none',
                padding: 4,
                cursor: 'pointer',
                color: 'var(--text-tertiary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onClick={clearSearch}
              aria-label="Limpiar búsqueda"
              title="Limpiar búsqueda"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => commitSearch(qInput)}
          style={{
            flexShrink: 0,
            padding: '0 14px',
            gap: 6,
            background: 'var(--brand-primary, #1B3A5C)',
            color: '#fff',
            borderTopLeftRadius: 0,
            borderBottomLeftRadius: 0,
            fontWeight: 600,
          }}
          aria-label="Buscar"
        >
          <Search size={16} />
          <span className="hidden sm:inline">Buscar</span>
        </button>
      </div>

      {/* Tabs horizontales para Pendientes / Validados / Recibidos.
          El contador de cada tab refleja las filas YA FILTRADAS por
          el buscador (mejor pista de "dónde está mi match" cuando el
          tab activo se queda vacío). El tab activo es bookmarkeable
          vía `?tab=...`. */}
      <div
        className="flex gap-2 flex-wrap"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <CashTabButton
          id="cash-tab-pendientes"
          active={cashTab === 'pendientes'}
          onClick={() => selectCashTab('pendientes')}
        >
          ⏳ Pendientes
          <CashTabCount
            count={pendingRows.length}
            amount={pendingTotal}
            active={cashTab === 'pendientes'}
          />
        </CashTabButton>
        <CashTabButton
          id="cash-tab-validados"
          active={cashTab === 'validados'}
          onClick={() => selectCashTab('validados')}
        >
          ✅ Validados
          <CashTabCount
            count={validatedRows.length}
            amount={validatedTotal}
            active={cashTab === 'validados'}
          />
        </CashTabButton>
        <CashTabButton
          id="cash-tab-recibidos"
          active={cashTab === 'recibidos'}
          onClick={() => selectCashTab('recibidos')}
        >
          💰 Recibidos
          <CashTabCount
            count={receivedRows.length}
            amount={receivedTotal}
            active={cashTab === 'recibidos'}
          />
        </CashTabButton>
      </div>

      {cashPayments.length === 0 ? (
        <div
          className="tbl-wrap"
          style={{ padding: '24px', textAlign: 'center' }}
        >
          <span
            className="text-sm"
            style={{ color: 'var(--text-tertiary)' }}
          >
            No hay cobros en efectivo este mes.
          </span>
        </div>
      ) : filteredCashPayments.length === 0 ? (
        <div
          className="tbl-wrap"
          style={{ padding: '24px', textAlign: 'center' }}
        >
          <span
            className="text-sm"
            style={{ color: 'var(--text-tertiary)' }}
          >
            No se encontraron cobros para &ldquo;{q}&rdquo;.
          </span>
        </div>
      ) : (
        <>
          {cashTab === 'pendientes' && (
            pendingRows.length > 0 ? (
              <SectionTable
                title="⏳ Pendientes de validar"
                count={pendingRows.length}
                totalAmount={pendingTotal}
                totalLabel="Total pendiente"
                totalColor="#B45309"
                bg="#FFFBEB"
                border="#FCD34D"
                showCheckboxCol={isAdminViewer || isContadorViewer}
                master={
                  isAdminViewer || isContadorViewer
                    ? {
                        checked: allPendingSelected,
                        disabled: pendingSelectable.length === 0 || !hasPin,
                        onToggle: toggleAllPending,
                      }
                    : null
                }
                rows={pendingRows}
                rowIsSelectable={rowIsSelectable}
                hasPin={hasPin}
                selectedPaymentIds={selectedPaymentIds}
                toggleRow={toggleRow}
              />
            ) : (
              <EmptyTabState message="Sin cobros pendientes." />
            )
          )}
          {cashTab === 'validados' && (
            validatedRows.length > 0 ? (
              <SectionTable
                title="✅ Validados por contador"
                count={validatedRows.length}
                totalAmount={validatedTotal}
                totalLabel="Total validado"
                totalColor="#15803D"
                bg="#ECFDF5"
                border="#A7F3D0"
                showCheckboxCol={isAdminViewer}
                master={
                  isAdminViewer
                    ? {
                        checked: allValidatedSelected,
                        disabled:
                          validatedSelectable.length === 0 || !hasPin,
                        onToggle: toggleAllValidated,
                      }
                    : null
                }
                rows={validatedRows}
                rowIsSelectable={rowIsSelectable}
                hasPin={hasPin}
                selectedPaymentIds={selectedPaymentIds}
                toggleRow={toggleRow}
              />
            ) : (
              <EmptyTabState message="Sin cobros validados por contador." />
            )
          )}
          {cashTab === 'recibidos' && (
            receivedRows.length > 0 ? (
              <SectionTable
                title="💰 Recibidos"
                count={receivedRows.length}
                totalAmount={receivedTotal}
                totalLabel="Total recibido"
                totalColor="#1E40AF"
                bg="#EFF6FF"
                border="#BFDBFE"
                showCheckboxCol={false}
                master={null}
                rows={receivedRows}
                rowIsSelectable={rowIsSelectable}
                hasPin={hasPin}
                selectedPaymentIds={selectedPaymentIds}
                toggleRow={toggleRow}
              />
            ) : (
              <EmptyTabState message="Sin cobros recibidos." />
            )
          )}
        </>
      )}
      {/* Footer del pie: reemplaza el viejo "Total en efectivo este
          mes" (redundante con la card verde de arriba) por el total
          del tab activo, así el usuario siempre tiene una referencia
          numérica sin tener que mirar el header de la sección. */}
      {cashPayments.length > 0 && (
        <div
          className="px-4 py-2 text-xs flex justify-end"
          style={{ color: 'var(--text-secondary)' }}
        >
          {cashTab === 'pendientes' && (
            <>
              Total pendiente{q ? ' (filtrado)' : ''}:{' '}
              <strong style={{ color: '#B45309', marginLeft: 4 }}>
                {formatMXN(pendingTotal)}
              </strong>
            </>
          )}
          {cashTab === 'validados' && (
            <>
              Total validado{q ? ' (filtrado)' : ''}:{' '}
              <strong style={{ color: '#15803D', marginLeft: 4 }}>
                {formatMXN(validatedTotal)}
              </strong>
            </>
          )}
          {cashTab === 'recibidos' && (
            <>
              Total recibido{q ? ' (filtrado)' : ''}:{' '}
              <strong style={{ color: '#1E40AF', marginLeft: 4 }}>
                {formatMXN(receivedTotal)}
              </strong>
            </>
          )}
        </div>
      )}

      {/* Barra sticky compartida: aparece para contador o admin
          cuando hay selección. El copy de la línea inferior cambia
          según el rol y la mezcla. */}
      {(isAdminViewer || isContadorViewer) && selectedPaymentIds.size > 0 && (
        <div
          role="region"
          aria-label="Confirmación bulk de cobros"
          className="fixed left-0 right-0 z-40"
          style={{ bottom: 0 }}
        >
          <div
            className="card mx-auto"
            style={{
              maxWidth: 920,
              margin: '0 auto 16px auto',
              padding: '12px 16px',
              borderRadius: 12,
              boxShadow: '0 -4px 16px rgba(15,23,42,0.15)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              background: 'var(--bg-base, #fff)',
              border: '1px solid var(--border)',
            }}
          >
            <div className="flex flex-col">
              <div
                className="text-sm"
                style={{ color: 'var(--text-primary)' }}
              >
                <span style={{ fontWeight: 600 }}>
                  ☑ {selectedPaymentIds.size}{' '}
                  {selectedPaymentIds.size === 1
                    ? 'seleccionado'
                    : 'seleccionados'}
                </span>
                <span
                  style={{ marginLeft: 12, color: 'var(--text-secondary)' }}
                >
                  Total:{' '}
                  <strong style={{ color: '#15803D' }}>
                    {formatMXN(selectedTotal)}
                  </strong>
                </span>
              </div>
              {isAdminViewer && adminMixHint && (
                <div
                  className="text-xs mt-1"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  {adminMixHint}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setSelectedPaymentIds(new Set())}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setBulkModalOpen(true)}
                disabled={!hasPin || selectedPaymentIds.size === 0}
                title={
                  hasPin
                    ? 'Confirmar con PIN'
                    : 'Necesitas un PIN configurado'
                }
              >
                <CircleCheckBig size={16} />{' '}
                {isContadorViewer ? 'Confirmar validación' : 'Confirmar recepción'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal admin: mezcla directo + via contador. Llama a la
          server action `adminReceiveDirectOrContadorBulkAction` con
          las dos slices. */}
      {isAdminViewer && (
        <PinConfirmModal
          isOpen={bulkModalOpen}
          onClose={() => setBulkModalOpen(false)}
          title="Confirmar recepción"
          intro={
            adminMixHint
              ? `${adminMixHint}. ¿Confirmas?`
              : '¿Confirmas la recepción?'
          }
          confirmText="Confirmar recepción"
          details={[
            ...selectedRows.map((r) => ({
              label: r.client_name,
              value: formatMXN(r.amount),
            })),
            {
              label: 'TOTAL A RECIBIR',
              value: (
                <strong style={{ color: '#15803D' }}>
                  {formatMXN(selectedTotal)}
                </strong>
              ),
            },
            ...(adminValidatedSelected.length > 0
              ? [{ label: 'Del contador', value: contadorLabel }]
              : []),
            ...(adminPendingSelected.length > 0
              ? [
                  {
                    label: 'Directo (sin contador)',
                    value: `${adminPendingSelected.length} ${
                      adminPendingSelected.length === 1 ? 'cobro' : 'cobros'
                    }`,
                  },
                ]
              : []),
          ]}
          onConfirm={async (pin) => {
            if (selectedPaymentIds.size === 0) {
              return {
                success: false,
                error: 'Selecciona al menos un cobro.',
              };
            }
            const pendingIds = adminPendingSelected
              .map((r) => r.payment_id)
              .filter((x): x is string => typeof x === 'string');
            const validatedIds = adminValidatedSelected
              .map((r) => r.payment_id)
              .filter((x): x is string => typeof x === 'string');
            const result = await adminReceiveDirectOrContadorBulkAction(
              pendingIds,
              validatedIds,
              pin,
            );
            if (result.status === 'success') {
              setSelectedPaymentIds(new Set());
              router.refresh();
              return { success: true };
            }
            if (result.status === 'error') {
              if (
                result.reason === 'already_received' ||
                result.reason === 'not_validated' ||
                result.reason === 'concurrent_validation'
              ) {
                router.refresh();
              }
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
      )}

      {/* Modal contador: bulk validation. Llama a
          `bulkReceiveCashContadorAction` con los payment_ids
          seleccionados. */}
      {isContadorViewer && (
        <PinConfirmModal
          isOpen={bulkModalOpen}
          onClose={() => setBulkModalOpen(false)}
          title="Confirmar validación"
          intro="¿Confirmas la validación de estos cobros?"
          confirmText="Confirmar validación"
          details={[
            ...selectedRows.map((r) => ({
              label: r.client_name,
              value: formatMXN(r.amount),
            })),
            {
              label: 'TOTAL A VALIDAR',
              value: (
                <strong style={{ color: '#15803D' }}>
                  {formatMXN(selectedTotal)}
                </strong>
              ),
            },
          ]}
          onConfirm={async (pin) => {
            const ids = Array.from(selectedPaymentIds);
            if (ids.length === 0) {
              return {
                success: false,
                error: 'Selecciona al menos un cobro.',
              };
            }
            const result = await bulkReceiveCashContadorAction(ids, pin);
            if (result.status === 'success') {
              setSelectedPaymentIds(new Set());
              router.refresh();
              return { success: true };
            }
            if (result.status === 'error') {
              if (result.reason === 'already_validated') {
                router.refresh();
              }
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
      )}
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
  // Sección puramente informativa: muestra cuánto efectivo tiene cada
  // contador en su caja en tiempo real. La recepción real se hace
  // cliente por cliente desde "Cobros en efectivo registrados" más
  // abajo (con PIN), y `revalidatePath('/contador')` decrementa este
  // saldo automáticamente vía el INSERT en `contador_to_admin_transfers`.
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">
          💰 Recibir efectivo del contador
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

      {/* Tabla por contador — informativa. Sin columna de acción: la
          recepción se hace cliente por cliente con PIN en la sección
          de cobros, y este saldo se refresca automáticamente. */}
      <div className="tbl-wrap">
        <div className="overflow-x-auto">
          <table className="tbl table-to-cards">
            <thead>
              <tr>
                <th>Contador</th>
                <th className="text-right">Saldo disponible</th>
              </tr>
            </thead>
            <tbody>
              {contadorBalances.length === 0 ? (
                <tr>
                  <td
                    colSpan={2}
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

/**
 * Tabla autocontenida para una de las tres secciones de
 * "Cobros en efectivo registrados" (Pendientes / Validados /
 * Recibidos). Encapsula:
 *   - Header con título + contador de filas.
 *   - Background tint propio de la sección (amarillo, verde o azul).
 *   - Columna de checkbox + master cuando aplica.
 *   - Render unificado de la columna Estado para los 4 estados
 *     terminales (pendiente / validado / recibido-jefe / recibido-directo).
 *
 * El estado de selección vive en el padre — el componente solo lee
 * `selectedPaymentIds` y dispara `toggleRow` / `master.onToggle`.
 */
function SectionTable({
  title,
  count,
  totalAmount,
  totalLabel,
  totalColor,
  bg,
  border,
  showCheckboxCol,
  master,
  rows,
  rowIsSelectable,
  hasPin,
  selectedPaymentIds,
  toggleRow,
}: {
  title: string;
  count: number;
  /** Suma de `amount` sobre las filas visibles de esta sección. Se
   *  muestra debajo del título como sub-línea destacada en color
   *  específico del estado (`totalColor`). */
  totalAmount: number;
  totalLabel: string;
  totalColor: string;
  bg: string;
  border: string;
  showCheckboxCol: boolean;
  /** null → no se renderiza el master checkbox (sección read-only). */
  master: {
    checked: boolean;
    disabled: boolean;
    onToggle: () => void;
  } | null;
  rows: CashPaymentRow[];
  rowIsSelectable: (p: CashPaymentRow) => boolean;
  hasPin: boolean;
  selectedPaymentIds: Set<string>;
  toggleRow: (paymentId: string) => void;
}) {
  return (
    <div
      className="tbl-wrap"
      style={{
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 8,
      }}
    >
      <div
        className="px-4 py-3"
        style={{ borderBottom: `1px solid ${border}` }}
      >
        <div
          className="text-sm font-semibold"
          style={{ color: 'var(--text-primary)' }}
        >
          {title}{' '}
          <span
            className="text-xs font-normal"
            style={{ color: 'var(--text-tertiary)' }}
          >
            ({count})
          </span>
        </div>
        <div
          className="text-xs font-semibold mt-0.5"
          style={{ color: totalColor }}
        >
          {totalLabel}: {formatMXN(totalAmount)}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="tbl table-to-cards">
          <thead>
            <tr>
              {showCheckboxCol && (
                <th style={{ width: 36 }}>
                  {master && (
                    <input
                      type="checkbox"
                      aria-label={`Seleccionar todos en ${title}`}
                      title={`Seleccionar todos en ${title}`}
                      checked={master.checked}
                      disabled={master.disabled}
                      onChange={master.onToggle}
                    />
                  )}
                </th>
              )}
              <th>Cliente</th>
              <th>Admin</th>
              <th className="text-right">Monto</th>
              <th>Fecha</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const selectable = rowIsSelectable(p);
              const checked =
                selectable &&
                typeof p.payment_id === 'string' &&
                selectedPaymentIds.has(p.payment_id);
              return (
                <tr key={p.id}>
                  {showCheckboxCol && (
                    <td data-label="Sel.">
                      {selectable && p.payment_id ? (
                        <input
                          type="checkbox"
                          aria-label={`Seleccionar cobro de ${p.client_name}`}
                          disabled={!hasPin}
                          checked={!!checked}
                          onChange={() =>
                            toggleRow(p.payment_id as string)
                          }
                        />
                      ) : (
                        <span aria-hidden="true">&nbsp;</span>
                      )}
                    </td>
                  )}
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
                    <CashPaymentStatusBadge row={p} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Badge de estado de una fila de cobro. Cuatro estados terminales en
 * orden de "más avanzado a menos": directo > recibido-por-jefe >
 * validado > pendiente. Cada paso conocido añade una línea pequeña
 * "Por: X" debajo del badge para auditoría rápida.
 */
function CashPaymentStatusBadge({ row }: { row: CashPaymentRow }) {
  if (row.received_directly) {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span
          className="badge"
          style={{ background: '#DBEAFE', color: '#1E40AF' }}
        >
          ✅ Recibido
        </span>
        {row.direct_receiver_name && (
          <span
            className="text-[10px]"
            style={{ color: 'var(--text-tertiary)' }}
            title={`Recibido directo por ${row.direct_receiver_name}`}
          >
            Directo: {row.direct_receiver_name}
          </span>
        )}
      </div>
    );
  }
  if (row.received_by_admin) {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span
          className="badge"
          style={{ background: '#DBEAFE', color: '#1E40AF' }}
        >
          ✅ Recibido
        </span>
        {row.receiver_name && (
          <span
            className="text-[10px]"
            style={{ color: 'var(--text-tertiary)' }}
            title={`Recibido por ${row.receiver_name}`}
          >
            Por jefe: {row.receiver_name}
          </span>
        )}
        {row.validator_name && (
          <span
            className="text-[10px]"
            style={{ color: 'var(--text-tertiary)' }}
            title={`Validado por ${row.validator_name}`}
          >
            Validado: {row.validator_name}
          </span>
        )}
      </div>
    );
  }
  if (row.validated) {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span className="badge badge-success">✅ Validado por contador</span>
        {row.validator_name && (
          <span
            className="text-[10px]"
            style={{ color: 'var(--text-tertiary)' }}
            title={`Validado por ${row.validator_name}`}
          >
            Por: {row.validator_name}
          </span>
        )}
      </div>
    );
  }
  return <span className="badge badge-warning">Pendiente</span>;
}

/**
 * Botón de tab para "Cobros en efectivo registrados". Mismo estilo
 * que el `TabButton` de /admin/caja: border-bottom 2px en color
 * primario para activo, texto secundario para inactivo. Local a este
 * archivo para no exponer otro símbolo público.
 */
function CashTabButton({
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

/**
 * Badge contador para los tabs — pill gris con la cantidad de filas
 * visibles en ese tab tras el filtro de búsqueda. El monto se muestra
 * SIEMPRE en el tab activo (para verlo aunque la sección esté
 * colapsada) y en pantallas anchas (`sm:`) en todos los tabs para
 * vista de un vistazo. En móvil los tabs inactivos quedan compactos
 * con solo el conteo, evitando wrap.
 */
function CashTabCount({
  count,
  amount,
  active,
}: {
  count: number;
  amount: number;
  active: boolean;
}) {
  return (
    <span
      className="text-xs"
      style={{
        padding: '2px 8px',
        borderRadius: 9999,
        background: 'var(--bg-subtle)',
        color: 'var(--text-tertiary)',
        whiteSpace: 'nowrap',
      }}
    >
      {count}
      {/* Monto: visible siempre en el tab activo; en inactivos solo
          en sm+ para no abultar mobile. */}
      <span className={active ? '' : 'hidden sm:inline'}>
        {' '}· {formatMXN(amount)}
      </span>
    </span>
  );
}

/** Mensaje informativo cuando el tab activo no tiene filas (sí hay
 *  cobros este mes pero ninguno cae en este estado). Mantiene la
 *  altura mínima para no colapsar visualmente al switchear. */
function EmptyTabState({ message }: { message: string }) {
  return (
    <div
      className="tbl-wrap"
      style={{ padding: '24px', textAlign: 'center' }}
    >
      <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
        {message}
      </span>
    </div>
  );
}

