'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  ResolveIssueSchema,
  AssignRouteSchema,
  type ResolveIssueState,
  type AssignRouteState,
} from './schema';

// NB: 'use server' file — solo async functions.

/**
 * `resolveIssueAction(_prev, formData)` — admin marca un delivery_issue
 * como resuelto. Triple defensa de role admin (middleware, page, action).
 */
export async function resolveIssueAction(
  _prev: ResolveIssueState,
  formData: FormData,
): Promise<ResolveIssueState> {
  try {
    const parsed = ResolveIssueSchema.safeParse({
      issue_id: formData.get('issue_id'),
    });
    if (!parsed.success) {
      return { status: 'error', message: 'issue_id inválido.' };
    }

    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      return { status: 'error', message: 'Sesión no válida.' };
    }

    const admin = supabaseAdmin();

    // Role check: solo admin puede resolver issues.
    const { data: profile, error: profileErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if (profileErr) {
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${profileErr.message}`,
      };
    }
    if (profile?.role !== 'admin') {
      return {
        status: 'error',
        message: 'Solo un administrador puede resolver issues.',
      };
    }

    const { error: updErr } = await admin
      .from('delivery_issues')
      .update({ resolved: true })
      .eq('id', parsed.data.issue_id);
    if (updErr) {
      return {
        status: 'error',
        message: `No se pudo resolver: ${updErr.message}`,
      };
    }

    revalidatePath('/admin/entregas');
    return { status: 'success' };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al resolver';
    console.error('[resolveIssueAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}

/**
 * `assignDeliveryRouteAction(_prev, formData)` — admin asigna la ruta de
 * entregas para una fecha. El cliente arma una lista completa
 * (delivery_date, assignments[]) y la envía como JSON serializado en el
 * FormData (campo `assignments`).
 *
 * Flujo:
 *   1. Parse + Zod validate.
 *   2. Auth + verificación admin (triple defense: middleware, page,
 *      action).
 *   3. Por cada assignment:
 *        - Si delivery_order > 0: UPDATE leads SET delivery_order=N,
 *          delivery_date=fecha.
 *        - Si delivery_order === 0: UPDATE leads SET delivery_order=NULL,
 *          delivery_date=NULL (quitar de la ruta).
 *   4. Por cada chofer único afectado, INSERT notificación
 *      `type='ruta_asignada'`. La notif es non-fatal: si falla,
 *      loguamos pero no abortamos — la ruta ya quedó asignada.
 *   5. revalidatePath('/admin/entregas') y '/driver' (para que la vista
 *      del chofer se actualice si está abierta).
 *
 * Política: si UN UPDATE falla intentamos seguir con los demás (mejor
 * 80 % de la ruta asignada que 0 %), pero devolvemos el error al final
 * para que el admin sepa qué pasó. NO hay rollback en este action — la
 * asignación es informativa, los costos de inconsistencia son bajos.
 */
export async function assignDeliveryRouteAction(
  _prev: AssignRouteState,
  formData: FormData,
): Promise<AssignRouteState> {
  try {
    const dateRaw = formData.get('delivery_date');
    const assignmentsRaw = formData.get('assignments');

    let parsedAssignments: unknown = [];
    if (typeof assignmentsRaw === 'string' && assignmentsRaw.trim().length > 0) {
      try {
        parsedAssignments = JSON.parse(assignmentsRaw);
      } catch {
        return {
          status: 'error',
          message: 'No se pudieron leer las asignaciones (JSON inválido).',
        };
      }
    }

    const parsed = AssignRouteSchema.safeParse({
      delivery_date: dateRaw,
      assignments: parsedAssignments,
    });
    if (!parsed.success) {
      const fe = parsed.error.flatten().fieldErrors as Record<string, string[]>;
      const firstErr =
        fe.delivery_date?.[0] ??
        fe.assignments?.[0] ??
        'Datos inválidos.';
      return { status: 'error', message: firstErr };
    }
    const { delivery_date, assignments } = parsed.data;

    // ── Auth + admin role
    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      return { status: 'error', message: 'Sesión no válida.' };
    }

    const admin = supabaseAdmin();

    const { data: profile, error: profileErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if (profileErr) {
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${profileErr.message}`,
      };
    }
    if (profile?.role !== 'admin') {
      return {
        status: 'error',
        message: 'Solo un administrador puede asignar rutas.',
      };
    }

    // ── Pre-leer los leads afectados (necesitamos driver_id y
    //    client_name para la notificación). UNA query.
    const leadIds = assignments.map((a) => a.lead_id);
    const { data: leadRows, error: leadsErr } = await admin
      .from('leads')
      .select('id, driver_id, client_name')
      .in('id', leadIds);
    if (leadsErr) {
      return {
        status: 'error',
        message: `No se pudo leer los leads: ${leadsErr.message}`,
      };
    }
    const leadById = new Map<
      string,
      { driver_id: string | null; client_name: string }
    >();
    for (const l of leadRows ?? []) {
      leadById.set(l.id, {
        driver_id: l.driver_id,
        client_name: l.client_name ?? '(sin nombre)',
      });
    }

    // ── Aplicar UPDATEs uno por uno. PostgREST no soporta un bulk
    //    UPDATE con valores diferentes por fila sin RPC. N=10 típico,
    //    asumimos cost trivial.
    let okCount = 0;
    const failures: string[] = [];
    // Choferes a notificar: contamos cuántas entregas activas (orden>0)
    // recibió cada uno en esta ronda para personalizar el mensaje.
    const driverDeliveryCount = new Map<string, number>();

    for (const a of assignments) {
      const isActive = a.delivery_order > 0;
      const updateBody = isActive
        ? {
            delivery_order: a.delivery_order,
            delivery_date,
          }
        : {
            // 0 = quitar de la ruta de ese día.
            delivery_order: null,
            delivery_date: null,
          };
      const { error: updErr } = await admin
        .from('leads')
        .update(updateBody)
        .eq('id', a.lead_id);
      if (updErr) {
        console.error(
          `[assignDeliveryRouteAction] UPDATE lead ${a.lead_id} falló:`,
          updErr,
        );
        const lead = leadById.get(a.lead_id);
        failures.push(
          `${lead?.client_name ?? a.lead_id.slice(0, 8)}: ${updErr.message}`,
        );
        continue;
      }
      okCount++;
      if (isActive) {
        const driverId = leadById.get(a.lead_id)?.driver_id;
        if (driverId) {
          driverDeliveryCount.set(
            driverId,
            (driverDeliveryCount.get(driverId) ?? 0) + 1,
          );
        }
      }
    }

    // ── Notificaciones a choferes (non-fatal). Una notif por chofer
    //    con el conteo total que recibió en esta ronda.
    if (driverDeliveryCount.size > 0) {
      try {
        const dateLabel = formatDateForNotif(delivery_date);
        const inserts = Array.from(driverDeliveryCount.entries()).map(
          ([driverId, count]) => ({
            recipient_id: driverId,
            type: 'ruta_asignada',
            message: `Tienes ${count} ${
              count === 1 ? 'entrega programada' : 'entregas programadas'
            } para ${dateLabel}`,
          }),
        );
        const { error: notifErr } = await admin
          .from('notifications')
          .insert(inserts);
        if (notifErr) {
          console.error(
            '[assignDeliveryRouteAction] notif insert falló (no fatal):',
            notifErr,
          );
        }
      } catch (e) {
        console.error(
          '[assignDeliveryRouteAction] notif lookup/insert excepción (no fatal):',
          e,
        );
      }
    }

    revalidatePath('/admin/entregas');
    revalidatePath('/driver');

    if (failures.length > 0 && okCount === 0) {
      return {
        status: 'error',
        message: `No se asignó ninguna entrega. Errores:\n${failures
          .slice(0, 5)
          .join('\n')}`,
      };
    }
    if (failures.length > 0) {
      return {
        status: 'error',
        message: `Se asignaron ${okCount} entregas, pero ${failures.length} fallaron:\n${failures
          .slice(0, 5)
          .join('\n')}`,
      };
    }
    return {
      status: 'success',
      message: `Ruta del ${delivery_date} actualizada (${okCount} entregas).`,
      count: okCount,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al asignar la ruta';
    console.error(
      '[assignDeliveryRouteAction] excepción no controlada:',
      err,
    );
    return { status: 'error', message };
  }
}

/**
 * Formato corto de fecha para usar dentro de mensajes de notificación.
 * Recibe YYYY-MM-DD y devuelve "DD/MMM/YYYY" en español. Si no parsea,
 * devuelve la fecha cruda — la notif no debe romperse por esto.
 */
function formatDateForNotif(iso: string): string {
  // Construimos la fecha como UTC para que YYYY-MM-DD no dependa del
  // huso horario del servidor (Vercel / Supabase suelen estar en UTC,
  // pero queremos consistencia).
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
