'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import {
  LeadCreateSchema,
  NEW_COLOR_SENTINEL,
  CUT_RATE,
  EDGE_BANDING_RATE,
  UploadLeadDocumentsSchema,
  LEAD_DOCUMENT_MAX_BYTES,
  LEAD_DOCUMENT_MAX_FILES,
  LEAD_DOCUMENT_BUCKET,
  LEAD_DOCUMENT_EXTS,
  type LeadCreateInput,
  type LeadFormState,
  type UploadLeadDocumentsState,
  normalizeName,
  emptyToNull,
} from './schema';
import { resolveEdgebandingColors } from './edge-helpers';

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
    //
    // El lead puede incluir 1, 2 o 3 tipos: has_hojas, has_cubrecanto,
    // has_catalogo. Los campos relativos a hojas (colors, cuts,
    // edge_banding estructurado) solo cuentan si has_hojas=true;
    // si es false los descartamos antes del INSERT.
    const hasHojas = data.has_hojas === true;
    const hasCubrecantoManual = data.has_cubrecanto === true;
    const hasCatalogo = data.has_catalogo === true;

    const sheets_count = hasHojas
      ? resolvedColors.reduce((s, c) => s + c.quantity, 0)
      : 0;

    // Subtotal hojas solo si has_hojas. Sumamos pre-dedupe sobre las
    // filas que el USUARIO envió (preservar precio mostrado).
    const sheetsSubtotal = hasHojas
      ? data.colors.reduce(
          (s, c) => s + Number(c.quantity ?? 0) * Number(c.cost_per_sheet ?? 0),
          0,
        )
      : 0;

    // Para compatibilidad con consumidores del campo `leads.cost_per_sheet`
    // guardamos el costo de la PRIMERA fila (si hay) — basta como
    // representante. Si no hay hojas, queda en null.
    const legacyCostPerSheet = hasHojas
      ? data.colors[0]?.cost_per_sheet ?? 350
      : null;

    // Cortes/cubrecanto estructurado: solo cuando has_hojas. NUNCA
    // confiar en los totales del cliente — los recalculamos.
    const cutsCount =
      hasHojas &&
      data.product_type === 'con_corte' &&
      typeof data.cuts_count === 'number' &&
      data.cuts_count > 0
        ? data.cuts_count
        : null;
    const cutsTotal =
      cutsCount != null ? cutsCount * CUT_RATE : null;

    // Cubrecanto estructurado (tipo + metros): ahora vive en la
    // sección Cubrecanto, gateada por `has_cubrecanto`. Antes estaba
    // dentro de la sección Hojas; el move responde al rediseño del
    // formulario donde el cubrecanto es su propio bloque.
    const edgeType =
      hasCubrecantoManual &&
      (data.edge_banding_type === '19mm' || data.edge_banding_type === '3.5mm')
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

    // Costo adicional del cubrecanto: flat amount OPCIONAL que se
    // suma al total sin multiplicarse por cantidades. Sirve para
    // cargos extras fuera del cálculo por metros (ej. instalación
    // específica). `edgebanding_manual_cost` cambió de "precio
    // unitario × qty" a "flat amount" como parte del rediseño del
    // formulario; los leads viejos que tenían valor unitario se
    // interpretan ahora como flat sin migración (cambio mínimo de
    // semántica).
    const edgebandingAdditionalCost =
      hasCubrecantoManual &&
      typeof data.edgebanding_manual_cost === 'number' &&
      data.edgebanding_manual_cost > 0
        ? data.edgebanding_manual_cost
        : 0;

    // Catálogo: precio fijo (default $500 en el form) sumado al total.
    const catalogPrice = hasCatalogo
      ? Number(data.catalog_price ?? 500)
      : 0;

    // Envío a domicilio: aplica solo cuando purchase_type='domicilio'.
    // En 'fabrica' lo forzamos a null aunque el cliente haya mandado
    // un valor stale.
    const deliveryCost =
      data.purchase_type === 'domicilio' &&
      typeof data.delivery_cost === 'number' &&
      data.delivery_cost > 0
        ? data.delivery_cost
        : null;

    // Costos extras (flete, instalación, etc.). Lista libre que el
    // admin captura en el form. Filtramos defensivamente filas con
    // monto NaN o descripción vacía aunque Zod ya las haya rechazado.
    const extraCostsRows = (data.extra_costs ?? []).filter(
      (e) =>
        typeof e.amount === 'number' &&
        Number.isFinite(e.amount) &&
        e.description.trim().length > 0,
    );
    const extraCostsTotal = extraCostsRows.reduce(
      (s, e) => s + Number(e.amount ?? 0),
      0,
    );

    // total_amount: suma de los tipos activos + envío + extras.
    //   subtotal_hojas              = sheetsSubtotal
    //   subtotal_cortes             = cutsTotal
    //   subtotal_cubrecanto_metros  = edgeTotal (gateado por has_cubrecanto)
    //   subtotal_cubrecanto_extra   = edgebandingAdditionalCost
    //   subtotal_catalogo           = catalogPrice
    //   subtotal_envio              = deliveryCost
    //   subtotal_extras             = extraCostsTotal
    const total_amount =
      sheetsSubtotal +
      (cutsTotal ?? 0) +
      (edgeTotal ?? 0) +
      edgebandingAdditionalCost +
      catalogPrice +
      (deliveryCost ?? 0) +
      extraCostsTotal;

    const { data: leadRow, error: leadErr } = await admin
      .from('leads')
      .insert({
        client_name: data.client_name,
        // `phone` y `address` pueden ser null en DB (constraint NOT
        // NULL eliminada). Pero algunos consumidores antiguos del
        // schema asumen string — por seguridad enviamos '' cuando
        // están vacíos, no null. El schema Zod ya garantiza que
        // ambos vengan presentes (aunque sea vacíos) en pedidos
        // distintos a domicilio+hojas.
        phone: data.phone ?? '',
        address: data.address ?? '',
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
        delivery_cost: deliveryCost,
        sheets_count,
        total_amount,
        // Tipos del pedido + extras nuevos (CAMBIO 1).
        has_hojas: hasHojas,
        has_cubrecanto: hasCubrecantoManual,
        has_catalogo: hasCatalogo,
        catalog_price: hasCatalogo ? catalogPrice : 0,
        // `edgebanding_manual_cost` se persiste como FLAT AMOUNT
        // opcional: el costo adicional fuera del cálculo por metros.
        // Antes era "precio unitario × qty"; el rediseño del form lo
        // pasó a monto único.
        edgebanding_manual_cost: edgebandingAdditionalCost,
        // Cargos extras como JSONB. Persistimos las filas saneadas
        // (description trimmed, amount numérico). Si no hay extras,
        // mandamos array vacío para que el default '[]' de DB no
        // quede en NULL si la columna lo permitiera.
        extra_costs: extraCostsRows.map((e) => ({
          description: e.description.trim(),
          amount: Number(e.amount),
        })),
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

    // ── 6 + 7. INSERT lead_colors y comprometer inventario.
    //    Solo cuando el lead INCLUYE hojas (has_hojas=true). Si el
    //    pedido es solo cubrecanto/catálogo no hay materiales que
    //    asignar y saltamos los pasos 6-8 enteros.
    if (hasHojas) {
    // Persistimos `cost_per_sheet` (columna anterior) y `unit_cost`
    // (nueva columna pedida en el spec). Ambas son la fuente para
    // calcular el subtotal correcto: SUM(quantity × cost) por fila.
    // El total_amount del lead ya se calcula así arriba (PRE-dedupe).
    const lcInserts = resolvedColors.map((c) => ({
      lead_id: leadId,
      color_id: c.color_id,
      quantity: c.quantity,
      cost_per_sheet: c.cost_per_sheet,
      unit_cost: c.cost_per_sheet,
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
    } // ← fin del bloque if (hasHojas)

    // ── 8b. Colores del cubrecanto (informativo, sin compromiso de
    //    inventario). Solo cuando has_cubrecanto. Resolución de
    //    colores nuevos similar a hojas: dedupe por normalized_name,
    //    INSERT en `colors` los realmente nuevos, INSERT en
    //    `lead_edgebanding_colors`.
    if (hasCubrecantoManual && data.edgebanding_colors.length > 0) {
      const resolved = await resolveEdgebandingColors(
        admin,
        data.edgebanding_colors,
        txn,
      );
      if (resolved.kind === 'error') {
        await txn.rollback('resolución colores cubrecanto falló');
        return { status: 'error', message: resolved.message };
      }
      if (resolved.rows.length > 0) {
        const ecInserts = resolved.rows.map((c) => ({
          lead_id: leadId,
          color_id: c.color_id,
          quantity: c.quantity,
        }));
        const { error: ecErr } = await admin
          .from('lead_edgebanding_colors')
          .insert(ecInserts);
        if (ecErr) {
          // Non-fatal: si la tabla aún no existe (migración pendiente),
          // el lead ya está creado. Loguamos y seguimos.
          console.error(
            '[saveLeadAction] lead_edgebanding_colors insert falló (no fatal):',
            ecErr,
          );
        } else {
          txn.push(async () => {
            await admin
              .from('lead_edgebanding_colors')
              .delete()
              .eq('lead_id', leadId);
          });
        }
      }
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
 * `uploadLeadDocumentsAction(_prev, formData)` — sube hasta 5 archivos
 * (PDFs e imágenes mezclados) al bucket `lead-documents` y guarda las
 * URLs en `leads.document_urls` (array). También escribe la URL del
 * primer archivo en `leads.document_url` para compat con UI legacy.
 *
 * Llamado por el form DESPUÉS del `saveLeadAction` exitoso. Si la
 * subida falla, el lead ya existe (no rollback) — la UI muestra
 * warning y el admin puede reintentar desde /leads/[id]/edit.
 *
 * El cliente manda los archivos como `document_0`, `document_1`, ...
 * Iteramos hasta encontrar el primer slot vacío (no asumimos
 * contigüidad pero sí lo respetamos en la práctica).
 *
 * Auth: cualquier usuario autenticado. Sin ownership check (los leads
 * son colaborativos entre admin/seller/contador).
 *
 * Validación por archivo (cinturón + tirantes):
 *   - tamaño ≤ 10 MB
 *   - extensión en LEAD_DOCUMENT_EXTS
 *
 * Si un archivo falla la subida, abortamos: cleanup de los ya subidos
 * (best-effort) y retornamos error. El UPDATE del lead solo corre si
 * TODOS los archivos subieron OK.
 *
 * REQUIERE migración manual previa:
 *   ALTER TABLE leads ADD COLUMN IF NOT EXISTS document_urls text[] DEFAULT '{}';
 */
export async function uploadLeadDocumentsAction(
  _prev: UploadLeadDocumentsState,
  formData: FormData,
): Promise<UploadLeadDocumentsState> {
  try {
    const parsed = UploadLeadDocumentsSchema.safeParse({
      lead_id: formData.get('lead_id'),
    });
    if (!parsed.success) {
      return { status: 'error', message: 'Datos del documento inválidos.' };
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

    // Recolectar archivos: document_0, document_1, … hasta MAX_FILES.
    // Si el cliente manda más allá de MAX_FILES los ignoramos (cap).
    const files: File[] = [];
    for (let i = 0; i < LEAD_DOCUMENT_MAX_FILES; i++) {
      const slot = formData.get(`document_${i}`);
      if (slot instanceof File && slot.size > 0) {
        files.push(slot);
      }
    }
    if (files.length === 0) {
      return { status: 'error', message: 'No se recibió ningún archivo.' };
    }
    if (files.length > LEAD_DOCUMENT_MAX_FILES) {
      return {
        status: 'error',
        message: `Máximo ${LEAD_DOCUMENT_MAX_FILES} archivos por lead.`,
      };
    }

    // Validación por archivo ANTES de tocar storage — fallar barato.
    for (const f of files) {
      if (f.size > LEAD_DOCUMENT_MAX_BYTES) {
        return {
          status: 'error',
          message: `El archivo "${f.name}" excede 10 MB.`,
        };
      }
      const ext = (f.name.split('.').pop() ?? '').toLowerCase();
      if (!(LEAD_DOCUMENT_EXTS as readonly string[]).includes(ext)) {
        return {
          status: 'error',
          message: `Formato no soportado en "${f.name}". Usa PDF, JPG, PNG, WEBP o HEIC.`,
        };
      }
    }

    const admin = supabaseAdmin();

    // Verificar que el lead existe — evitar documentos huérfanos.
    // También leemos document_urls actual para fusionar (no
    // sobreescribir si el lead ya tenía archivos).
    const { data: leadRow, error: leadErr } = await admin
      .from('leads')
      .select('id, document_urls')
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

    const existingUrls: string[] = Array.isArray(leadRow.document_urls)
      ? (leadRow.document_urls as string[])
      : [];
    // Cap defensivo: si por alguna razón el lead ya tiene >= 5 docs,
    // refusamos para no exceder.
    if (existingUrls.length + files.length > LEAD_DOCUMENT_MAX_FILES) {
      return {
        status: 'error',
        message: `Este lead ya tiene ${existingUrls.length} archivo(s); no se pueden agregar ${files.length} más (máximo ${LEAD_DOCUMENT_MAX_FILES}).`,
      };
    }

    // Subir cada archivo. Si cualquiera falla, limpiamos los que ya
    // subimos y retornamos error.
    const uploadedPaths: string[] = [];
    const newUrls: string[] = [];
    const baseIdx = existingUrls.length;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const ext = (f.name.split('.').pop() ?? 'bin').toLowerCase();
      const slotIdx = baseIdx + i;
      // Ruta: {lead_id}/{slot}_{timestamp}.{ext}
      // slot evita colisiones cuando se agregan archivos en edits
      // sucesivos; timestamp evita colisiones si dos uploads paralelos
      // tocan el mismo slot.
      const path = `${lead_id}/${slotIdx}_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 6)}.${ext}`;
      const contentType =
        ext === 'pdf'
          ? 'application/pdf'
          : f.type || `image/${ext === 'jpg' ? 'jpeg' : ext}`;

      const { error: upErr } = await admin.storage
        .from(LEAD_DOCUMENT_BUCKET)
        .upload(path, f, { contentType, upsert: false });
      if (upErr) {
        // Cleanup de los que sí subimos.
        if (uploadedPaths.length > 0) {
          try {
            await admin.storage
              .from(LEAD_DOCUMENT_BUCKET)
              .remove(uploadedPaths);
          } catch (e) {
            console.error(
              '[uploadLeadDocumentsAction] cleanup parcial falló:',
              e,
            );
          }
        }
        return {
          status: 'error',
          message: `No se pudo subir "${f.name}": ${upErr.message}`,
        };
      }
      uploadedPaths.push(path);
      const { data: pub } = admin.storage
        .from(LEAD_DOCUMENT_BUCKET)
        .getPublicUrl(path);
      newUrls.push(pub.publicUrl);
    }

    // UPDATE leads.document_urls (fusión) y leads.document_url
    // (compat: primer archivo). Si el UPDATE falla, cleanup de TODOS
    // los archivos recién subidos para no dejar huérfanos.
    const mergedUrls = [...existingUrls, ...newUrls];
    const { error: updErr } = await admin
      .from('leads')
      .update({
        document_urls: mergedUrls,
        document_url: mergedUrls[0] ?? null,
      })
      .eq('id', lead_id);
    if (updErr) {
      try {
        await admin.storage
          .from(LEAD_DOCUMENT_BUCKET)
          .remove(uploadedPaths);
      } catch (e) {
        console.error(
          '[uploadLeadDocumentsAction] cleanup post-UPDATE falló:',
          e,
        );
      }
      return {
        status: 'error',
        message: `No se pudo guardar las URLs: ${updErr.message}`,
      };
    }

    revalidatePath('/leads');
    revalidatePath(`/leads/${lead_id}/edit`);
    return { status: 'success', document_urls: mergedUrls };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al subir los documentos';
    console.error(
      '[uploadLeadDocumentsAction] excepción no controlada:',
      err,
    );
    return { status: 'error', message };
  }
}

/**
 * `deleteLeadDocumentAction(lead_id, url)` — elimina un archivo del
 * array `leads.document_urls` y, best-effort, borra el blob del bucket.
 *
 * Usado por el editor de lead para que el admin pueda quitar archivos
 * individuales antes de subir otros nuevos.
 *
 * Auth: cualquier usuario autenticado (mismo patrón que upload). No
 * verificamos ownership porque los leads son colaborativos. Si en el
 * futuro hay roles más estrictos, agregar role-check acá.
 *
 * Estrategia:
 *   1. Validar lead_id y url.
 *   2. SELECT document_urls actual.
 *   3. Filtrar la URL pedida del array.
 *   4. UPDATE leads.document_urls + leads.document_url (compat: primer
 *      restante o null).
 *   5. Best-effort: borrar el blob del storage. Si falla, el row queda
 *      consistente (la URL ya no está referenciada) y el blob queda
 *      huérfano — preferimos eso a abortar la operación.
 */
export async function deleteLeadDocumentAction(
  lead_id: string,
  url: string,
): Promise<{ status: 'success' } | { status: 'error'; message: string }> {
  try {
    if (typeof lead_id !== 'string' || lead_id.length === 0) {
      return { status: 'error', message: 'lead_id inválido.' };
    }
    if (typeof url !== 'string' || url.length === 0) {
      return { status: 'error', message: 'URL inválida.' };
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

    const { data: leadRow, error: leadErr } = await admin
      .from('leads')
      .select('document_urls')
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

    const current: string[] = Array.isArray(leadRow.document_urls)
      ? (leadRow.document_urls as string[])
      : [];
    const next = current.filter((u) => u !== url);
    if (next.length === current.length) {
      // El URL no estaba en el array — tratamos como idempotente.
      return { status: 'success' };
    }

    const { error: updErr } = await admin
      .from('leads')
      .update({
        document_urls: next,
        document_url: next[0] ?? null,
      })
      .eq('id', lead_id);
    if (updErr) {
      return {
        status: 'error',
        message: `No se pudo actualizar: ${updErr.message}`,
      };
    }

    // Best-effort: derivar el path desde la URL pública y borrar el
    // blob. Public URLs de Supabase Storage tienen el formato
    //   {host}/storage/v1/object/public/{bucket}/{path}
    // Extraemos el segmento después de `/public/{bucket}/`.
    try {
      const marker = `/public/${LEAD_DOCUMENT_BUCKET}/`;
      const idx = url.indexOf(marker);
      if (idx >= 0) {
        const path = decodeURIComponent(url.slice(idx + marker.length));
        await admin.storage.from(LEAD_DOCUMENT_BUCKET).remove([path]);
      }
    } catch (e) {
      console.error(
        '[deleteLeadDocumentAction] cleanup blob falló (no fatal):',
        e,
      );
    }

    revalidatePath('/leads');
    revalidatePath(`/leads/${lead_id}/edit`);
    return { status: 'success' };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Error desconocido al eliminar el documento';
    console.error('[deleteLeadDocumentAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}

