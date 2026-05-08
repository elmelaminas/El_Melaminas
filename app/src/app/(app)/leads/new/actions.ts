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
} from './schema';

// NB: este archivo solo puede exportar async functions porque tiene
// `'use server'`. Schema, tipos y enum maps viven en `./schema`.

/**
 * Mini "transaction log" para rollback manual. Registramos undo callbacks
 * en el orden en que aplicamos los efectos; al fallar, los corremos en
 * orden INVERSO (LIFO). Cada undo es best-effort: si falla loguea y sigue
 * con los demás — preferimos limpiar lo más posible antes que abortar el
 * rollback al primer error.
 *
 * Esto NO es ACID. Si el proceso muere a mitad de un rollback (ej: timeout
 * de Vercel Function), quedan filas inconsistentes. Cuando exista RPC
 * Postgres con BEGIN/COMMIT, este código se reemplaza por una sola llamada.
 */
type Undo = () => Promise<void>;
class TxnLog {
  private stack: Undo[] = [];
  push(fn: Undo) {
    this.stack.push(fn);
  }
  async rollback(reason: string): Promise<void> {
    console.error(`[saveLeadAction] iniciando rollback: ${reason}`);
    while (this.stack.length > 0) {
      const fn = this.stack.pop()!;
      try {
        await fn();
      } catch (e) {
        console.error('[saveLeadAction] paso de rollback falló:', e);
      }
    }
  }
}

/**
 * Crea un lead completo:
 *   1. Inserta colores nuevos en `colors` + filas en `inventory` (stock 0).
 *   2. Inserta el lead en `leads` con `created_by = auth.uid()`.
 *   3. Inserta `lead_colors` (bulk).
 *   4. Por cada color: UPDATE inventory.stock_committed += qty
 *      + INSERT inventory_movements (movement_type='compromiso').
 *   5. UPDATE leads.stock_committed = true.
 *
 * Si cualquier paso falla → rollback manual de los efectos previos.
 * Política de errores: nunca dejamos escapar throw — todo se convierte en
 * `LeadFormState` con mensaje legible.
 */
