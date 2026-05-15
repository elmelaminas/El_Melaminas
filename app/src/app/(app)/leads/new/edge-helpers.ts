/**
 * Helpers compartidos para los colores de cubrecanto
 * (`lead_edgebanding_colors`). Vive en un módulo neutro (sin
 * `'use server'`) para poder ser reusado entre `saveLeadAction` y
 * `updateLeadFullAction` SIN exponer el helper como server action
 * (un export en un archivo 'use server' se vuelve RPC automáticamente).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { NEW_COLOR_SENTINEL, normalizeName } from './schema';

/**
 * Minimal interface del TxnLog que necesitamos — solo el método
 * `push(undo)`. Cada caller pasa su propio TxnLog que cumple esta
 * forma.
 */
export type EdgeTxnLog = {
  push: (undo: () => Promise<void>) => void;
};

/** Input que aceptamos por fila — color_id (uuid o sentinel) + opcional
 *  new_name + quantity. Mismo shape que `EdgebandingColorRowSchema`
 *  con tipos relajados (después del parse de Zod). */
export type EdgeInputRow = {
  color_id: string;
  new_name?: string;
  quantity: number;
};

export type EdgeResolveResult =
  | {
      kind: 'success';
      rows: { color_id: string; quantity: number }[];
    }
  | { kind: 'error'; message: string };

/**
 * Resuelve una lista de colores de cubrecanto (existentes + nuevos)
 * a un array `{ color_id, quantity }` listo para INSERT en
 * `lead_edgebanding_colors`.
 *
 * Para colores nuevos (`color_id === NEW_COLOR_SENTINEL`), busca
 * primero por `normalized_name` en la tabla `colors`; si no existe,
 * hace INSERT y registra un undo en el TxnLog para rollback.
 *
 * Decisión: NO comprometemos inventario para colores de cubrecanto
 * — el cubrecanto sale de un stock distinto (perfiles), no de las
 * hojas. Esta función solo crea catálogo y mapea ids. El INSERT en
 * `lead_edgebanding_colors` lo hace el caller (necesita lead_id).
 */
export async function resolveEdgebandingColors(
  admin: SupabaseClient,
  inputColors: EdgeInputRow[],
  txn: EdgeTxnLog,
): Promise<EdgeResolveResult> {
  if (inputColors.length === 0) {
    return { kind: 'success', rows: [] };
  }

  // Dedupe por color_id (existente) y normalized_name (nuevo). Suma
  // cantidades cuando hay duplicados — el UNIQUE constraint en
  // (lead_id, color_id) prohíbe filas repetidas.
  type Bucket =
    | { kind: 'existing'; color_id: string; quantity: number }
    | {
        kind: 'new';
        new_name: string;
        normalized: string;
        quantity: number;
      };
  const byKey = new Map<string, Bucket>();
  for (const row of inputColors) {
    if (row.color_id === NEW_COLOR_SENTINEL) {
      const name = (row.new_name ?? '').trim();
      const normalized = normalizeName(name);
      const key = `new:${normalized}`;
      const existing = byKey.get(key);
      if (existing && existing.kind === 'new') {
        existing.quantity += row.quantity;
      } else {
        byKey.set(key, {
          kind: 'new',
          new_name: name,
          normalized,
          quantity: row.quantity,
        });
      }
    } else {
      const key = `existing:${row.color_id}`;
      const existing = byKey.get(key);
      if (existing && existing.kind === 'existing') {
        existing.quantity += row.quantity;
      } else {
        byKey.set(key, {
          kind: 'existing',
          color_id: row.color_id,
          quantity: row.quantity,
        });
      }
    }
  }
  const buckets = Array.from(byKey.values());

  // Lookup colores "nuevos" que en realidad ya existen por
  // normalized_name → convertirlos a existentes (sin duplicar).
  const newBuckets = buckets.filter(
    (b): b is Extract<Bucket, { kind: 'new' }> => b.kind === 'new',
  );
  if (newBuckets.length > 0) {
    const normList = newBuckets.map((b) => b.normalized);
    const { data: existing, error: lookupErr } = await admin
      .from('colors')
      .select('id, normalized_name')
      .in('normalized_name', normList);
    if (lookupErr) {
      return {
        kind: 'error',
        message: `No se pudieron consultar colores: ${lookupErr.message}`,
      };
    }
    const idByNorm = new Map<string, string>();
    for (const c of existing ?? []) {
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
          };
        }
      }
    }
  }

  // INSERT los realmente nuevos (sobrevivientes del lookup).
  const trulyNew = buckets.filter(
    (b): b is Extract<Bucket, { kind: 'new' }> => b.kind === 'new',
  );
  if (trulyNew.length > 0) {
    const inserts = trulyNew.map((b) => ({
      name: b.new_name,
      normalized_name: b.normalized,
      is_active: true,
    }));
    const { data: inserted, error: colorErr } = await admin
      .from('colors')
      .insert(inserts)
      .select('id, normalized_name');
    if (colorErr || !inserted) {
      return {
        kind: 'error',
        message: `No se pudieron crear los colores nuevos: ${
          colorErr?.message ?? 'sin datos'
        }`,
      };
    }
    const newIds = inserted.map((c) => c.id);
    // Trigger de `colors` también crea `inventory` row; limpiamos
    // ambos en el rollback (coherente con saveLeadAction).
    txn.push(async () => {
      await admin.from('inventory').delete().in('color_id', newIds);
      await admin.from('colors').delete().in('id', newIds);
    });
    const idByNorm = new Map<string, string>();
    for (const c of inserted) {
      if (c.normalized_name) idByNorm.set(c.normalized_name, c.id);
    }
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      if (b.kind === 'new') {
        const id = idByNorm.get(b.normalized);
        if (!id) {
          return {
            kind: 'error',
            message: `No se pudo resolver el id del color "${b.new_name}".`,
          };
        }
        buckets[i] = {
          kind: 'existing',
          color_id: id,
          quantity: b.quantity,
        };
      }
    }
  }

  const rows = buckets
    .filter(
      (b): b is Extract<Bucket, { kind: 'existing' }> =>
        b.kind === 'existing',
    )
    .map((b) => ({ color_id: b.color_id, quantity: b.quantity }));
  return { kind: 'success', rows };
}
