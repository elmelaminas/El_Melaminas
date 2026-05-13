'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  ResolveIssueSchema,
  AssignRouteSchema,
  ReturnStockSchema,
  type ResolveIssueState,
  type AssignRouteState,
  type ReturnStockState,
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
 * `returnStockAction(_prev, formData)` — el admin marca que el material
 * de una entrega fallida regresó al almacén. Por cada `lead_colors`
 * del lead: aumenta `stock_total` (+qty), disminuye `stock_committed`
 * (-qty) en `inventory`, e inserta un movimiento `entrada` con
 * `reference='Devolución — entrega fallida'`. Al final marca el lead
 * con `stock_returned=true`, libera `stock_committed=false` y resetea
 * `delivery_status='pendiente'` (queda listo para reagendar la ruta).
 *
 * TxnLog manual para rollback (mismo patrón que markStockExitAction y
 * saveLeadAction): si un paso intermedio falla, deshacemos los efectos
 * previos. NO es ACID — si el proceso muere a mitad de un rollback
 * pueden quedar filas inconsistentes; con RPC Postgres eso desaparece.
 *
 * Idempotencia: si el lead ya tiene `stock_returned=true` rechazamos
 * con mensaje claro. Esto evita doble suma al stock_total cuando un
 * admin clickea dos veces el botón (aunque la UI también lo bloquea
 * con pending state).
 *
 * Triple defensa admin (middleware + page + action).
 */
type ReturnUndo = () => Promise<void>;
class ReturnTxnLog {
  private stack: ReturnUndo[] = [];
  push(fn: ReturnUndo) {
    this.stack.push(fn);
  }
  async rollback(reason: string): Promise<void> {
    console.error(`[returnStockAction] rollback: ${reason}`);
    while (this.stack.length > 0) {
      const fn = this.stack.pop()!;
      try {
        await fn();
      } catch (e) {
        console.error('[returnStockAction] paso de rollback falló:', e);
      }
    }
  }
}

