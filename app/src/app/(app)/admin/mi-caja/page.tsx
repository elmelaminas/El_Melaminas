import {
  DollarSign,
  Truck,
  CircleCheckBig,
  Wallet,
  Banknote,
  Zap,
} from 'lucide-react';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { formatMXN } from '@/data/mock';
import { formatDateTimeCDMX } from '@/lib/format-date';

/**
 * Página /admin/mi-caja — resumen personal de efectivo del admin
 * autenticado.
 *
 * Fuente: tabla `admin_cash_register`, filtrada por `admin_id =
 * auth.uid()`. Tres bloques:
 *   1. Card grande con el saldo actual (todos los ingresos − egresos
 *      del admin, no solo del mes).
 *   2. Desglose del mes en curso por fuente:
 *      - source='pago_efectivo'   → cobros directos
 *      - source='chofer'          → efectivo recibido de choferes
 *      - operation_type='egreso' (cualquier source) → entregado al
 *        contador / salidas del mes.
 *   3. Tabla de movimientos (últimos 50) del admin.
 *
 * Política de errores: try/catch envolvente + ErrorState con mensaje
 * preciso, mismo patrón que /admin/caja y /admin/users.
 *
 * Acceso: el middleware ya restringe /admin/* a admin + admin2. El
 * page mismo no necesita re-validar role — usa el `auth.uid()` para
 * filtrar y un usuario no admin (que llegó por bug en el middleware)
 * vería un resumen vacío de su propio admin_cash_register.
 */
export const dynamic = 'force-dynamic';