export async function saveLeadAction(
  input: LeadCreateInput,
): Promise<LeadFormState> {
  const txn = new TxnLog();

  try {
    // ── 0. Validación con Zod (defensa en profundidad)
    const parsed = LeadCreateSchema.safeParse(input);
    if (!parsed.success) {
      console.error('[saveLeadAction] validación falló:', parsed.error.flatten());
      return {
        status: 'error',
        message: 'Datos inválidos',
        fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
      };
    }
    const data = parsed.data;

    // ── 1. Auth: necesitamos auth.uid() para `created_by` y `registered_by`.
    //    Usamos supabaseServer() (anon + cookies) sólo para leer la sesión;
    //    el resto de la operación va con supabaseAdmin() (service_role) para
    //    bypassear RLS uniformemente como el resto del módulo admin.
    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      console.error('[saveLeadAction] auth.getUser falló:', authErr);
      return {
        status: 'error',
        message: 'Sesión no válida. Vuelve a iniciar sesión.',
      };
    }
    const userId = user.id;

    const admin = supabaseAdmin();

    // ── 2. Dedupe de colores: el constraint UNIQUE(lead_id, color_id) en
    //    lead_colors (probable) prohíbe filas duplicadas. Agrupamos en
    //    cliente — el usuario sumó "Negra 5" y "Negra 3", insertamos una
    //    sola fila "Negra 8". Para colores nuevos, deduplicamos por
    //    normalized_name (case+accent-insensitive).
    type ColorBucket =
      | { kind: 'existing'; color_id: string; quantity: number }
      | { kind: 'new'; new_name: string; normalized: string; quantity: number };

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
          });
        }
      }
    }
    const buckets = Array.from(bucketsByKey.values());

    // ── 3. Detectar colaboraciones: si un "nuevo" tiene el mismo
    //    `normalized_name` que un color YA existente en DB, no creamos
    //    duplicado — tratamos esa fila como existente. Esto evita crear
    //    "Parota" y "parota " como dos colors separados.
    const newBuckets = buckets.filter((b): b is Extract<ColorBucket, { kind: 'new' }> => b.kind === 'new');
    if (newBuckets.length > 0) {
      const normalized_list = newBuckets.map((b) => b.normalized);
      const { data: existingByNorm, error: lookupErr } = await admin
        .from('colors')
        .select('id, name, normalized_name')
        .in('normalized_name', normalized_list);
      if (lookupErr) {
        console.error('[saveLeadAction] lookup colors falló:', lookupErr);
        return { status: 'error', message: `No se pudieron consultar colores: ${lookupErr.message}` };
      }
      const idByNorm = new Map<string, string>();
      for (const c of existingByNorm ?? []) {
        if (c.normalized_name) idByNorm.set(c.normalized_name, c.id);
      }
      // Convertimos en sitio los buckets "new" que ya existen
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        if (b.kind === 'new') {
          const id = idByNorm.get(b.normalized);
          if (id) {
            buckets[i] = { kind: 'existing', color_id: id, quantity: b.quantity };
          }
        }
      }
    }

    // ── 4. Insertar colores realmente nuevos (los que sobrevivieron al lookup)
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
        console.error('[saveLeadAction] insert colores nuevos falló:', colorErr);
        return {
          status: 'error',
          message: `No se pudieron crear los colores nuevos: ${colorErr?.message ?? 'sin datos'}`,
        };
      }
      // El trigger `on_color_created` crea la fila correspondiente en
      // `inventory` (con stocks 0) automáticamente al INSERT en colors —
      // por eso aquí NO insertamos manualmente: lo intentábamos antes y
      // chocaba con `inventory_color_id_key` (unique).
      //
      // Para el undo: si un paso posterior falla y queremos borrar estos
      // colors recién creados, el FK inventory.color_id → colors.id puede
      // tener CASCADE o no — no asumimos. Para ser robustos en ambos
      // casos, primero borramos manualmente las filas de inventory que el
      // trigger creó (no-op si ya las limpió un CASCADE), después borramos
      // los colors. Ambos DELETE son best-effort dentro del rollback
      // del TxnLog: errores se loguean y siguen.
      const newIds = insertedColors.map((c) => c.id);
      txn.push(async () => {
        await admin.from('inventory').delete().in('color_id', newIds);
        await admin.from('colors').delete().in('id', newIds);
      });

      // Resolver normalized_name → id y reemplazar buckets "new" restantes
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
          buckets[i] = { kind: 'existing', color_id: id, quantity: b.quantity };
        }
      }
    }

    // En este punto todos los buckets son { kind: 'existing', color_id, quantity }
    type ResolvedColor = { color_id: string; quantity: number };
    const resolvedColors: ResolvedColor[] = buckets.map((b) => {
      if (b.kind !== 'existing') {
        // Imposible si la lógica anterior es correcta, pero satisface al type-checker.
        throw new Error('bucket no resuelto: ' + JSON.stringify(b));
      }
      return { color_id: b.color_id, quantity: b.quantity };
    });

    // ── 5. INSERT lead
    const sheets_count = resolvedColors.reduce((s, c) => s + c.quantity, 0);

    // Recalcular cuts_total y edge_banding_total en el server (NUNCA
    // confiar en los valores que mande el cliente). Reglas:
    //   * cuts_total = cuts_count * CUT_RATE  (solo si con_corte)
    //   * edge_banding_total = meters * RATE[type]  (solo si type definido)
    const cutsCount =
      data.product_type === 'con_corte' &&
      typeof data.cuts_count === 'number' &&
      data.cuts_count > 0
        ? data.cuts_count
        : null;
    const cutsTotal =
      cutsCount != null ? cutsCount * CUT_RATE : null;

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

    // total_amount = hojas + cortes + cubrecanto. Coherente con lo que
    // muestra el resumen sticky del form para que el usuario y la DB
    // coincidan.
    const total_amount =
      sheets_count * data.cost_per_sheet +
      (cutsTotal ?? 0) +
      (edgeTotal ?? 0);

    const { data: leadRow, error: leadErr } = await admin
      .from('leads')
      .insert({
        client_name: data.client_name,
        phone: data.phone,
        address: data.address,
        maps_url: emptyToNull(data.maps_url),
        channel: data.channel,
        seller_id: emptyToNull(data.seller_id),
        sale_place: data.sale_place,
        sale_type: data.sale_type,
        sale_date: data.sale_date,
        purchase_type: data.purchase_type,
        product_type: data.product_type,
        cost_per_sheet: data.cost_per_sheet,
        // Cortes (solo si con_corte):
        cuts_count: cutsCount,
        cuts_total: cutsTotal,
        // Cubrecanto estructurado. La columna `edge_banding` (text libre)
        // se deja en NULL en nuevos leads; los viejos conservan su valor
        // para reportes históricos.
        edge_banding_type: edgeType,
        edge_banding_meters: edgeMeters,
        edge_banding_total: edgeTotal,
        sheets_count,
        total_amount,
        // driver_id se asigna aquí (antes vivía en /payments/new). Si el
        // usuario no eligió uno se queda null y el chofer puede asignarse
        // después editando el lead. /driver filtra por driver_id = uid().
        driver_id: emptyToNull(data.driver_id),
        created_by: userId,
        // delivery_status, payment_status: defaults 'pendiente'
        // stock_committed: false → lo flippeamos a true tras paso 7 si todo OK
      })
      .select('id')
      .single();
    if (leadErr || !leadRow) {
      console.error('[saveLeadAction] insert lead falló:', leadErr);
      await txn.rollback('insert lead falló');
      return {
        status: 'error',
        message: `No se pudo crear el lead: ${leadErr?.message ?? 'sin datos'}`,
      };
    }
    const leadId: string = leadRow.id;
    txn.push(async () => {
      await admin.from('leads').delete().eq('id', leadId);
    });

    // ── 6. INSERT lead_colors (bulk)
    const lcInserts = resolvedColors.map((c) => ({
      lead_id: leadId,
      color_id: c.color_id,
      quantity: c.quantity,
    }));
    const { error: lcErr } = await admin.from('lead_colors').insert(lcInserts);
    if (lcErr) {
      console.error('[saveLeadAction] insert lead_colors falló:', lcErr);
      await txn.rollback('insert lead_colors falló');
      return {
        status: 'error',
        message: `No se pudieron registrar los colores del lead: ${lcErr.message}`,
      };
    }
    txn.push(async () => {
      await admin.from('lead_colors').delete().eq('lead_id', leadId);
    });

    // ── 7. Por cada color: UPDATE inventory += qty + INSERT movement
    //    Cada paso registra su propio undo (-= qty / DELETE movement).
    for (const c of resolvedColors) {
      // Leemos el row actual para sumar atómicamente. Sin RPC esto tiene
      // riesgo de race condition con commits concurrentes — aceptamos por
      // ahora; cuando exista RPC `commit_lead_inventory` se elimina.
      const { data: invRow, error: invSelErr } = await admin
        .from('inventory')
        .select('id, stock_committed')
        .eq('color_id', c.color_id)
        .maybeSingle();
      if (invSelErr) {
        console.error('[saveLeadAction] select inventory falló:', invSelErr);
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
          message: `Falta fila de inventario para color_id=${c.color_id}.`,
        };
      }
      const previousCommitted = Number(invRow.stock_committed ?? 0);
      const newCommitted = previousCommitted + c.quantity;

      const { error: updErr } = await admin
        .from('inventory')
        .update({ stock_committed: newCommitted })
        .eq('id', invRow.id);
      if (updErr) {
        console.error('[saveLeadAction] update inventory falló:', updErr);
        await txn.rollback('update inventory falló');
        return {
          status: 'error',
          message: `No se pudo actualizar inventario: ${updErr.message}`,
        };
      }
      txn.push(async () => {
        await admin
          .from('inventory')
          .update({ stock_committed: previousCommitted })
          .eq('id', invRow.id);
      });

      const { data: mvRow, error: mvErr } = await admin
        .from('inventory_movements')
        .insert({
          color_id: c.color_id,
          movement_type: 'compromiso',
          quantity: c.quantity,
          lead_id: leadId,
          registered_by: userId,
          reference: `Lead ${leadId.slice(0, 8)}`,
        })
        .select('id')
        .single();
      if (mvErr || !mvRow) {
        console.error('[saveLeadAction] insert movement falló:', mvErr);
        await txn.rollback('insert movement falló');
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

    // ── 8. Marcar el lead como comprometido en stock. Si esto falla, no
    //    hacemos rollback — el daño es cosmético: las filas existen, los
    //    movements están, sólo el flag queda desactualizado.
    const { error: flagErr } = await admin
      .from('leads')
      .update({ stock_committed: true })
      .eq('id', leadId);
    if (flagErr) {
      console.error('[saveLeadAction] flip stock_committed falló (no fatal):', flagErr);
    }

    // ── 9. Notificaciones a admins (best-effort, no fatal).
    //    Si la tabla `notifications` no existe / RLS bloquea / cualquier
    //    otro error, lo logueamos pero el lead ya está creado y exitoso.
    try {
      const { data: admins } = await admin
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .eq('is_active', true);
      if (admins && admins.length > 0) {
        // El message expone montos en MXN. No usamos formatMXN porque es
        // del cliente; un Intl.NumberFormat directo basta y NO requiere
        // toLocaleString para bridge SSR.
        const amountFmt = new Intl.NumberFormat('es-MX', {
          style: 'currency',
          currency: 'MXN',
          minimumFractionDigits: 0,
        }).format(total_amount);
        const message = `Nuevo lead: ${data.client_name} — ${sheets_count} hojas, ${amountFmt}`;
        const inserts = admins.map((a) => ({
          recipient_id: a.id,
          type: 'nuevo_lead',
          message,
        }));
        const { error: notifErr } = await admin
          .from('notifications')
          .insert(inserts);
        if (notifErr) {
          console.error(
            '[saveLeadAction] notif insert falló (no fatal):',
            notifErr,
          );
        }
      }
    } catch (e) {
      console.error('[saveLeadAction] notif lookup/insert falló (no fatal):', e);
    }

    // ── 10. Notificación al chofer asignado (solo si hay uno).
    //    Bloque separado del de admins para que un fallo aquí no impida
    //    avisar a los admins (y viceversa). `data.driver_id` puede llegar
    //    como '' (literal vacío del schema Zod) o como undefined cuando
    //    no se eligió chofer; tratamos ambos como "sin asignar".
    if (data.driver_id && data.driver_id.length > 0) {
      try {
        const driverMessage = `Se te asignó una entrega: ${data.client_name} — ${data.address}`;
        const { error: driverNotifErr } = await admin
          .from('notifications')
          .insert({
            recipient_id: data.driver_id,
            type: 'nuevo_lead',
            message: driverMessage,
          });
        if (driverNotifErr) {
          console.error(
            '[saveLeadAction] notif al chofer falló (no fatal):',
            driverNotifErr,
          );
        }
      } catch (e) {
        console.error(
          '[saveLeadAction] notif al chofer excepción (no fatal):',
          e,
        );
      }
    }

    revalidatePath('/leads');
    revalidatePath('/admin/catalogs'); // los stocks cambiaron
    return {
      status: 'success',
      message: 'Lead creado correctamente.',
      leadId,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al crear lead';
    console.error('[saveLeadAction] excepción no controlada:', err);
    await txn.rollback('excepción no controlada');
    return { status: 'error', message };
  }
}
