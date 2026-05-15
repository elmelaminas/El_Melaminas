'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  LeadCreateSchema,
  NEW_COLOR_SENTINEL,
  CUT_RATE,
  EDGE_BANDING_RATE,
  type LeadCreateInput,
  type LeadFormState,
  normalizeName,
  emptyToNull,
} from '../../new/schema';

/**
 * `updateLeadFullAction(leadId, input)` — admin edita TODOS los campos
 * del lead (los mismos que se capturan en /leads/new).
 *
 * Estrategia para los colores: liberar todo el commitment anterior,
 * borrar `lead_colors`, insertar los nuevos, recomprometer. Más simple
 * y robusto que calcular deltas por color — la cantidad de filas
 * involucradas es pequeña (típicamente 1-4) y un usuario que edita
 * espera un comportamiento "como si volviera a capturar".
 *
 * Reglas operativas:
 *   - delivery_status='entregado' o 'cancelado' o deleted_at != NULL
 *     → RECHAZA edición (no podemos cambiar lo que ya pasó / ya cerró).
 *   - stock_committed=true (caso normal antes de entregar):
 *     liberamos viejos, recomprometemos nuevos, INSERTs de
 *     liberacion + compromiso con reference='Edición de lead'.
 *   - stock_committed=false (post-devolución de entrega fallida):
 *     solo reemplazamos lead_colors SIN tocar inventory ni
 *     movements — el material está físicamente devuelto al stock,
 *     el lead solo guarda la intención.
 *
 * TxnLog manual con rollback LIFO (mismo patrón que saveLeadAction).
 * Triple defensa de admin (middleware + page + action).
 */
type Undo = () => Promise<void>;
class TxnLog {
  private stack: Undo[] = [];
  push(fn: Undo) {
    this.stack.push(fn);
  }
  async rollback(reason: string): Promise<void> {
    console.error(`[updateLeadFullAction] rollback: ${reason}`);
    while (this.stack.length > 0) {
      const fn = this.stack.pop()!;
      try {
        await fn();
      } catch (e) {
        console.error('[updateLeadFullAction] paso de rollback falló:', e);
      }
    }
  }
}