export async function returnStockAction(
  _prev: ReturnStockState,
  formData: FormData,
): Promise<ReturnStockState> {
  const txn = new ReturnTxnLog();
  try {
    const parsed = ReturnStockSchema.safeParse({
      lead_id: formData.get('lead_id'),
    });
    if (!parsed.success) {
      return { status: 'error', message: 'lead_id inválido.' };
    }
    const { lead_id } = parsed.data;

    // ── Auth + admin role
    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      return { status: 'error', message: 'Sesión no válida.' };
    }
    const userId = user.id;

    const admin = supabaseAdmin();

    const { data: callerProfile, error: profErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (profErr) {
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${profErr.message}`,
      };
    }
    if (callerProfile?.role !== 'admin') {
      return {
        status: 'error',
        message: 'Solo un administrador puede devolver stock.',
      };
    }

    // ── Verificar el estado del lead (idempotencia + sanity)
    const { data: leadRow, error: leadErr } = await admin
      .from('leads')
      .select(
        'id, client_name, stock_returned, failed_delivery_reason, stock_committed',
      )
      .eq('id', lead_id)
      .maybeSingle();
    if (leadErr) {
      return {
        status: 'error',
        message: `No se pudo leer el lead: ${leadErr.message}`,
      };
    }
    if (!leadRow) {
      return { status: 'error', message: 'Lead no encontrado.' };
    }
    if (leadRow.stock_returned === true) {
      return {
        status: 'error',
        message: 'Este lead ya tiene su stock devuelto.',
      };
    }
    // NB: NO bloqueamos si `failed_delivery_reason` está vacío. Aunque
    // el flujo principal es "devolver tras falla", el admin podría
    // querer devolver stock de un lead que se cancela por otra razón.
    // La UI sí esconde el botón cuando no hay falla — la action acepta
    // el caso por robustez.

    // ── Cargar lead_colors (qty por color a regresar al stock)
    const { data: lcRows, error: lcErr } = await admin
      .from('lead_colors')
      .select('color_id, quantity')
      .eq('lead_id', lead_id);
    if (lcErr) {
      return {
        status: 'error',
        message: `No se pudieron leer los colores del lead: ${lcErr.message}`,
      };
    }
    const lineItems = (lcRows ?? []).filter(
      (r): r is { color_id: string; quantity: number } =>
        !!r.color_id && Number(r.quantity ?? 0) > 0,
    );
    if (lineItems.length === 0) {
      return {
        status: 'error',
        message: 'El lead no tiene colores asociados; nada que devolver.',
      };
    }

    // ── Por cada color: actualizar inventory + insertar movement.
    //    Cada paso registra su propio undo (revertir el delta).
    for (const li of lineItems) {
      // Leer fila actual de inventory para sumar atómicamente. PostgREST
      // no expone UPDATE con expression sobre la columna sin RPC.
      const { data: invRow, error: invSelErr } = await admin
        .from('inventory')
        .select('id, stock_total, stock_committed')
        .eq('color_id', li.color_id)
        .maybeSingle();
      if (invSelErr) {
        await txn.rollback('select inventory falló');
        return {
          status: 'error',
          message: `No se pudo leer inventario: ${invSelErr.message}`,
        };
      }
      if (!invRow) {
        await txn.rollback('falta fila de inventario');
        return {
          status: 'error',
          message: `Falta fila de inventario para color_id=${li.color_id}.`,
        };
      }
      const prevTotal = Number(invRow.stock_total ?? 0);
      const prevCommitted = Number(invRow.stock_committed ?? 0);
      const qty = Number(li.quantity);

      // stock_total += qty   (regresa físicamente al almacén)
      // stock_committed -= qty (libera el compromiso del lead)
      // El committed se piso-a-cero para tolerar inconsistencias
      // históricas (mismo patrón que markStockExitAction).
      const nextCommitted = Math.max(0, prevCommitted - qty);

      const { error: updErr } = await admin
        .from('inventory')
        .update({
          stock_total: prevTotal + qty,
          stock_committed: nextCommitted,
        })
        .eq('id', invRow.id);
      if (updErr) {
        await txn.rollback('update inventory falló');
        return {
          status: 'error',
          message: `No se pudo actualizar inventario: ${updErr.message}`,
        };
      }
      txn.push(async () => {
        await admin
          .from('inventory')
          .update({
            stock_total: prevTotal,
            stock_committed: prevCommitted,
          })
          .eq('id', invRow.id);
      });

      // Movimiento de entrada para auditoría. Aparece en
      // /warehouse/movements con badge verde "Entrada" y la
      // referencia visible.
      const { data: mvRow, error: mvErr } = await admin
        .from('inventory_movements')
        .insert({
          color_id: li.color_id,
          movement_type: 'entrada',
          quantity: qty,
          lead_id,
          registered_by: userId,
          reference: 'Devolución — entrega fallida',
        })
        .select('id')
        .single();
      if (mvErr || !mvRow) {
        await txn.rollback('insert movement falló');
        return {
          status: 'error',
          message: `No se pudo registrar el movimiento: ${
            mvErr?.message ?? 'sin datos'
          }`,
        };
      }
      const movementId: string = mvRow.id;
      txn.push(async () => {
        await admin
          .from('inventory_movements')
          .delete()
          .eq('id', movementId);
      });
    }

    // ── Actualizar el lead: marcar devuelto, liberar compromiso,
    //    reset a pendiente para reagendar.
    const { error: leadUpdErr } = await admin
      .from('leads')
      .update({
        stock_returned: true,
        stock_committed: false,
        delivery_status: 'pendiente',
      })
      .eq('id', lead_id);
    if (leadUpdErr) {
      await txn.rollback('update lead falló');
      return {
        status: 'error',
        message: `No se pudo actualizar el lead: ${leadUpdErr.message}`,
      };
    }

    // ── Notificar al almacén (non-fatal). Buscamos profiles con
    //    role='warehouse' activos. Mismo patrón que el resto del
    //    proyecto: si falla loguamos y seguimos.
    try {
      const { data: warehouseUsers } = await admin
        .from('profiles')
        .select('id')
        .eq('role', 'warehouse')
        .eq('is_active', true);
      if (warehouseUsers && warehouseUsers.length > 0) {
        const clientName = leadRow.client_name ?? '(sin nombre)';
        const message =
          `📦 Material devuelto al stock: ${clientName} — ` +
          `${lineItems.length} ${
            lineItems.length === 1 ? 'color regresado' : 'colores regresados'
          }`;
        const inserts = warehouseUsers.map((w) => ({
          recipient_id: w.id,
          type: 'stock_returned',
          message,
        }));
        const { error: notifErr } = await admin
          .from('notifications')
          .insert(inserts);
        if (notifErr) {
          console.error(
            '[returnStockAction] notif insert falló (no fatal):',
            notifErr,
          );
        }
      }
    } catch (e) {
      console.error(
        '[returnStockAction] notif lookup/insert excepción (no fatal):',
        e,
      );
    }

    revalidatePath('/admin/entregas');
    revalidatePath('/warehouse');
    revalidatePath('/warehouse/movements');
    return {
      status: 'success',
      message: `Stock devuelto al inventario (${lineItems.length} ${
        lineItems.length === 1 ? 'color' : 'colores'
      }).`,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al devolver stock';
    console.error('[returnStockAction] excepción no controlada:', err);
    await txn.rollback('excepción no controlada');
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
