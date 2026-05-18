import { DollarSign, Truck, CircleCheckBig, Wallet } from 'lucide-react';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { formatMXN } from '@/data/mock';

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
          'id, amount, operation_type, source, created_at, notes',
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

    // Desglose del mes por fuente. Las 3 categorías solicitadas:
    //   pago_efectivo → cobros directos (admin recibió cash de cliente)
    //   chofer        → efectivo recibido de un chofer en entrega
    //   egreso (any)  → entregado al contador (lo que SALIÓ de la caja)
    let monthCobrosDirectos = 0;
    let monthCobrosChofer = 0;
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
    };
    const movements: Movement[] = (recentRes.data ?? []).map((m) => ({
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
    }));

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
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
                  <th>Origen</th>
                  <th className="text-right">Monto</th>
                </tr>
              </thead>
              <tbody>
                {movements.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
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
 *   - 'pago_efectivo'       → cobros directos
 *   - 'chofer'              → recibido de un chofer en entrega
 *   - 'validado_contador'   → entregado al contador (egreso)
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
    default:
      return source || '—';
  }
}

/**
 * Formatea una fecha (`YYYY-MM-DD` o ISO timestamp). Detecta el
 * formato fecha-pura para parsearlo en zona local — mismo fix de TZ
 * que /leads y /admin/entregas.
 */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