export async function updateLeadFullAction(
  leadId: string,
  input: LeadCreateInput,
): Promise<LeadFormState> {
  const txn = new TxnLog();

  try {
    if (typeof leadId !== 'string' || leadId.length === 0) {
      return { status: 'error', message: 'ID de lead inválido.' };
    }

    // ── 0. Validación con Zod (defensa en profundidad)
    const parsed = LeadCreateSchema.safeParse(input);
    if (!parsed.success) {
      console.error(
        '[updateLeadFullAction] validación falló:',
        parsed.error.flatten(),
      );
      return {
        status: 'error',
        message: 'Datos inválidos',
        fieldErrors: parsed.error.flatten().fieldErrors as Record<
          string,
          string[]
        >,
      };
    }
    const data = parsed.data;

    // ── 1. Auth + role admin (defensa en profundidad).
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
    if (callerProfile?.role !== 'admin' && callerProfile?.role !== 'admin2') {
      return {
        status: 'error',
        message: 'Solo un administrador puede editar leads.',
      };
    }

    // ── 2. Verificar estado del lead actual.
    const { data: leadRow, error: leadErr } = await admin
      .from('leads')
      .select(
        'id, stock_committed, delivery_status, deleted_at',
      )
      .eq('id', leadId)
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
    if (leadRow.delivery_status === 'entregado') {
      return {
        status: 'error',
        message:
          'No se puede editar un lead ya entregado. Si necesitas registrar un ajuste, crea uno nuevo.',
      };
    }
    if (leadRow.delivery_status === 'cancelado') {
      return {
        status: 'error',
        message: 'No se puede editar un lead cancelado.',
      };
    }
    const stockWasCommitted = leadRow.stock_committed === true;

    // ── 3. Dedupe + resolución de colores nuevos (MISMO patrón que
    //    saveLeadAction). Agrupa duplicados (sumando quantity, first-wins
    //    en cost_per_sheet), busca colores existentes por
    //    normalized_name, crea los realmente nuevos.
    type ColorBucket =
      | {
          kind: 'existing';
          color_id: string;
          quantity: number;
          cost_per_sheet: number;
        }
      | {
          kind: 'new';
          new_name: string;
          normalized: string;
          quantity: number;
          cost_per_sheet: number;
        };

    const bucketsByKey = new Map<string, ColorBucket>();
    for (const row of data.colors) {
      if (row.color_id === NEW_COLOR_SENTINEL) {
        const name = (row.new_name ?? '').trim();
        const normalized = normalizeName(name);
        const key = `new:${normalized}`;
        const existing = bucketsByKey.get(key);
        if (existing && existing.kind === 'new') {
          existing.quantity += row.quantity;
        } else {
          bucketsByKey.set(key, {
            kind: 'new',
            new_name: name,
            normalized,
            quantity: row.quantity,
            cost_per_sheet: row.cost_per_sheet,
          });
        }
      } else {
        const key = `existing:${row.color_id}`;
        const existing = bucketsByKey.get(key);
        if (existing && existing.kind === 'existing') {
          existing.quantity += row.quantity;
        } else {
          bucketsByKey.set(key, {
            kind: 'existing',
            color_id: row.color_id,
            quantity: row.quantity,
            cost_per_sheet: row.cost_per_sheet,
          });
        }
      }
    }
    const buckets = Array.from(bucketsByKey.values());

    // Detectar colores "nuevos" que en realidad ya existen por
    // normalized_name → convertirlos a existing.
    const newBuckets = buckets.filter(
      (b): b is Extract<ColorBucket, { kind: 'new' }> => b.kind === 'new',
    );
    if (newBuckets.length > 0) {
      const normalizedList = newBuckets.map((b) => b.normalized);
      const { data: existingByNorm, error: lookupErr } = await admin
        .from('colors')
        .select('id, name, normalized_name')
        .in('normalized_name', normalizedList);
      if (lookupErr) {
        return {
          status: 'error',
          message: `No se pudieron consultar colores: ${lookupErr.message}`,
        };
      }
      const idByNorm = new Map<string, string>();
      for (const c of existingByNorm ?? []) {
        if (c.normalized_name) idByNorm.set(c.normalized_name, c.id);
      }
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        if (b.kind === 'new') {
          const id = idByNorm.get(b.normalized);
          if (id) {
            buckets[i] = {
              kind: 'existing',
              color_id: id,
              quantity: b.quantity,
              cost_per_sheet: b.cost_per_sheet,
            };
          }
        }
      }
    }

    // Insertar los realmente nuevos.
    const trulyNew = buckets.filter(
      (b): b is Extract<ColorBucket, { kind: 'new' }> => b.kind === 'new',
    );
    if (trulyNew.length > 0) {
      const inserts = trulyNew.map((b) => ({
        name: b.new_name,
        normalized_name: b.normalized,
        is_active: true,
      }));
      const { data: insertedColors, error: colorErr } = await admin
        .from('colors')
        .insert(inserts)
        .select('id, normalized_name');
      if (colorErr || !insertedColors) {
        return {
          status: 'error',
          message: `No se pudieron crear los colores nuevos: ${
            colorErr?.message ?? 'sin datos'
          }`,
        };
      }
      const newIds = insertedColors.map((c) => c.id);
      txn.push(async () => {
        await admin.from('inventory').delete().in('color_id', newIds);
        await admin.from('colors').delete().in('id', newIds);
      });

      const idByNorm = new Map<string, string>();
      for (const c of insertedColors) {
        if (c.normalized_name) idByNorm.set(c.normalized_name, c.id);
      }
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        if (b.kind === 'new') {
          const id = idByNorm.get(b.normalized);
          if (!id) {
            await txn.rollback('color nuevo no resolvió a id post-insert');
            return {
              status: 'error',
              message: `No se pudo resolver el id del color nuevo "${b.new_name}".`,
            };
          }
          buckets[i] = {
            kind: 'existing',
            color_id: id,
            quantity: b.quantity,
            cost_per_sheet: b.cost_per_sheet,
          };
        }
      }
    }

    type ResolvedColor = {
      color_id: string;
      quantity: number;
      cost_per_sheet: number;
    };
    const resolvedColors: ResolvedColor[] = buckets.map((b) => {
      if (b.kind !== 'existing') {
        throw new Error('bucket no resuelto: ' + JSON.stringify(b));
      }
      return {
        color_id: b.color_id,
        quantity: b.quantity,
        cost_per_sheet: b.cost_per_sheet,
      };
    });

    // ── 4. Leer lead_colors actuales (los viejos). Incluimos
    //    cost_per_sheet para que el snapshot de rollback restaure los
    //    valores exactos previos. Si la columna no existe en DB (pre
    //    migración), Supabase devuelve null en cost_per_sheet — tratado
    //    como undefined en el snapshot.
    const { data: oldLcRows, error: oldLcErr } = await admin
      .from('lead_colors')
      .select('color_id, quantity, cost_per_sheet')
      .eq('lead_id', leadId);
    if (oldLcErr) {
      return {
        status: 'error',
        message: `No se pudieron leer los colores actuales: ${oldLcErr.message}`,
      };
    }
    type OldLcRow = {
      color_id: string;
      quantity: number;
      cost_per_sheet: number | null;
    };
    const oldColors: OldLcRow[] = (oldLcRows ?? [])
      .filter(
        (r): r is OldLcRow =>
          !!r.color_id && Number(r.quantity ?? 0) > 0,
      );

    // ── 5. Si el stock está comprometido, LIBERAR los viejos primero.
    if (stockWasCommitted) {
      for (const oc of oldColors) {
        const { data: invRow, error: invSelErr } = await admin
          .from('inventory')
          .select('id, stock_committed')
          .eq('color_id', oc.color_id)
          .maybeSingle();
        if (invSelErr) {
          await txn.rollback('select inventory (liberar viejo) falló');
          return {
            status: 'error',
            message: `No se pudo leer inventario: ${invSelErr.message}`,
          };
        }
        if (!invRow) {
          // Best-effort: si falta la fila de inventory (improbable),
          // logueamos y seguimos — no podemos liberar lo que no existe.
          console.warn(
            `[updateLeadFullAction] sin inventory para color ${oc.color_id} (liberar viejo); skip`,
          );
          continue;
        }
        const prevCommitted = Number(invRow.stock_committed ?? 0);
        const qty = Number(oc.quantity);
        // Piso a 0 por inconsistencias históricas.
        const nextCommitted = Math.max(0, prevCommitted - qty);

        const { error: updErr } = await admin
          .from('inventory')
          .update({ stock_committed: nextCommitted })
          .eq('id', invRow.id);
        if (updErr) {
          await txn.rollback('update inventory (liberar viejo) falló');
          return {
            status: 'error',
            message: `No se pudo liberar inventario: ${updErr.message}`,
          };
        }
        txn.push(async () => {
          await admin
            .from('inventory')
            .update({ stock_committed: prevCommitted })
            .eq('id', invRow.id);
        });

        const { data: mvRow, error: mvErr } = await admin
          .from('inventory_movements')
          .insert({
            color_id: oc.color_id,
            movement_type: 'liberacion',
            quantity: qty,
            lead_id: leadId,
            registered_by: userId,
            reference: 'Edición de lead',
          })
          .select('id')
          .single();
        if (mvErr || !mvRow) {
          await txn.rollback('insert movement liberacion falló');
          return {
            status: 'error',
            message: `No se pudo registrar movimiento: ${
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
    }

    // ── 6. DELETE lead_colors viejos. Snapshot para rollback.
    const oldLcSnapshot = oldColors.map((o) => ({
      lead_id: leadId,
      color_id: o.color_id,
      quantity: o.quantity,
      cost_per_sheet: o.cost_per_sheet,
    }));
    const { error: delErr } = await admin
      .from('lead_colors')
      .delete()
      .eq('lead_id', leadId);
    if (delErr) {
      await txn.rollback('delete lead_colors falló');
      return {
        status: 'error',
        message: `No se pudieron borrar los colores anteriores: ${delErr.message}`,
      };
    }
    txn.push(async () => {
      if (oldLcSnapshot.length > 0) {
        await admin.from('lead_colors').insert(oldLcSnapshot);
      }
    });

    // ── 7. INSERT nuevos lead_colors (incluye cost_per_sheet por fila).
    const lcInserts = resolvedColors.map((c) => ({
      lead_id: leadId,
      color_id: c.color_id,
      quantity: c.quantity,
      cost_per_sheet: c.cost_per_sheet,
    }));
    const { error: lcInsErr } = await admin
      .from('lead_colors')
      .insert(lcInserts);
    if (lcInsErr) {
      await txn.rollback('insert lead_colors nuevos falló');
      return {
        status: 'error',
        message: `No se pudieron registrar los colores nuevos: ${lcInsErr.message}`,
      };
    }
    txn.push(async () => {
      await admin.from('lead_colors').delete().eq('lead_id', leadId);
    });

    // ── 8. Si el stock estaba comprometido, COMPROMETER los nuevos.
    if (stockWasCommitted) {
      for (const c of resolvedColors) {
        const { data: invRow, error: invSelErr } = await admin
          .from('inventory')
          .select('id, stock_committed')
          .eq('color_id', c.color_id)
          .maybeSingle();
        if (invSelErr) {
          await txn.rollback('select inventory (comprometer nuevo) falló');
          return {
            status: 'error',
            message: `No se pudo leer inventario: ${invSelErr.message}`,
          };
        }
        if (!invRow) {
          await txn.rollback('falta fila de inventario (comprometer nuevo)');
          return {
            status: 'error',
            message: `Falta fila de inventario para color_id=${c.color_id}.`,
          };
        }
        const prevCommitted = Number(invRow.stock_committed ?? 0);
        const qty = Number(c.quantity);
        const nextCommitted = prevCommitted + qty;

        const { error: updErr } = await admin
          .from('inventory')
          .update({ stock_committed: nextCommitted })
          .eq('id', invRow.id);
        if (updErr) {
          await txn.rollback('update inventory (comprometer nuevo) falló');
          return {
            status: 'error',
            message: `No se pudo comprometer inventario: ${updErr.message}`,
          };
        }
        txn.push(async () => {
          await admin
            .from('inventory')
            .update({ stock_committed: prevCommitted })
            .eq('id', invRow.id);
        });

        const { data: mvRow, error: mvErr } = await admin
          .from('inventory_movements')
          .insert({
            color_id: c.color_id,
            movement_type: 'compromiso',
            quantity: qty,
            lead_id: leadId,
            registered_by: userId,
            reference: 'Edición de lead',
          })
          .select('id')
          .single();
        if (mvErr || !mvRow) {
          await txn.rollback('insert movement compromiso falló');
          return {
            status: 'error',
            message: `No se pudo registrar movimiento: ${
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
    }

    // ── 9. Recalcular totales y UPDATE lead.
    const sheets_count = resolvedColors.reduce(
      (s, c) => s + c.quantity,
      0,
    );

    // Subtotal hojas: SUM(qty * cost) sobre las filas que el USUARIO
    // envió (PRE-dedupe) — preserva el costo exacto si hubo costos
    // mixtos en filas duplicadas.
    const sheetsSubtotal = data.colors.reduce(
      (s, c) => s + Number(c.quantity ?? 0) * Number(c.cost_per_sheet ?? 0),
      0,
    );

    // Compat: `leads.cost_per_sheet` se mantiene como representante (el
    // costo de la primera fila). El desglose real está en
    // `lead_colors.cost_per_sheet`.
    const legacyCostPerSheet = data.colors[0]?.cost_per_sheet ?? 350;

    const cutsCount =
      data.product_type === 'con_corte' &&
      typeof data.cuts_count === 'number' &&
      data.cuts_count > 0
        ? data.cuts_count
        : null;
    const cutsTotal = cutsCount != null ? cutsCount * CUT_RATE : null;

    const edgeType =
      data.edge_banding_type === '19mm' || data.edge_banding_type === '3.5mm'
        ? data.edge_banding_type
        : null;
    const edgeMeters =
      edgeType !== null &&
      typeof data.edge_banding_meters === 'number' &&
      data.edge_banding_meters > 0
        ? data.edge_banding_meters
        : null;
    const edgeTotal =
      edgeType !== null && edgeMeters != null
        ? edgeMeters * EDGE_BANDING_RATE[edgeType]
        : null;

    // Envío a domicilio: aplica solo en domicilio; en fábrica null.
    const deliveryCost =
      data.purchase_type === 'domicilio' &&
      typeof data.delivery_cost === 'number' &&
      data.delivery_cost > 0
        ? data.delivery_cost
        : null;

    const total_amount =
      sheetsSubtotal + (cutsTotal ?? 0) + (edgeTotal ?? 0) + (deliveryCost ?? 0);

    const { error: leadUpdErr } = await admin
      .from('leads')
      .update({
        client_name: data.client_name,
        phone: data.phone,
        // address es opcional cuando purchase_type='fabrica' (vacío → null).
        address: emptyToNull(data.address),
        maps_url: emptyToNull(data.maps_url),
        channel: data.channel,
        seller_id: emptyToNull(data.seller_id),
        sale_place: data.sale_place,
        sale_type: data.sale_type,
        sale_date: data.sale_date,
        purchase_type: data.purchase_type,
        product_type: data.product_type,
        cost_per_sheet: legacyCostPerSheet,
        cuts_count: cutsCount,
        cuts_total: cutsTotal,
        edge_banding_type: edgeType,
        edge_banding_meters: edgeMeters,
        edge_banding_total: edgeTotal,
        delivery_cost: deliveryCost,
        sheets_count,
        total_amount,
        driver_id: emptyToNull(data.driver_id),
      })
      .eq('id', leadId);
    if (leadUpdErr) {
      await txn.rollback('update lead falló');
      return {
        status: 'error',
        message: `No se pudo actualizar el lead: ${leadUpdErr.message}`,
      };
    }

    revalidatePath('/leads');
    revalidatePath('/admin/entregas');
    revalidatePath('/warehouse');
    revalidatePath('/warehouse/movements');

    return {
      status: 'success',
      message: 'Lead actualizado correctamente.',
      leadId,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al actualizar lead';
    console.error('[updateLeadFullAction] excepción no controlada:', err);
    await txn.rollback('excepción no controlada');
    return { status: 'error', message };
  }
}
