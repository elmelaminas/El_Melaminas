'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  UpdateLeadColorSchema,
  MarkFabricaDeliveredSchema,
  DeleteLeadSchema,
  type UpdateLeadColorState,
  type MarkFabricaDeliveredState,
  type DeleteLeadState,
} from './schema';

// NB: 'use server' file — solo async functions. Tipos y schemas viven
// en `./schema.ts`.

/**
 * `updateLeadColorAction(_prev, formData)` — el admin asigna (o limpia)
 * el override manual de color de fila para un lead desde el selector
 * inline en /leads o /admin/entregas.
 *
 * Triple defensa de admin:
 *   1. middleware ya bloquea /admin/* a no-admins (pero /leads NO está
 *      bajo /admin — cualquier usuario logueado puede entrar).
 *   2. page-level: /leads no chequea rol porque vendedores también lo
 *      ven (solo lectura).
 *   3. ACTION-level: ACÁ es donde se valida que el caller sea admin.
 *      Sin esto, un vendedor con DevTools podría disparar la action
 *      y cambiar colores ajenos.
 *
 * Si 'sin_color' llega, el UPDATE escribe la string 'sin_color' (que
 * pasa el CHECK constraint). En `getLeadRowColor` ese valor se trata
 * como "no override" y volvemos a las reglas automáticas.
 */
