'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  RegisterEntrySchema,
  MarkStockExitSchema,
  type RegisterEntryState,
  type MarkStockExitState,
} from './schema';

// NB: 'use server' file — solo async functions. Schemas/types en ./schema.

/**
 * Registra una entrada de material al almacén.
 *
 * Flujo:
 *   1. Validar (Zod).
 *   2. Auth: `registered_by` = uid del usuario logueado (warehouse o admin
 *      debido al RBAC del middleware; el INSERT no chequea rol porque el
 *      middleware ya filtró el acceso a /warehouse).
 *   3. Leer inventory.stock_total actual (read → +qty → write — sin RPC,
 *      con riesgo de race condition aceptado para esta iteración).
 *   4. UPDATE inventory SET stock_total += quantity.
 *   5. INSERT inventory_movements (movement_type='entrada', quantity,
 *      color_id, reference, unit_cost, registered_by).
 *
 * Si el INSERT del movement falla tras el UPDATE del stock, hacemos
 * rollback del UPDATE (le devolvemos los stocks viejos). Esto es
 * best-effort pero mejor que dejar la DB inconsistente.
 */
export async function registerEntryAction(
  _prev: RegisterEntryState,
  formData: FormData,
): Promise<RegisterEntryState> {
  try {
    const quantityRaw = formData.get('quantity');
    const unitCostRaw = formData.get('unit_cost');
    const parsed = RegisterEntrySchema.safeParse({
      color_id: formData.get('color_id'),
      quantity:
        typeof quantityRaw === 'string' ? Number(quantityRaw) : NaN,
      reference: formData.get('reference'),
      unit_cost:
        typeof unitCostRaw === 'string' && unitCostRaw.length > 0
          ? Number(unitCostRaw)
          : undefined,
    });
    if (!parsed.success) {
      return {
        status: 'error',
        message: 'Datos inválidos',
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      };
    }
    const data = parsed.data;

    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      return {
        status: 'error',
        message: 'Sesión no válida. Vuelve a iniciar sesión.',
      };
    }
    const userId = user.id;

    const admin = supabaseAdmin();

    // Leer fila de inventory actual para sumar. Traemos también
    // stock_committed, stock_minimum y el name del color (vía join) — los
    // necesitamos al final para evaluar si el stock quedó bajo y emitir
    // la notificación 'stock_bajo'.
    const { data: invRow, error: invErr } = await admin
      .from('inventory')
      .select(
        'id, stock_total, stock_committed, stock_minimum, colors ( name )',
      )
      .eq('color_id', data.color_id)
      .maybeSingle();
    if (invErr) {
      return {
        status: 'error',
        message: `No se pudo leer inventario: ${invErr.message}`,
      };
    }
    if (!invRow) {
      return {
        status: 'error',
        message:
          'No existe fila de inventory para este color. Crea el color desde /admin/catalogs primero.',
      };
    }
    const previousTotal = Number(invRow.stock_total ?? 0);
    const newTotal = previousTotal + data.quantity;
    const stockCommitted = Number(invRow.stock_committed ?? 0);
    const stockMinimum = Number(invRow.stock_minimum ?? 0);
    // PostgREST devuelve el embed `colors(name)` como objeto o como array
    // dependiendo de la cardinalidad inferida; toleramos ambas formas.
    const colorObj = Array.isArray(invRow.colors)
      ? invRow.colors[0]
      : invRow.colors;
    const colorName = colorObj?.name ?? '(sin nombre)';

    // UPDATE stock_total
    const { error: updErr } = await admin
      .from('inventory')
      .update({ stock_total: newTotal })
      .eq('id', invRow.id);
    if (updErr) {
      console.error('[registerEntryAction] update inventory falló:', updErr);
      return {
        status: 'error',
        message: `No se pudo actualizar el stock: ${updErr.message}`,
      };
    }

    // INSERT movement; si falla, revertimos el UPDATE.
    const { error: mvErr } = await admin
      .from('inventory_movements')
      .insert({
        color_id: data.color_id,
        movement_type: 'entrada',
        quantity: data.quantity,
        reference:
          data.reference && data.reference.length > 0 ? data.reference : null,
        unit_cost: data.unit_cost ?? null,
        registered_by: userId,
      });
    if (mvErr) {
      console.error('[registerEntryAction] insert movement falló:', mvErr);
      // Rollback del UPDATE.
      await admin
        .from('inventory')
        .update({ stock_total: previousTotal })
        .eq('id', invRow.id)
        .then(({ error }) => {
          if (error) {
            console.error(
              '[registerEntryAction] rollback inventory update falló:',
              error,
            );
          }
        });
      return {
        status: 'error',
        message: `No se pudo registrar el movimiento: ${mvErr.message}`,
      };
    }

    // ── Notificación 'stock_bajo' a admins si la entrada NO fue
    //    suficiente para superar el mínimo. Útil cuando alguien recibe
    //    un pedido pequeño y el stock sigue por debajo del umbral
    //    operativo (caso típico: reposición parcial mientras llega el
    //    grueso del pedido). Best-effort, no fatal.
    const stockAvailable = Math.max(0, newTotal - stockCommitted);
    if (stockAvailable <= stockMinimum) {
      try {
        const { data: admins } = await admin
          .from('profiles')
          .select('id')
          .eq('role', 'admin')
          .eq('is_active', true);
        if (admins && admins.length > 0) {
          const message = `Stock bajo en ${colorName}: ${stockAvailable} hojas disponibles`;
          const inserts = admins.map((a) => ({
            recipient_id: a.id,
            type: 'stock_bajo',
            message,
          }));
          const { error: notifErr } = await admin
            .from('notifications')
            .insert(inserts);
          if (notifErr) {
            console.error(
              '[registerEntryAction] notif insert falló (no fatal):',
              notifErr,
            );
          }
        }
      } catch (e) {
        console.error(
          '[registerEntryAction] notif lookup/insert falló (no fatal):',
          e,
        );
      }
    }

    revalidatePath('/warehouse');
    revalidatePath('/warehouse/movements');
    revalidatePath('/admin/catalogs');
    return {
      status: 'success',
      message: `Entrada registrada (+${data.quantity} hojas).`,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al registrar entrada';
    console.error('[registerEntryAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}

/**
 * `markStockExitAction` — el almacenista marca la mercancía de un lead
 * como físicamente lista para entrega. Convierte el "compromiso" en
 * "salida" definitiva: descuenta de stock_total Y de stock_committed.
 *
 * Reemplaza la Edge Function `commit-stock-delivery` que se invocaba
 * desde el chofer al confirmar entrega — la responsabilidad ahora es
 * del almacenista (más temprano en el flujo, antes de que el chofer
 * salga).
 *
 * Flujo:
 *   1. Validar (Zod).
 *   2. Auth: registered_by = uid del usuario logueado.
 *   3. SELECT lead (verificar que existe y está pendiente/en_transito;
 *      si ya está entregado/cancelado, no hace nada — idempotencia).
 *   4. SELECT lead_colors WHERE lead_id = lead_id.
 *   5. Por cada lead_color:
 *        - SELECT inventory.stock_total + stock_committed para ese color.
 *        - UPDATE inventory: stock_total -= qty, stock_committed -= qty.
 *        - INSERT inventory_movements: movement_type='salida',
 *          quantity, lead_id, color_id, registered_by,
 *          reference='Salida confirmada por almacén'.
 *   6. UPDATE leads.delivery_status = 'en_transito'.
 *   7. Notif al chofer (si tiene driver_id) — non-fatal.
 *
 * Política de errores: rollback manual con TxnLog igual que
 * saveLeadAction. Si paso 5 falla a la mitad (n de N colores), revertimos
 * los UPDATEs de inventory previos. INSERTs de inventory_movements
 * también se rolan.
 */
type Undo = () => Promise<void>;
class TxnLog {
  private stack: Undo[] = [];
  push(fn: Undo) {
    this.stack.push(fn);
  }
  async rollback(reason: string): Promise<void> {
    console.error(`[markStockExitAction] iniciando rollback: ${reason}`);
    while (this.stack.length > 0) {
      const fn = this.stack.pop()!;
      try {
        await fn();
      } catch (e) {
        console.error('[markStockExitAction] paso de rollback falló:', e);
      }
    }
  }
}

export async function markStockExitAction(
  _prev: MarkStockExitState,
  formData: FormData,
): Promise<MarkStockExitState> {
  const txn = new TxnLog();
  try {
    const parsed = MarkStockExitSchema.safeParse({
      lead_id: formData.get('lead_id'),
    });
    if (!parsed.success) {
      return { status: 'error', message: 'lead_id inválido.' };
    }
    const { lead_id } = parsed.data;

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

    // Verificar lead existe y está en un estado que permite salida.
    const { data: leadRow, error: leadErr } = await admin
      .from('leads')
      .select('id, delivery_status, client_name, driver_id')
      .eq('id', lead_id)
      .maybeSingle();
    if (leadErr) {
      return { status: 'error', message: `No se pudo leer el lead: ${leadErr.message}` };
    }
    if (!leadRow) {
      return { status: 'error', message: 'Lead no encontrado.' };
    }
    if (
      leadRow.delivery_status !== 'pendiente' &&
      leadRow.delivery_status !== 'en_transito'
    ) {
      return {
        status: 'error',
        message: `El lead está en estado "${leadRow.delivery_status}" — no se puede marcar salida.`,
      };
    }

    // Cargar lead_colors.
    const { data: leadColors, error: lcErr } = await admin
      .from('lead_colors')
      .select('color_id, quantity')
      .eq('lead_id', lead_id);
    if (lcErr) {
      return { status: 'error', message: `No se pudieron leer materiales: ${lcErr.message}` };
    }
    if (!leadColors || leadColors.length === 0) {
      return { status: 'error', message: 'El lead no tiene materiales registrados.' };
    }

    // Por cada lead_color: read inventory → update -= qty → insert movement.
    for (const lc of leadColors) {
      if (!lc.color_id) continue;
      const qty = Number(lc.quantity ?? 0);
      if (qty <= 0) continue;

      const { data: invRow, error: invSelErr } = await admin
        .from('inventory')
        .select('id, stock_total, stock_committed')
        .eq('color_id', lc.color_id)
        .maybeSingle();
      if (invSelErr) {
        await txn.rollback('select inventory falló');
        return { status: 'error', message: `No se pudo leer inventario: ${invSelErr.message}` };
      }
      if (!invRow) {
        await txn.rollback('falta fila de inventory');
        return {
          status: 'error',
          message: `No existe fila de inventory para color_id=${lc.color_id}.`,
        };
      }

      const previousTotal = Number(invRow.stock_total ?? 0);
      const previousCommitted = Number(invRow.stock_committed ?? 0);
      const newTotal = Math.max(0, previousTotal - qty);
      // Si stock_committed < qty (incongruencia histórica), bajamos a 0.
      const newCommitted = Math.max(0, previousCommitted - qty);

      const { error: updErr } = await admin
        .from('inventory')
        .update({ stock_total: newTotal, stock_committed: newCommitted })
        .eq('id', invRow.id);
      if (updErr) {
        await txn.rollback('update inventory falló');
        return { status: 'error', message: `No se pudo actualizar inventario: ${updErr.message}` };
      }
      txn.push(async () => {
        await admin
          .from('inventory')
          .update({
            stock_total: previousTotal,
            stock_committed: previousCommitted,
          })
          .eq('id', invRow.id);
      });

      // INSERT movement de salida.
      const { data: mvRow, error: mvErr } = await admin
        .from('inventory_movements')
        .insert({
          color_id: lc.color_id,
          movement_type: 'salida',
          quantity: qty,
          lead_id,
          registered_by: userId,
          reference: 'Salida confirmada por almacén',
        })
        .select('id')
        .single();
      if (mvErr || !mvRow) {
        await txn.rollback('insert movement salida falló');
        return {
          status: 'error',
          message: `No se pudo registrar movimiento: ${mvErr?.message ?? 'sin datos'}`,
        };
      }
      const movementId: string = mvRow.id;
      txn.push(async () => {
        await admin.from('inventory_movements').delete().eq('id', movementId);
      });
    }

    // UPDATE leads.delivery_status='en_transito'.
    const { error: leadUpdErr } = await admin
      .from('leads')
      .update({ delivery_status: 'en_transito' })
      .eq('id', lead_id);
    if (leadUpdErr) {
      await txn.rollback('update lead.delivery_status falló');
      return {
        status: 'error',
        message: `No se pudo actualizar el lead: ${leadUpdErr.message}`,
      };
    }

    // Notif al chofer (non-fatal).
    if (leadRow.driver_id) {
      try {
        const message = `La mercancía de ${leadRow.client_name ?? 'la entrega'} está lista para entrega`;
        const { error: notifErr } = await admin.from('notifications').insert({
          recipient_id: leadRow.driver_id,
          type: 'mercancia_lista',
          message,
        });
        if (notifErr) {
          console.error(
            '[markStockExitAction] notif al chofer falló (no fatal):',
            notifErr,
          );
        }
      } catch (e) {
        console.error(
          '[markStockExitAction] notif al chofer excepción (no fatal):',
          e,
        );
      }
    }

    revalidatePath('/warehouse');
    revalidatePath('/warehouse/movements');
    revalidatePath('/admin/entregas');
    return {
      status: 'success',
      message: 'Salida registrada — mercancía lista para entrega.',
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al registrar salida';
    console.error('[markStockExitAction] excepción no controlada:', err);
    await txn.rollback('excepción no controlada');
    return { status: 'error', message };
  }
}
