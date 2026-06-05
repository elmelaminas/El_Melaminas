import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  ContadorClient,
  type AdminWithCash,
  type ValidationHistoryRow,
  type ReceivedCashHistoryRow,
  type CashPaymentRow,
  type ContadorBalanceRow,
} from './contador-client';

/**
 * Página /contador.
 *
 * Refactor (2026-05): el contador YA NO recibe efectivo de los choferes
 * — eso lo hace el admin directamente desde /admin/caja. El contador
 * solo valida (recibe) el efectivo acumulado en la caja del admin.
 *
 * Secciones:
 *   1. "Efectivo del administrador" — por cada admin activo, ingresos
 *      acumulados y saldo actual (= ingresos − egresos).
 *   2. "Validar efectivo" — botón "Recibí efectivo de {admin}" por
 *      cada admin con saldo > 0.
 *   3. "Mi historial de validaciones" — últimos 20 egresos donde el
 *      contador autenticado es `registered_by` y source es
 *      'validado_contador'.
 *
 * Política de errores: try/catch + ErrorState con mensaje preciso.
 */
export const dynamic = 'force-dynamic';

type RawSearchParams = {
  mes?: string | string[];
  anio?: string | string[];
  tab?: string | string[];
};

const CASH_TAB_VALUES = ['pendientes', 'validados', 'recibidos'] as const;
type CashTabKey = (typeof CASH_TAB_VALUES)[number];

function pickStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

