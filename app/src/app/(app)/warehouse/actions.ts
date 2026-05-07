'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  RegisterEntrySchema,
  type RegisterEntryState,
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

    // Leer fila de inventory actual para sumar.
    const { data: invRow, error: invErr } = await admin
      .from('inventory')
      .select('id, stock_total')
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
