import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  ContadorClient,
  type AdminWithCash,
  type ValidationHistoryRow,
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

export default async function ContadorPage() {
  try {
    const admin = supabaseAdmin();

    const userClient = await supabaseServer();
    const {
      data: { user },
    } = await userClient.auth.getUser();
    const contadorId = user?.id ?? null;

    // Tres queries en paralelo:
    //   1. Admins activos (admin + admin2)
    //   2. admin_cash_register completo (para sumar por admin)
    //   3. Historial personal de validaciones del contador actual
    const [adminsRes, cashRes, historyRes] = await Promise.all([
      admin
        .from('profiles')
        .select('id, full_name, role')
        .in('role', ['admin', 'admin2'])
        .eq('is_active', true)
        .order('full_name', { ascending: true }),
      admin
        .from('admin_cash_register')
        .select('admin_id, amount, operation_type, created_at'),
      contadorId
        ? admin
            .from('admin_cash_register')
            .select(
              'id, admin_id, amount, operation_type, source, created_at',
            )
            .eq('registered_by', contadorId)
            .eq('source', 'validado_contador')
            .order('created_at', { ascending: false })
            .limit(20)
        : Promise.resolve({ data: [], error: null }),
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

    // Agregar por admin_id: ingresos totales, egresos totales,
    // saldo (ingresos − egresos) e ingresos del mes en curso.
    const now = new Date();
    const startOfMonthIso = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();

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
      if (isIngreso && r.created_at && r.created_at >= startOfMonthIso) {
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

    // Historial: resolver nombres de admins involucrados.
    const historyRaw = historyRes.data ?? [];
    const histAdminIds = Array.from(
      new Set(
        historyRaw.map((h) => h.admin_id).filter((x): x is string => !!x),
      ),
    );
    const nameById = new Map<string, string>();
    // Reusamos la lista de admins ya cargada para nombres comunes;
    // sólo consultamos extra si algún egreso histórico apunta a un
    // admin que ya no está en la lista activa.
    for (const a of admins) nameById.set(a.admin_id, a.admin_name);
    const missing = histAdminIds.filter((id) => !nameById.has(id));
    if (missing.length > 0) {
      const { data: extra } = await admin
        .from('profiles')
        .select('id, full_name')
        .in('id', missing);
      for (const u of extra ?? []) {
        nameById.set(u.id, u.full_name ?? '(sin nombre)');
      }
    }
    const history: ValidationHistoryRow[] = historyRaw.map((h) => ({
      id: h.id,
      admin_name: h.admin_id
        ? nameById.get(h.admin_id) ?? '—'
        : '—',
      amount: Number(h.amount ?? 0),
      created_at: h.created_at ?? null,
    }));

    return (
      <ContadorClient
        admins={admins}
        grandTotal={grandTotal}
        history={history}
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
