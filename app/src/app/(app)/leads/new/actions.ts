'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  LeadCreateSchema,
  NEW_COLOR_SENTINEL,
  CUT_RATE,
  EDGE_BANDING_RATE,
  UploadLeadDocumentSchema,
  LEAD_DOCUMENT_MAX_BYTES,
  LEAD_DOCUMENT_BUCKET,
  type LeadCreateInput,
  type LeadFormState,
  type UploadLeadDocumentState,
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
    //
    //    `cost_per_sheet` ahora vive POR FILA. Al deduplicar:
    //      - quantity: se SUMA.
    //      - cost_per_sheet: se conserva el de la PRIMERA fila vista
    //        (el usuario que mete el mismo color dos veces con costos
    //        distintos es un caso raro; la primera ocurrencia "manda").
    //    El total_amount se calcula PRE-DEDUPE sumando qty * cost de
    //    todas las filas del input, así no perdemos precisión en el
    //    cobro si por algún motivo hubo costos mixtos.
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
          // cost_per_sheet: no se cambia (first-wins).
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
          buckets[i] = {
            kind: 'existing',
            color_id: id,
            quantity: b.quantity,
            cost_per_sheet: b.cost_per_sheet,
          };
        }
      }
    }

    // En este punto todos los buckets son { kind: 'existing', color_id, quantity, cost_per_sheet }
    type ResolvedColor = {
      color_id: string;
      quantity: number;
      cost_per_sheet: number;
    };
    const resolvedColors: ResolvedColor[] = buckets.map((b) => {
      if (b.kind !== 'existing') {
        // Imposible si la lógica anterior es correcta, pero satisface al type-checker.
        throw new Error('bucket no resuelto: ' + JSON.stringify(b));
      }
      return {
        color_id: b.color_id,
        quantity: b.quantity,
        cost_per_sheet: b.cost_per_sheet,
      };
    });

    // ── 5. INSERT lead
    const sheets_count = resolvedColors.reduce((s, c) => s + c.quantity, 0);

    // Subtotal de hojas: SUM(qty * cost_per_sheet) sobre las filas que
    // el USUARIO envió (PRE-dedupe). Si por algún motivo el dedupe
    // colapsa filas con costos distintos, el cobro al cliente sigue
    // siendo el exacto que vio en pantalla.
    const sheetsSubtotal = data.colors.reduce(
      (s, c) => s + Number(c.quantity ?? 0) * Number(c.cost_per_sheet ?? 0),
      0,
    );

    // Para compatibilidad con consumidores del campo `leads.cost_per_sheet`
    // (reportes, /payments, /admin/entregas vista resumida), guardamos
    // ahí el costo de la PRIMERA fila — basta como representante.
    const legacyCostPerSheet =
      data.colors[0]?.cost_per_sheet ?? 350;

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

    // total_amount = subtotal hojas (qty*cost por fila) + cortes +
    // cubrecanto. Coherente con lo que muestra el resumen sticky del
    // form para que el usuario y la DB coincidan.
    const total_amount =
      sheetsSubtotal + (cutsTotal ?? 0) + (edgeTotal ?? 0);

    const { data: leadRow, error: leadErr } = await admin
      .from('leads')
      .insert({
        client_name: data.client_name,
        phone: data.phone,
        // address es opcional cuando purchase_type='fabrica'; convertimos
        // '' a null para que la columna no quede con string vacío.
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

    // ── 6. INSERT lead_colors (bulk) — incluye cost_per_sheet por fila.
    //    Requiere migración manual:
    //      ALTER TABLE lead_colors ADD COLUMN IF NOT EXISTS cost_per_sheet integer;
    //    Si la columna no existe todavía, el INSERT falla con un error
    //    "column does not exist" — lo visible para el usuario es el
    //    mensaje del rollback. Que Sergio corra el SQL antes del deploy.
    const lcInserts = resolvedColors.map((c) => ({
      lead_id: leadId,
      color_id: c.color_id,
      quantity: c.quantity,
      cost_per_sheet: c.cost_per_sheet,
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

/**
 * `uploadLeadDocumentAction(_prev, formData)` — sube un PDF al bucket
 * `lead-documents` y guarda la URL pública en `leads.document_url`.
 *
 * Llamado por el formulario DESPUÉS del `saveLeadAction` exitoso. Si
 * la subida falla, el lead ya existe (no se rolledback) — el usuario
 * ve un warning en la UI y puede reintentar el upload luego desde la
 * página del lead.
 *
 * Auth: cualquier usuario autenticado puede subir un PDF a un lead.
 * El `lead_id` se valida que exista (pero no que sea propiedad del
 * caller — los leads no tienen ownership formal, son colaborativos
 * entre admin/seller/contador). Si en el futuro quieres restringir
 * por created_by, agrega la verificación acá.
 *
 * Solo se aceptan PDFs (validación de extensión + content-type).
 * Tamaño máximo 10 MB (definido en schema.ts).
 */
export async function uploadLeadDocumentAction(
  _prev: UploadLeadDocumentState,
  formData: FormData,
): Promise<UploadLeadDocumentState> {
  try {
    const parsed = UploadLeadDocumentSchema.safeParse({
      lead_id: formData.get('lead_id'),
      kind: formData.get('kind'),
    });
    if (!parsed.success) {
      return { status: 'error', message: 'Datos del documento inválidos.' };
    }
    const { lead_id, kind } = parsed.data;

    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      return { status: 'error', message: 'Sesión no válida.' };
    }

    const file = formData.get('document');
    const labelDoc = kind === 'pdf' ? 'PDF' : 'foto';
    if (!(file instanceof File) || file.size === 0) {
      return {
        status: 'error',
        message: `No se recibió ${kind === 'pdf' ? 'el PDF' : 'la foto'}.`,
      };
    }
    if (file.size > LEAD_DOCUMENT_MAX_BYTES) {
      return {
        status: 'error',
        message: `${labelDoc === 'PDF' ? 'El PDF' : 'La foto'} excede 10 MB. Comprime o reduce el archivo.`,
      };
    }

    // Validación cinturón+tirantes: extensión Y/o mime según kind.
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    if (kind === 'pdf') {
      if (ext !== 'pdf') {
        return {
          status: 'error',
          message: 'Solo se aceptan archivos PDF (.pdf).',
        };
      }
    } else {
      // Foto: validar por mime (image/*) — la extensión puede ser
      // jpg/jpeg/png/heic/webp; cualquier image/* mime es válido.
      const mime = (file.type ?? '').toLowerCase();
      if (!mime.startsWith('image/')) {
        return {
          status: 'error',
          message: 'Solo se aceptan imágenes (JPG, PNG, etc.).',
        };
      }
    }

    const admin = supabaseAdmin();

    // Verificar que el lead existe — evitar documentos huérfanos
    // referenciando leads inexistentes/borrados.
    const { data: leadRow, error: leadErr } = await admin
      .from('leads')
      .select('id, document_url')
      .eq('id', lead_id)
      .maybeSingle();
    if (leadErr) {
      return {
        status: 'error',
        message: `No se pudo verificar el lead: ${leadErr.message}`,
      };
    }
    if (!leadRow) {
      return { status: 'error', message: 'Lead no encontrado.' };
    }

    // Path según kind:
    //   PDF   → {lead_id}/doc_{timestamp}.pdf
    //   Foto  → {lead_id}/photo_{timestamp}.jpg
    // (La extensión .jpg para fotos se mantiene fija como convención,
    // independientemente del mime real — el contentType correcto se
    // pasa al upload para que el browser lo sirva bien.)
    const timestamp = Date.now();
    const path =
      kind === 'pdf'
        ? `${lead_id}/doc_${timestamp}.pdf`
        : `${lead_id}/photo_${timestamp}.jpg`;
    const contentType =
      kind === 'pdf' ? 'application/pdf' : file.type || 'image/jpeg';

    const { error: upErr } = await admin.storage
      .from(LEAD_DOCUMENT_BUCKET)
      .upload(path, file, {
        contentType,
        upsert: false,
      });
    if (upErr) {
      return {
        status: 'error',
        message: `No se pudo subir ${kind === 'pdf' ? 'el PDF' : 'la foto'}: ${upErr.message}`,
      };
    }
    const { data: pub } = admin.storage
      .from(LEAD_DOCUMENT_BUCKET)
      .getPublicUrl(path);
    const documentUrl = pub.publicUrl;

    // UPDATE leads.document_url. Si el lead ya tenía un documento
    // adjunto, lo sobreescribimos (no borramos el anterior — queda
    // huérfano en storage). Si en el futuro quieres limpiar, agrega
    // un DELETE del path anterior antes del UPDATE.
    const { error: updErr } = await admin
      .from('leads')
      .update({ document_url: documentUrl })
      .eq('id', lead_id);
    if (updErr) {
      // Cleanup del archivo recién subido — si el UPDATE falla no
      // queremos huérfanos en storage.
      try {
        await admin.storage.from(LEAD_DOCUMENT_BUCKET).remove([path]);
      } catch (e) {
        console.error(
          '[uploadLeadDocumentAction] cleanup documento huérfano falló:',
          e,
        );
      }
      return {
        status: 'error',
        message: `No se pudo guardar la URL del documento: ${updErr.message}`,
      };
    }

    revalidatePath('/leads');
    revalidatePath(`/leads/${lead_id}/edit`);
    return { status: 'success', document_url: documentUrl };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al subir el documento';
    console.error(
      '[uploadLeadDocumentAction] excepción no controlada:',
      err,
    );
    return { status: 'error', message };
  }
}