export default async function ContadorPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  try {
    const raw = await searchParams;
    // Mes/año del filtro. Defaults: mes actual UTC. Si llegan valores
    // fuera de rango (URL stale o manipulada) caemos a los defaults
    // silenciosamente.
    const now = new Date();
    const mesRaw = Number.parseInt(pickStr(raw.mes), 10);
    const anioRaw = Number.parseInt(pickStr(raw.anio), 10);
    const mes =
      Number.isFinite(mesRaw) && mesRaw >= 1 && mesRaw <= 12
        ? mesRaw
        : now.getUTCMonth() + 1;
    const anio =
      Number.isFinite(anioRaw) && anioRaw >= 2000 && anioRaw <= 2100
        ? anioRaw
        : now.getUTCFullYear();
    // Ventana UTC [start, end) — `created_at` y `validated_at` viven
    // en timestamptz y comparan correctamente contra ISO strings.
    const startIso = new Date(Date.UTC(anio, mes - 1, 1)).toISOString();
    const endIso = new Date(Date.UTC(anio, mes, 1)).toISOString();

    // Tab activo de la sección "Cobros en efectivo registrados". Default
    // 'pendientes' — lo primero que el usuario quiere actuar al entrar.
    // Valor manipulado en URL cae a 'pendientes' silenciosamente.
    const tabRaw = pickStr(raw.tab);
    const cashTab: CashTabKey = (CASH_TAB_VALUES as readonly string[]).includes(
      tabRaw,
    )
      ? (tabRaw as CashTabKey)
      : 'pendientes';

    const admin = supabaseAdmin();

    const userClient = await supabaseServer();
    const {
      data: { user },
    } = await userClient.auth.getUser();
    const contadorId = user?.id ?? null;

    // ¿El usuario autenticado (contador / admin / admin2) tiene PIN
    // configurado? Lo usamos para gatear los botones "✓ Recibí" en la
    // UI: sin PIN configurado no puede validar y el banner amarillo lo
    // explica con CTA al admin. Best-effort: si la columna no existe o
    // la query falla, asumimos `false` y bloqueamos.
    //
    // Requerimos EXACTAMENTE 4 dígitos (no solo "no vacío") porque la
    // server action exige `^\d{4}$` y un PIN no-numérico igual fallaría
    // al validar. Evita habilitar el botón con un valor inválido.
    let hasPin = false;
    if (contadorId) {
      try {
        const { data: profile, error: profileErr } = await supabaseAdmin()
          .from('profiles')
          .select('confirmation_pin')
          .eq('id', contadorId)
          .maybeSingle();
        if (profileErr) {
          console.error(
            '[ContadorPage] pin lookup falló (no fatal):',
            profileErr,
          );
        } else {
          const pin =
            typeof profile?.confirmation_pin === 'string'
              ? profile.confirmation_pin.trim()
              : '';
          hasPin = /^\d{4}$/.test(pin);
        }
      } catch (e) {
        console.error(
          '[ContadorPage] pin lookup excepción (no fatal):',
          e,
        );
      }
    }

    // Cinco queries en paralelo. Todas filtran por la ventana [startIso,
    // endIso) del mes seleccionado — el filtro es exclusivamente para
    // lo que se MUESTRA; las server actions no aplican filtro temporal
    // y siguen pudiendo validar/recibir cobros viejos.
    //   1. Admins activos (admin + admin2)
    //   2. admin_cash_register del mes (para sumar por admin)
    //   3. Historial personal de validaciones del contador en el mes
    //   4. Historial de cash_transfers recibidos por este contador
    //      en el mes
    //   5. Cobros en efectivo del mes registrados por admins
    const [adminsRes, cashRes, historyRes, receivedRes, cashPaymentsRes] = await Promise.all([
      admin
        .from('profiles')
        .select('id, full_name, role')
        .in('role', ['admin', 'admin2'])
        .eq('is_active', true)
        .order('full_name', { ascending: true }),
      admin
        .from('admin_cash_register')
        .select('admin_id, amount, operation_type, created_at')
        .gte('created_at', startIso)
        .lt('created_at', endIso),
      contadorId
        ? admin
            .from('admin_cash_register')
            .select(
              'id, admin_id, amount, operation_type, source, created_at',
            )
            .eq('registered_by', contadorId)
            .eq('source', 'validado_contador')
            .gte('created_at', startIso)
            .lt('created_at', endIso)
            .order('created_at', { ascending: false })
            .limit(20)
        : Promise.resolve({ data: [], error: null }),
      contadorId
        ? admin
            .from('cash_transfers')
            .select(
              'id, driver_id, amount, status, created_at, receiver_id, receiver_role',
            )
            .or(
              `and(receiver_role.eq.contador,receiver_id.eq.${contadorId}),contador_id.eq.${contadorId}`,
            )
            .gte('created_at', startIso)
            .lt('created_at', endIso)
            .order('created_at', { ascending: false })
            .limit(20)
        : Promise.resolve({ data: [], error: null }),
      admin
        .from('admin_cash_register')
        .select('id, admin_id, amount, created_at, payment_id')
        .eq('operation_type', 'ingreso')
        .eq('source', 'pago_efectivo')
        .gte('created_at', startIso)
        .lt('created_at', endIso)
        .order('created_at', { ascending: false }),
    ]);

    if (adminsRes.error) {
      return (
        <ErrorState
          message={`Error leyendo admins: ${adminsRes.error.message}`}
        />
      );
    }
    if (cashRes.error) {
      console.error(
        '[ContadorPage] cash select falló (no fatal):',
        cashRes.error,
      );
    }
    if (historyRes.error) {
      console.error(
        '[ContadorPage] history select falló (no fatal):',
        historyRes.error,
      );
    }
    if (receivedRes.error) {
      console.error(
        '[ContadorPage] received cash select falló (no fatal):',
        receivedRes.error,
      );
    }
    if (cashPaymentsRes.error) {
      console.error(
        '[ContadorPage] cash payments select falló (no fatal):',
        cashPaymentsRes.error,
      );
    }

    // Agregar por admin_id: ingresos totales, egresos totales,
    // saldo (ingresos − egresos) e ingresos del mes en curso.

    type Slot = { balance: number; thisMonth: number };
    const byAdmin = new Map<string, Slot>();
    for (const r of cashRes.data ?? []) {
      if (!r.admin_id) continue;
      const amt = Number(r.amount ?? 0);
      const isIngreso = r.operation_type === 'ingreso';
      const slot = byAdmin.get(r.admin_id) ?? {
        balance: 0,
        thisMonth: 0,
      };
      slot.balance += isIngreso ? amt : -amt;
      // `cashRes` ya está filtrado al mes seleccionado; el check de
      // ventana es redundante pero lo dejamos explícito para que el
      // significado quede inequívoco ("ingresos del mes filtrado").
      if (isIngreso && r.created_at && r.created_at >= startIso) {
        slot.thisMonth += amt;
      }
      byAdmin.set(r.admin_id, slot);
    }

    const admins: AdminWithCash[] = (adminsRes.data ?? []).map((a) => {
      const slot = byAdmin.get(a.id) ?? { balance: 0, thisMonth: 0 };
      return {
        admin_id: a.id,
        admin_name: a.full_name ?? '(sin nombre)',
        role: a.role as 'admin' | 'admin2',
        balance: slot.balance,
        this_month: slot.thisMonth,
      };
    });

    const grandTotal = admins.reduce(
      (s, a) => s + Math.max(0, a.balance),
      0,
    );

    // Historial de validaciones (egresos): resolver nombres de admins.
    // Historial de efectivo recibido (cash_transfers): resolver nombres
    // de choferes. Ambos lookups reusan profiles activos ya cargados
    // donde sea posible y consultan extra para los inactivos / con
    // rol distinto (un driver no está en `admins`).
    const historyRaw = historyRes.data ?? [];
    const receivedRaw = receivedRes.data ?? [];
    const cashPaymentsRaw = cashPaymentsRes.data ?? [];

    const histAdminIds = historyRaw
      .map((h) => h.admin_id)
      .filter((x): x is string => !!x);
    const receivedDriverIds = receivedRaw
      .map((r) => r.driver_id)
      .filter((x): x is string => !!x);
    const cashPaymentAdminIds = cashPaymentsRaw
      .map((r) => r.admin_id)
      .filter((x): x is string => !!x);

    const nameById = new Map<string, string>();
    for (const a of admins) nameById.set(a.admin_id, a.admin_name);

    const missing = Array.from(
      new Set([
        ...histAdminIds,
        ...receivedDriverIds,
        ...cashPaymentAdminIds,
      ]),
    ).filter((id) => !nameById.has(id));
    if (missing.length > 0) {
      const { data: extra } = await admin
        .from('profiles')
        .select('id, full_name')
        .in('id', missing);
      for (const u of extra ?? []) {
        nameById.set(u.id, u.full_name ?? '(sin nombre)');
      }
    }

    // Cobros en efectivo del mes: para cada fila de admin_cash_register
    // con source='pago_efectivo', resolver el cliente vía payments →
    // leads. Dos lookups bulk en serie:
    //   a) payment_ids únicos → SELECT payments(id, lead_id) → mapa
    //   b) lead_ids únicos    → SELECT leads(id, client_name) → mapa
    // Si alguna fila no tiene payment_id (cierre histórico raro)
    // queda con client_name vacío y la UI muestra '(sin cliente)'.
    const paymentIds = Array.from(
      new Set(
        cashPaymentsRaw
          .map((r) => r.payment_id)
          .filter((x): x is string => !!x),
      ),
    );
    const leadIdByPayment = new Map<string, string>();
    if (paymentIds.length > 0) {
      const { data: payRows, error: payErr } = await admin
        .from('payments')
        .select('id, lead_id')
        .in('id', paymentIds);
      if (payErr) {
        console.error(
          '[ContadorPage] payments lookup falló (no fatal):',
          payErr,
        );
      }
      for (const p of payRows ?? []) {
        if (p.id && p.lead_id) leadIdByPayment.set(p.id, p.lead_id);
      }
    }
    const leadIds = Array.from(new Set(leadIdByPayment.values()));
    const clientNameByLead = new Map<string, string>();
    if (leadIds.length > 0) {
      const { data: leadRows, error: leadErr } = await admin
        .from('leads')
        .select('id, client_name')
        .in('id', leadIds);
      if (leadErr) {
        console.error(
          '[ContadorPage] leads lookup falló (no fatal):',
          leadErr,
        );
      }
      for (const l of leadRows ?? []) {
        if (l.id) {
          clientNameByLead.set(l.id, l.client_name ?? '(sin nombre)');
        }
      }
    }

    // Idempotencia / estado: marcamos como "validado" cada ingreso que
    // ya tenga un egreso `source='validado_contador'` con el mismo
    // payment_id. Un lookup bulk sobre los payment_ids del listado.
    //
    // Adicional 2026-05: capturamos también `registered_by` para
    // resolver el nombre del validador (admin/contador) y mostrarlo
    // como "Por: X" debajo del badge "Validado" en la UI.
    const validatedPaymentIds = new Set<string>();
    const validatorByPayment = new Map<string, string>();
    if (paymentIds.length > 0) {
      try {
        const { data: validatedRows, error: valErr } = await admin
          .from('admin_cash_register')
          .select('payment_id, registered_by')
          .eq('operation_type', 'egreso')
          .eq('source', 'validado_contador')
          .in('payment_id', paymentIds);
        if (valErr) {
          console.error(
            '[ContadorPage] validated lookup falló (no fatal):',
            valErr,
          );
        }
        for (const v of validatedRows ?? []) {
          if (!v.payment_id) continue;
          validatedPaymentIds.add(v.payment_id);
          if (typeof v.registered_by === 'string' && v.registered_by) {
            validatorByPayment.set(v.payment_id, v.registered_by);
          }
        }
      } catch (e) {
        console.error(
          '[ContadorPage] validated lookup excepción (no fatal):',
          e,
        );
      }
    }

    // Bulk lookup: ingresos `source='recibido_contador'` por payment_id
    // (chain: contador → admin) Y `source='recibido_directo_admin'`
    // (bypass del contador). Ambos son estados terminales: la fila ya
    // está físicamente en la caja de algún admin.
    const receivedByAdminPaymentIds = new Set<string>();
    const adminReceiverByPayment = new Map<string, string>();
    const receivedDirectlyPaymentIds = new Set<string>();
    const directReceiverByPayment = new Map<string, string>();
    if (paymentIds.length > 0) {
      try {
        const { data: receivedRows, error: receivedErr } = await admin
          .from('admin_cash_register')
          .select('payment_id, registered_by, source')
          .eq('operation_type', 'ingreso')
          .in('source', ['recibido_contador', 'recibido_directo_admin'])
          .in('payment_id', paymentIds);
        if (receivedErr) {
          console.error(
            '[ContadorPage] received lookup falló (no fatal):',
            receivedErr,
          );
        }
        for (const r of receivedRows ?? []) {
          if (!r.payment_id) continue;
          const src = (r as { source?: string }).source;
          if (src === 'recibido_contador') {
            receivedByAdminPaymentIds.add(r.payment_id);
            if (typeof r.registered_by === 'string' && r.registered_by) {
              adminReceiverByPayment.set(r.payment_id, r.registered_by);
            }
          } else if (src === 'recibido_directo_admin') {
            receivedDirectlyPaymentIds.add(r.payment_id);
            if (typeof r.registered_by === 'string' && r.registered_by) {
              directReceiverByPayment.set(r.payment_id, r.registered_by);
            }
          }
        }
      } catch (e) {
        console.error(
          '[ContadorPage] received lookup excepción (no fatal):',
          e,
        );
      }
    }

    // Resolver nombres de validators (contador que validó) Y de
    // receivers admin (quien recibió del contador). Una sola query
    // bulk para ambos sets, deduplicados contra el `nameById` ya
    // poblado por la lista de admins inicial.
    const allLookupIds = Array.from(
      new Set([
        ...validatorByPayment.values(),
        ...adminReceiverByPayment.values(),
        ...directReceiverByPayment.values(),
      ]),
    );
    const missingNameIds = allLookupIds.filter((id) => !nameById.has(id));
    if (missingNameIds.length > 0) {
      try {
        const { data: extra, error: extraErr } = await admin
          .from('profiles')
          .select('id, full_name')
          .in('id', missingNameIds);
        if (extraErr) {
          console.error(
            '[ContadorPage] validator/receiver names lookup falló (no fatal):',
            extraErr,
          );
        } else {
          for (const u of extra ?? []) {
            nameById.set(u.id, u.full_name ?? '(sin nombre)');
          }
        }
      } catch (e) {
        console.error(
          '[ContadorPage] validator/receiver names excepción (no fatal):',
          e,
        );
      }
    }

    const cashPayments: CashPaymentRow[] = cashPaymentsRaw.map((r) => {
      const leadId = r.payment_id ? leadIdByPayment.get(r.payment_id) : null;
      const clientName =
        (leadId ? clientNameByLead.get(leadId) : null) ?? '(sin cliente)';
      const adminName = r.admin_id
        ? nameById.get(r.admin_id) ?? '—'
        : '—';
      const validatorId = r.payment_id
        ? validatorByPayment.get(r.payment_id) ?? null
        : null;
      const adminReceiverId = r.payment_id
        ? adminReceiverByPayment.get(r.payment_id) ?? null
        : null;
      const directReceiverId = r.payment_id
        ? directReceiverByPayment.get(r.payment_id) ?? null
        : null;
      return {
        id: r.id,
        payment_id: r.payment_id ?? null,
        client_name: clientName,
        admin_name: adminName,
        amount: Number(r.amount ?? 0),
        created_at: r.created_at ?? null,
        validated: r.payment_id
          ? validatedPaymentIds.has(r.payment_id)
          : false,
        validator_name: validatorId ? nameById.get(validatorId) ?? null : null,
        received_by_admin: r.payment_id
          ? receivedByAdminPaymentIds.has(r.payment_id)
          : false,
        receiver_name: adminReceiverId
          ? nameById.get(adminReceiverId) ?? null
          : null,
        received_directly: r.payment_id
          ? receivedDirectlyPaymentIds.has(r.payment_id)
          : false,
        direct_receiver_name: directReceiverId
          ? nameById.get(directReceiverId) ?? null
          : null,
      };
    });

    const history: ValidationHistoryRow[] = historyRaw.map((h) => ({
      id: h.id,
      admin_name: h.admin_id
        ? nameById.get(h.admin_id) ?? '—'
        : '—',
      amount: Number(h.amount ?? 0),
      created_at: h.created_at ?? null,
    }));

    const receivedHistory: ReceivedCashHistoryRow[] = receivedRaw.map((r) => ({
      id: r.id,
      driver_name: r.driver_id
        ? nameById.get(r.driver_id) ?? '—'
        : '—',
      amount: Number(r.amount ?? 0),
      status: (r.status as ReceivedCashHistoryRow['status']) ?? 'pendiente',
      created_at: r.created_at ?? null,
    }));

    // ── Saldo del/los contadores. Criterio (idéntico al tab "Validados"
    //    de la sección "Cobros en efectivo registrados"): cobros
    //    pago_efectivo del mes que TIENEN egreso validado_contador y
    //    AÚN NO TIENEN un ingreso recibido_contador ni recibido_directo_
    //    admin. Sumamos `amount` por validador (`registered_by` del
    //    egreso) usando `cashPayments` que ya trae los flags computados.
    //
    //    Antes este número se calculaba como SUM(egresos validado del
    //    mes) − SUM(contador_to_admin_transfers del mes) lo que
    //    desincronizaba la card del tab por dos razones: (a) las
    //    transferencias bulk por monto restaban del saldo sin marcar
    //    cobros individuales como recibidos; (b) la suma incluía
    //    validaciones de cobros viejos cuando éstas se hacían en el mes
    //    seleccionado. La tabla `contador_to_admin_transfers` se sigue
    //    escribiendo al recibir (auditoría/historial) pero ya NO
    //    participa en el cálculo del saldo mostrado.
    const [contadorsRes, viewerProfileRes] = await Promise.all([
      admin
        .from('profiles')
        .select('id, full_name')
        .eq('role', 'contador')
        .eq('is_active', true)
        .order('full_name', { ascending: true }),
      contadorId
        ? admin
            .from('profiles')
            .select('role')
            .eq('id', contadorId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (contadorsRes.error) {
      console.error(
        '[ContadorPage] contadors lookup falló (no fatal):',
        contadorsRes.error,
      );
    }
    const contadorBalanceMap = new Map<string, number>();
    for (const cp of cashPayments) {
      if (!cp.validated) continue;
      if (cp.received_by_admin || cp.received_directly) continue;
      if (!cp.payment_id) continue;
      const validatorId = validatorByPayment.get(cp.payment_id);
      if (!validatorId) continue;
      contadorBalanceMap.set(
        validatorId,
        (contadorBalanceMap.get(validatorId) ?? 0) + cp.amount,
      );
    }
    const contadorBalances: ContadorBalanceRow[] = (
      contadorsRes.data ?? []
    ).map((c) => ({
      id: c.id,
      name: c.full_name ?? '(sin nombre)',
      balance: contadorBalanceMap.get(c.id) ?? 0,
    }));
    const viewerRole = ((viewerProfileRes.data?.role as string) ?? '') as
      | ''
      | 'admin'
      | 'admin2'
      | 'contador';
    const myContadorBalance =
      viewerRole === 'contador' && contadorId
        ? contadorBalanceMap.get(contadorId) ?? 0
        : 0;

    return (
      <ContadorClient
        admins={admins}
        grandTotal={grandTotal}
        history={history}
        receivedHistory={receivedHistory}
        cashPayments={cashPayments}
        hasPin={hasPin}
        viewerRole={viewerRole}
        contadorBalances={contadorBalances}
        myContadorBalance={myContadorBalance}
        mes={mes}
        anio={anio}
        cashTab={cashTab}
      />
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al cargar caja';
    console.error('[ContadorPage] excepción no controlada:', err);
    return <ErrorState message={message} />;
  }
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="card p-6 max-w-xl">
      <h1 className="text-xl font-bold mb-2">No se pudo cargar la caja</h1>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {message}
      </p>
    </div>
  );
}