export default async function MiCajaPage() {
  try {
    const userClient = await supabaseServer();
    const {
      data: { user },
    } = await userClient.auth.getUser();
    if (!user) {
      return (
        <ErrorState message="Sesión no válida. Vuelve a iniciar sesión." />
      );
    }
    const adminId = user.id;

    const admin = supabaseAdmin();

    // Rango del mes calendario actual (UTC, consistente con
    // dashboard).
    const now = new Date();
    const startOfMonthIso = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();
    const startOfNextMonthIso = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ).toISOString();

    // Tres queries en paralelo:
    //   1. TODOS los movimientos del admin (para el saldo total — no
    //      filtramos por mes porque el saldo es acumulativo desde el
    //      último corte con el contador).
    //   2. Movimientos del mes actual (para el desglose por source).
    //      Es un subset del #1; podríamos derivarlo, pero filtrar de
    //      nuevo en JS es trivial y no agrega una query.
    //   3. Movimientos recientes para la tabla (últimos 50).
    const [allRes, recentRes] = await Promise.all([
      admin
        .from('admin_cash_register')
        .select('amount, operation_type, source, created_at')
        .eq('admin_id', adminId),
      admin
        .from('admin_cash_register')
        .select(
          'id, amount, operation_type, source, created_at, notes, payment_id, cash_transfer_id, registered_by',
        )
        .eq('admin_id', adminId)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

    if (allRes.error) {
      return (
        <ErrorState
          message={`Error leyendo movimientos: ${allRes.error.message}`}
        />
      );
    }
    if (recentRes.error) {
      return (
        <ErrorState
          message={`Error leyendo historial: ${recentRes.error.message}`}
        />
      );
    }

    // Saldo total: ingresos − egresos sobre toda la historia del
    // admin. Lo que aparece como "MI EFECTIVO DISPONIBLE".
    const allRows = allRes.data ?? [];
    const totalIngresos = allRows.reduce(
      (s, r) =>
        r.operation_type === 'ingreso' ? s + Number(r.amount ?? 0) : s,
      0,
    );
    const totalEgresos = allRows.reduce(
      (s, r) =>
        r.operation_type !== 'ingreso' ? s + Number(r.amount ?? 0) : s,
      0,
    );
    const saldo = totalIngresos - totalEgresos;

    // Desglose del mes por fuente:
    //   pago_efectivo          → cobros directos (admin recibió cash de cliente)
    //   chofer                 → efectivo recibido de un chofer en entrega
    //   recibido_contador      → admin recibió de la caja del contador
    //   recibido_directo_admin → admin recibió DIRECTO (bypass del contador)
    //   egreso (any)           → entregado al contador (lo que SALIÓ de la caja)
    let monthCobrosDirectos = 0;
    let monthCobrosChofer = 0;
    let monthRecibidoContador = 0;
    let monthRecibidoDirecto = 0;
    let monthEgresos = 0;
    for (const r of allRows) {
      const createdAt = r.created_at;
      if (!createdAt) continue;
      if (
        createdAt < startOfMonthIso ||
        createdAt >= startOfNextMonthIso
      ) {
        continue;
      }
      const amt = Number(r.amount ?? 0);
      if (r.operation_type === 'ingreso') {
        if (r.source === 'pago_efectivo') monthCobrosDirectos += amt;
        else if (r.source === 'chofer') monthCobrosChofer += amt;
        else if (r.source === 'recibido_contador') monthRecibidoContador += amt;
        else if (r.source === 'recibido_directo_admin')
          monthRecibidoDirecto += amt;
        // ingresos de otra source (edge) los ignoramos en el desglose
        // pero sí contaron en totalIngresos.
      } else {
        monthEgresos += amt;
      }
    }

    type Movement = {
      id: string;
      amount: number;
      operation_type: 'ingreso' | 'egreso' | 'validacion';
      source: string;
      created_at: string | null;
      notes: string | null;
      /** Nombre del cliente del lead asociado al pago (vía
       *  payment_id → payments.lead_id → leads.client_name). null
       *  cuando el movimiento no proviene de un pago o no se pudo
       *  resolver. */
      client_name: string | null;
      /** Nombre del chofer asociado al cash_transfer (vía
       *  cash_transfer_id → cash_transfers.driver_id → profiles.full_name).
       *  null cuando no aplica o no se pudo resolver. */
      driver_name: string | null;
      /** Nombre del contador que validó el egreso. Solo aplica cuando
       *  source='validado_contador'; viene de `registered_by` →
       *  profiles.full_name. */
      contador_name: string | null;
    };

    type RawMovement = {
      id: string;
      amount: number | string | null;
      operation_type: string | null;
      source: string | null;
      created_at: string | null;
      notes: string | null;
      payment_id: string | null;
      cash_transfer_id: string | null;
      registered_by: string | null;
    };
    const recentRows: RawMovement[] = (recentRes.data ?? []) as RawMovement[];

    // ── Resolver client_name (vía payments) y driver_name (vía
    //    cash_transfers) en bulk. Mismo patrón que /admin/entregas:
    //    SELECTs por IDs únicos, lookup en memoria. Dos pares de
    //    queries encadenados (payments→leads y cash_transfers→profiles),
    //    cada par paralelizado entre sí.
    const paymentIds = Array.from(
      new Set(
        recentRows
          .map((r) => r.payment_id)
          .filter((x): x is string => !!x),
      ),
    );
    const transferIds = Array.from(
      new Set(
        recentRows
          .map((r) => r.cash_transfer_id)
          .filter((x): x is string => !!x),
      ),
    );

    // Round-trip 1 (paralelo): payments + cash_transfers.
    const [paymentsRes, transfersRes] = await Promise.all([
      paymentIds.length > 0
        ? admin.from('payments').select('id, lead_id').in('id', paymentIds)
        : Promise.resolve({ data: [], error: null }),
      transferIds.length > 0
        ? admin
            .from('cash_transfers')
            .select('id, driver_id')
            .in('id', transferIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (paymentsRes.error) {
      console.error(
        '[MiCajaPage] payments lookup falló (no fatal):',
        paymentsRes.error,
      );
    }
    if (transfersRes.error) {
      console.error(
        '[MiCajaPage] cash_transfers lookup falló (no fatal):',
        transfersRes.error,
      );
    }
    const leadIdByPayment = new Map<string, string>();
    for (const p of paymentsRes.data ?? []) {
      if (p.id && p.lead_id) leadIdByPayment.set(p.id, p.lead_id);
    }
    const driverIdByTransfer = new Map<string, string>();
    for (const t of transfersRes.data ?? []) {
      if (t.id && t.driver_id) driverIdByTransfer.set(t.id, t.driver_id);
    }
    const leadIds = Array.from(new Set(leadIdByPayment.values()));
    const driverIds = Array.from(new Set(driverIdByTransfer.values()));

    // IDs de contadores (registered_by) sólo para los egresos
    // validado_contador. Otros movimientos tienen `registered_by` =
    // el mismo admin y no necesitamos resolver su nombre aquí.
    const contadorIds = Array.from(
      new Set(
        recentRows
          .filter(
            (r) =>
              r.source === 'validado_contador' &&
              r.operation_type !== 'ingreso',
          )
          .map((r) => r.registered_by)
          .filter((x): x is string => !!x),
      ),
    );

    // Round-trip 2 (paralelo): leads + profiles (drivers) + profiles
    // (contadores). Tres queries; sin contadorIds saltamos la tercera.
    const [leadsRes, driversRes, contadoresRes] = await Promise.all([
      leadIds.length > 0
        ? admin.from('leads').select('id, client_name').in('id', leadIds)
        : Promise.resolve({ data: [], error: null }),
      driverIds.length > 0
        ? admin.from('profiles').select('id, full_name').in('id', driverIds)
        : Promise.resolve({ data: [], error: null }),
      contadorIds.length > 0
        ? admin.from('profiles').select('id, full_name').in('id', contadorIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (leadsRes.error) {
      console.error(
        '[MiCajaPage] leads lookup falló (no fatal):',
        leadsRes.error,
      );
    }
    if (driversRes.error) {
      console.error(
        '[MiCajaPage] drivers lookup falló (no fatal):',
        driversRes.error,
      );
    }
    if (contadoresRes.error) {
      console.error(
        '[MiCajaPage] contadores lookup falló (no fatal):',
        contadoresRes.error,
      );
    }
    const clientNameByLead = new Map<string, string>();
    for (const l of leadsRes.data ?? []) {
      if (l.id) clientNameByLead.set(l.id, l.client_name ?? '');
    }
    const driverNameById = new Map<string, string>();
    for (const d of driversRes.data ?? []) {
      if (d.id) driverNameById.set(d.id, d.full_name ?? '');
    }
    const contadorNameById = new Map<string, string>();
    for (const c of contadoresRes.data ?? []) {
      if (c.id) contadorNameById.set(c.id, c.full_name ?? '');
    }

    const movements: Movement[] = recentRows.map((m) => {
      const leadId = m.payment_id
        ? leadIdByPayment.get(m.payment_id) ?? null
        : null;
      const clientName = leadId
        ? clientNameByLead.get(leadId) ?? null
        : null;
      const driverId = m.cash_transfer_id
        ? driverIdByTransfer.get(m.cash_transfer_id) ?? null
        : null;
      const driverName = driverId
        ? driverNameById.get(driverId) ?? null
        : null;
      const contadorName =
        m.source === 'validado_contador' && m.registered_by
          ? contadorNameById.get(m.registered_by) ?? null
          : null;
      return {
        id: m.id,
        amount: Number(m.amount ?? 0),
        operation_type:
          m.operation_type === 'egreso'
            ? 'egreso'
            : m.operation_type === 'validacion'
              ? 'validacion'
              : 'ingreso',
        source: m.source ?? '',
        created_at: m.created_at ?? null,
        notes: m.notes ?? null,
        client_name: clientName && clientName.length > 0 ? clientName : null,
        driver_name: driverName && driverName.length > 0 ? driverName : null,
        contador_name:
          contadorName && contadorName.length > 0 ? contadorName : null,
      };
    });

    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold">Mi Efectivo</h1>
          <p
            className="text-sm"
            style={{ color: 'var(--text-secondary)' }}
          >
            Resumen de tu caja personal: cobros directos, efectivo de
            choferes y lo entregado al contador.
          </p>
        </div>

        {/* SECCIÓN 1: saldo actual (prominente). */}
        <div
          className="card p-6 flex items-center gap-4"
          style={{
            background:
              saldo > 0
                ? 'linear-gradient(135deg, #DCFCE7 0%, #F0FDF4 100%)'
                : 'var(--bg-subtle)',
            border:
              saldo > 0
                ? '1px solid rgba(22,163,74,0.25)'
                : '1px solid var(--border)',
          }}
        >
          <div
            className="flex items-center justify-center"
            style={{
              width: 64,
              height: 64,
              borderRadius: 16,
              background: saldo > 0 ? '#16A34A' : 'var(--text-tertiary)',
              color: '#fff',
              flexShrink: 0,
            }}
          >
            <Wallet size={32} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              className="text-xs uppercase tracking-wide"
              style={{
                color: saldo > 0 ? '#15803D' : 'var(--text-tertiary)',
                fontWeight: 600,
              }}
            >
              Mi efectivo disponible
            </div>
            <div
              className="text-4xl font-bold leading-tight mt-1"
              style={{
                color: saldo > 0 ? '#15803D' : 'var(--text-tertiary)',
              }}
            >
              {formatMXN(saldo)}
            </div>
            <div
              className="text-xs mt-1"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {saldo > 0
                ? 'Pendiente de entregar al contador'
                : 'Sin saldo en caja'}
            </div>
          </div>
        </div>

        {/* SECCIÓN 2: desglose del mes en 3 cards. */}
        <div>
          <h2 className="text-lg font-semibold mb-3">
            Movimientos del mes
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
            <BreakdownCard
              icon={<DollarSign size={22} />}
              label="Cobros directos"
              value={monthCobrosDirectos}
              color="#15803D"
              sign="+"
            />
            <BreakdownCard
              icon={<Truck size={22} />}
              label="Recibido de choferes"
              value={monthCobrosChofer}
              color="#1E40AF"
              sign="+"
            />
            <BreakdownCard
              icon={<Banknote size={22} />}
              label="Recibido del contador"
              value={monthRecibidoContador}
              color="#4338CA"
              sign="+"
            />
            <BreakdownCard
              icon={<Zap size={22} />}
              label="Recibido directo"
              value={monthRecibidoDirecto}
              color="#6366F1"
              sign="+"
            />
            <BreakdownCard
              icon={<CircleCheckBig size={22} />}
              label="Entregado al contador"
              value={monthEgresos}
              color="#B91C1C"
              sign="−"
            />
          </div>
        </div>

        {/* SECCIÓN 3: historial de movimientos. */}
        <div className="tbl-wrap">
          <div
            className="px-6 py-4 border-b"
            style={{ borderColor: 'var(--border)' }}
          >
            <h3 className="font-semibold">Historial de movimientos</h3>
            <p
              className="text-xs"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Últimos 50 movimientos de tu caja personal.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="tbl table-to-cards">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Tipo</th>
                  <th>Cliente</th>
                  <th>Origen</th>
                  <th className="text-right">Monto</th>
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
                        {formatDateTimeCDMX(m.created_at)}
                      </td>
                      <td data-label="Tipo">
                        {m.operation_type === 'ingreso' ? (
                          <span className="badge badge-success">
                            Entrada
                          </span>
                        ) : (
                          <span className="badge badge-danger">
                            Salida
                          </span>
                        )}
                      </td>
                      <td
                        data-label="Cliente"
                        className="text-sm"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        <ClientCell movement={m} />
                      </td>
                      <td
                        data-label="Origen"
                        className="text-sm"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {sourceLabel(m.source)}
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
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al cargar mi caja';
    console.error('[MiCajaPage] excepción no controlada:', err);
    return <ErrorState message={message} />;
  }
}

function BreakdownCard({
  icon,
  label,
  value,
  color,
  sign,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
  sign: '+' | '−';
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
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="text-xs uppercase tracking-wide"
          style={{
            color: 'var(--text-tertiary)',
            fontWeight: 600,
          }}
        >
          {label}
        </div>
        <div
          className="text-xl font-bold leading-tight mt-1"
          style={{
            color: value > 0 ? color : 'var(--text-tertiary)',
          }}
        >
          {sign}
          {formatMXN(value)}
        </div>
      </div>
    </div>
  );
}

/**
 * Etiqueta legible de la columna `source` para el historial.
 * Valores conocidos:
 *   - 'pago_efectivo'          → cobros directos
 *   - 'chofer'                 → recibido de un chofer en entrega
 *   - 'validado_contador'      → entregado al contador (egreso)
 *   - 'recibido_contador'      → recibido del contador (ingreso)
 *   - 'recibido_directo_admin' → recibido directo bypass contador
 * Otros se muestran tal cual (defensivo).
 */
function sourceLabel(source: string): string {
  switch (source) {
    case 'pago_efectivo':
      return 'Cobro directo';
    case 'chofer':
      return 'Recibido de chofer';
    case 'validado_contador':
      return 'Entregado al contador';
    case 'recibido_contador':
      return 'Recibido del contador';
    case 'recibido_directo_admin':
      return 'Recibido directo (sin contador)';
    default:
      return source || '—';
  }
}

/**
 * Celda "Cliente" para cada movimiento del historial. Compone label +
 * subtexto según la fuente:
 *   - pago_efectivo: nombre del cliente del lead.
 *   - chofer: "Chofer · {nombre}" (o "Recibido de chofer" si no se
 *     resolvió el nombre).
 *   - validado_contador: badge verde "✅ Validado con contador",
 *     subtexto "Por: {contador}" y "Cliente: {cliente}" (cuando el
 *     egreso tiene payment_id resuelto → lead.client_name).
 *   - otras: '—'.
 */
function ClientCell({
  movement: m,
}: {
  movement: {
    source: string;
    client_name: string | null;
    driver_name: string | null;
    contador_name: string | null;
  };
}) {
  if (m.source === 'validado_contador') {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="badge badge-success" style={{ width: 'fit-content' }}>
          ✅ Validado con contador
        </span>
        {m.contador_name && (
          <span
            className="text-[11px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            Por: {m.contador_name}
          </span>
        )}
        {m.client_name && (
          <span
            className="text-[11px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            Cliente: {m.client_name}
          </span>
        )}
      </div>
    );
  }
  if (m.source === 'pago_efectivo') {
    return <span>{m.client_name ?? '—'}</span>;
  }
  if (m.source === 'chofer') {
    return (
      <span>
        {m.driver_name ? `Chofer · ${m.driver_name}` : 'Recibido de chofer'}
      </span>
    );
  }
  return <span>—</span>;
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar mi caja</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </div>
  );
}
