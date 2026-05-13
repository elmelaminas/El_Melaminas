/**
 * Schema y tipos para /admin/entregas. El SELECT principal de leads no
 * usa Zod (es server-side input vía searchParams, validado con
 * whitelists en page.tsx).
 *
 * Vive separado de actions.ts ('use server' module) — patrón estándar
 * del proyecto para evitar el RSC stub bug que se manifiesta cuando
 * un módulo 'use server' exporta otra cosa que no sea una async function.
 */

import { z } from 'zod';

export const ResolveIssueSchema = z.object({
  issue_id: z.string().uuid('issue_id inválido'),
});

export type ResolveIssueState =
  | { status: 'idle' }
  | { status: 'success' }
  | { status: 'error'; message: string };

export const initialResolveIssueState: ResolveIssueState = { status: 'idle' };

// ─── Asignación de ruta del día (Grupo 1) ────────────────────────────

/**
 * Una asignación individual: un lead recibe un `delivery_order` (1..N)
 * para la fecha seleccionada. `order=0` se interpreta como "quitar de la
 * ruta de ese día" (limpia delivery_order y delivery_date).
 */
export const AssignRouteEntrySchema = z.object({
  lead_id: z.string().uuid('lead_id inválido'),
  delivery_order: z
    .number({ invalid_type_error: 'Orden inválido' })
    .int('Orden debe ser entero')
    .min(0, 'Orden debe ser ≥ 0')
    .max(999, 'Orden demasiado grande'),
});

export const AssignRouteSchema = z.object({
  delivery_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (YYYY-MM-DD)'),
  /** JSON array serializado en el FormData con la lista completa de
   *  asignaciones de ESA fecha. Lo enviamos completo (no incremental)
   *  para que el action pueda calcular fácilmente las diferencias y
   *  notificar a los choferes correctos. */
  assignments: z
    .array(AssignRouteEntrySchema)
    .min(1, 'Selecciona al menos una entrega para la ruta'),
});

export type AssignRouteState =
  | { status: 'idle' }
  | { status: 'success'; message: string; count: number }
  | { status: 'error'; message: string };

export const initialAssignRouteState: AssignRouteState = { status: 'idle' };

// ─── Devolución de stock por entrega fallida ─────────────────────────

/**
 * El admin marca "Devolver al stock" sobre una entrega fallida. El
 * action lee los `lead_colors` y, por cada color: aumenta `stock_total`
 * y disminuye `stock_committed` de `inventory`, inserta movimiento
 * `entrada` con referencia "Devolución — entrega fallida", y al final
 * marca el lead con `stock_returned=true` + libera `stock_committed`
 * + reset de `delivery_status='pendiente'` para que pueda
 * reagendarse.
 */
export const ReturnStockSchema = z.object({
  lead_id: z.string().uuid('lead_id inválido'),
});

export type ReturnStockState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

export const initialReturnStockState: ReturnStockState = { status: 'idle' };