export async function updateLeadColorAction(
  _prev: UpdateLeadColorState,
  formData: FormData,
): Promise<UpdateLeadColorState> {
  try {
    const parsed = UpdateLeadColorSchema.safeParse({
      lead_id: formData.get('lead_id'),
      row_color: formData.get('row_color'),
    });
    if (!parsed.success) {
      const fe = parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >;
      const first =
        fe.row_color?.[0] ?? fe.lead_id?.[0] ?? 'Datos inválidos.';
      return { status: 'error', message: first };
    }
    const { lead_id, row_color } = parsed.data;

    // ── Auth + role admin
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
    if (profile?.role !== 'admin' && profile?.role !== 'admin2') {
      return {
        status: 'error',
        message: 'Solo un administrador puede cambiar el color de fila.',
      };
    }

    // ── UPDATE leads.row_color. El CHECK constraint de la migración
    //    rechaza valores fuera de la lista — UpdateLeadColorSchema
    //    valida lo mismo en cliente para que el round-trip no falle
    //    por validación de DB.
    const { error: updErr } = await admin
      .from('leads')
      .update({ row_color })
      .eq('id', lead_id);
    if (updErr) {
      console.error('[updateLeadColorAction] update falló:', updErr);
      return {
        status: 'error',
        message: `No se pudo actualizar el color: ${updErr.message}`,
      };
    }

    // Ambas vistas reflejan colores de fila — invalidamos las dos.
    revalidatePath('/leads');
    revalidatePath('/admin/entregas');
    return { status: 'success' };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al actualizar color';
    console.error('[updateLeadColorAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}

/**
 * `markFabricaDeliveredAction(_prev, formData)` — admin o vendedor
 * marca una compra "En fábrica" como entregada directamente desde el
 * listado de /leads o /admin/entregas, sin pasar por la vista del chofer.
 *
 * Flujo:
 *   1. Auth + role ∈ {admin, admin2, seller}.
 *   2. Verificar que el lead exista, sea purchase_type='fabrica' y
 *      delivery_status='pendiente' (o 'en_transito'). Si ya está
 *      'entregado' devolvemos success idempotente.
 *   3. UPDATE leads SET delivery_status='entregado'.
 *   4. Si has_hojas: por cada lead_color → resta stock_total y
 *      stock_committed e inserta movement 'salida' con reference
 *      'Entrega en fábrica'. Mismo patrón que warehouse.confirmSalida.
 *   5. Notifica a los admins activos (type='entrega_confirmada').
 *   6. revalidatePath('/leads') + revalidatePath('/admin/entregas').
 *
 * Sin RPC todavía: el bloque de inventario tiene rollback manual via
 * TxnLog (mismo patrón que warehouse). Si crece a más de N filas,
 * portar a una RPC `mark_fabrica_delivered`.
 */
type Undo = () => Promise<void>;
class FabricaTxnLog {
  private stack: Undo[] = [];
  push(fn: Undo) {
    this.stack.push(fn);
  }
  async rollback(reason: string): Promise<void> {
    console.error(`[markFabricaDeliveredAction] rollback: ${reason}`);
    while (this.stack.length > 0) {
      const fn = this.stack.pop()!;
      try {
        await fn();
      } catch (e) {
        console.error('[markFabricaDeliveredAction] paso de rollback falló:', e);
      }
    }
  }
}

export async function markFabricaDeliveredAction(
  _prev: MarkFabricaDeliveredState,
  formData: FormData,
): Promise<MarkFabricaDeliveredState> {
  const txn = new FabricaTxnLog();
  try {
    const parsed = MarkFabricaDeliveredSchema.safeParse({
      lead_id: formData.get('lead_id'),
    });
    if (!parsed.success) {
      const fe = parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >;
      return {
        status: 'error',
        message: fe.lead_id?.[0] ?? 'Datos inválidos.',
      };
    }
    const { lead_id } = parsed.data;

    // ── Auth + role.
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

    const { data: profile, error: profileErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (profileErr) {
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${profileErr.message}`,
      };
    }
    const role = profile?.role ?? '';
    if (role !== 'admin' && role !== 'admin2' && role !== 'seller') {
      return {
        status: 'error',
        message: 'Solo admin o vendedor puede marcar entregas en fábrica.',
      };
    }

    // ── Cargar lead. Necesitamos purchase_type, delivery_status,
    //    has_hojas y client_name (para la notificación).
    const { data: leadRow, error: leadErr } = await admin
      .from('leads')
      .select(
        'id, purchase_type, delivery_status, has_hojas, client_name, deleted_at',
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
    if (leadRow.deleted_at) {
      return { status: 'error', message: 'Este lead está cancelado.' };
    }
    if (leadRow.purchase_type !== 'fabrica') {
      return {
        status: 'error',
        message: 'Este lead no es una compra en fábrica.',
      };
    }
    if (leadRow.delivery_status === 'entregado') {
      // Idempotente: ya estaba entregado, no es un error.
      return { status: 'success' };
    }
    if (leadRow.delivery_status === 'cancelado') {
      return {
        status: 'error',
        message: 'Este lead está cancelado.',
      };
    }

    // ── UPDATE delivery_status='entregado'. updated_at lo manejan los
    //    triggers de la tabla (si existen) o queda intacto si no.
    const { error: updLeadErr } = await admin
      .from('leads')
      .update({ delivery_status: 'entregado' })
      .eq('id', lead_id);
    if (updLeadErr) {
      return {
        status: 'error',
        message: `No se pudo marcar entregado: ${updLeadErr.message}`,
      };
    }
    txn.push(async () => {
      await admin
        .from('leads')
        .update({ delivery_status: leadRow.delivery_status ?? 'pendiente' })
        .eq('id', lead_id);
    });

    // ── Si tiene hojas, descontar inventario.
    if (leadRow.has_hojas === true) {
      const { data: leadColors, error: lcErr } = await admin
        .from('lead_colors')
        .select('color_id, quantity')
        .eq('lead_id', lead_id);
      if (lcErr) {
        await txn.rollback('lead_colors select falló');
        return {
          status: 'error',
          message: `No se pudieron leer materiales: ${lcErr.message}`,
        };
      }
      for (const lc of leadColors ?? []) {
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
          return {
            status: 'error',
            message: `No se pudo leer inventario: ${invSelErr.message}`,
          };
        }
        if (!invRow) {
          await txn.rollback('falta fila de inventory');
          return {
            status: 'error',
            message: `Falta fila de inventario para color_id=${lc.color_id}.`,
          };
        }
        const previousTotal = Number(invRow.stock_total ?? 0);
        const previousCommitted = Number(invRow.stock_committed ?? 0);
        const newTotal = Math.max(0, previousTotal - qty);
        const newCommitted = Math.max(0, previousCommitted - qty);

        const { error: updErr } = await admin
          .from('inventory')
          .update({
            stock_total: newTotal,
            stock_committed: newCommitted,
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
              stock_total: previousTotal,
              stock_committed: previousCommitted,
            })
            .eq('id', invRow.id);
        });

        const { data: mvRow, error: mvErr } = await admin
          .from('inventory_movements')
          .insert({
            color_id: lc.color_id,
            movement_type: 'salida',
            quantity: qty,
            lead_id,
            registered_by: userId,
            reference: 'Entrega en fábrica',
          })
          .select('id')
          .single();
        if (mvErr || !mvRow) {
          await txn.rollback('insert movement salida falló');
          return {
            status: 'error',
            message: `No se pudo registrar movimiento: ${
              mvErr?.message ?? 'sin datos'
            }`,
          };
        }
        const movementId: string = mvRow.id;
        txn.push(async () => {
          await admin.from('inventory_movements').delete().eq('id', movementId);
        });
      }
    }

    // ── Notificación a admins (best-effort, no fatal).
    try {
      const { data: admins } = await admin
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .eq('is_active', true);
      if (admins && admins.length > 0) {
        const message = `✅ ${leadRow.client_name} recogió su pedido en fábrica`;
        const inserts = admins.map((a) => ({
          recipient_id: a.id,
          type: 'entrega_confirmada',
          message,
        }));
        const { error: notifErr } = await admin
          .from('notifications')
          .insert(inserts);
        if (notifErr) {
          console.error(
            '[markFabricaDeliveredAction] notif insert falló (no fatal):',
            notifErr,
          );
        }
      }
    } catch (e) {
      console.error(
        '[markFabricaDeliveredAction] notif lookup/insert excepción (no fatal):',
        e,
      );
    }

    revalidatePath('/leads');
    revalidatePath('/admin/entregas');
    revalidatePath('/warehouse');
    return { status: 'success' };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al marcar entrega en fábrica';
    console.error('[markFabricaDeliveredAction] excepción no controlada:', err);
    await txn.rollback('excepción no controlada');
    return { status: 'error', message };
  }
}

/**
 * `deleteLeadAction(lead_id)` — soft-delete del lead. SOLO admin/admin2.
 *
 * Hace `UPDATE leads SET deleted_at = now() WHERE id = lead_id`. Todas
 * las queries del listado (/leads, /admin/entregas, /warehouse) filtran
 * `deleted_at IS NULL`, así que la fila desaparece de la UI inmediato
 * pero el registro queda para auditoría histórica y reportes
 * retroactivos.
 *
 * No tocamos inventario aquí: si el lead estaba comprometiendo stock
 * vía `stock_committed=true`, ese compromiso queda colgando. Para
 * liberar inventario, el admin debe usar el flujo de cancelación
 * (`cancelLeadAction` en /admin/entregas) en lugar de delete. Este
 * action es "borrado de captura" — para leads creados por error.
 */
export async function deleteLeadAction(
  leadId: string,
): Promise<DeleteLeadState> {
  try {
    const parsed = DeleteLeadSchema.safeParse({ lead_id: leadId });
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
    if (profile?.role !== 'admin' && profile?.role !== 'admin2') {
      return {
        status: 'error',
        message: 'Solo un administrador puede eliminar leads.',
      };
    }

    const { error: updErr } = await admin
      .from('leads')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', lead_id);
    if (updErr) {
      console.error('[deleteLeadAction] soft-delete falló:', updErr);
      return {
        status: 'error',
        message: `No se pudo eliminar el lead: ${updErr.message}`,
      };
    }

    revalidatePath('/leads');
    revalidatePath('/admin/entregas');
    revalidatePath('/warehouse');
    return { status: 'success' };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al eliminar lead';
    console.error('[deleteLeadAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}
