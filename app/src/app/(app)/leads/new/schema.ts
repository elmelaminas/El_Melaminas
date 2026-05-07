/**
 * Zod schemas, tipos y mapas de enums para /leads/new.
 *
 * Vive separado de actions.ts porque ese archivo tiene 'use server' y solo
 * puede exportar async functions. Ver app/(app)/admin/users/schema.ts y
 * app/(app)/admin/catalogs/schema.ts para el contexto completo.
 *
 * Los enums de Postgres son lowercase/snake_case (`whatsapp`, `primer_contacto`,
 * `con_corte`); los labels visibles son en español Title Case. Mantenemos
 * ambos en arrays `_OPTIONS` para que la UI los muestre y el server los valide.
 */

import { z } from 'zod';

// ─── Enums DB ↔ UI ──────────────────────────────────────────────────────
//
// Patrón: `*_VALUES` es la tupla literal (la pasamos a `z.enum`) y
// `*_OPTIONS` es el array para renderizar `<select>`. Definimos VALUES
// primero con `as const` para conservar la tupla; OPTIONS deriva su tipo
// de VALUES, así un valor inválido en OPTIONS se cacha en compile time.

export const CHANNEL_VALUES = ['whatsapp', 'tiktok', 'google', 'tienda'] as const;
export const CHANNEL_OPTIONS: { value: (typeof CHANNEL_VALUES)[number]; label: string }[] = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'google', label: 'Google' },
  { value: 'tienda', label: 'Tienda' },
];

export const SALE_TYPE_VALUES = [
  'primer_contacto', 'recompra', 'seguimiento', 'venta_empleado',
] as const;
export const SALE_TYPE_OPTIONS: { value: (typeof SALE_TYPE_VALUES)[number]; label: string }[] = [
  { value: 'primer_contacto', label: 'Primer contacto' },
  { value: 'recompra', label: 'Recompra' },
  { value: 'seguimiento', label: 'Seguimiento' },
  { value: 'venta_empleado', label: 'Venta empleado' },
];

// OJO: `sale_place` y `purchase_type` ambos tienen una opción que se LEE
// "en fábrica" pero son enums DISTINTOS de Postgres. No mezclar.
export const SALE_PLACE_VALUES = ['online', 'en_fabrica'] as const;
export const SALE_PLACE_OPTIONS: { value: (typeof SALE_PLACE_VALUES)[number]; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'en_fabrica', label: 'En fábrica' },
];

export const PURCHASE_TYPE_VALUES = ['domicilio', 'fabrica'] as const;
export const PURCHASE_TYPE_OPTIONS: { value: (typeof PURCHASE_TYPE_VALUES)[number]; label: string }[] = [
  { value: 'domicilio', label: 'A domicilio' },
  { value: 'fabrica', label: 'En fábrica' },
];

export const PRODUCT_TYPE_VALUES = ['con_corte', 'sin_corte'] as const;
export const PRODUCT_TYPE_OPTIONS: { value: (typeof PRODUCT_TYPE_VALUES)[number]; label: string }[] = [
  { value: 'con_corte', label: 'Con corte' },
  { value: 'sin_corte', label: 'Sin corte' },
];

// ─── Color rows (UI) ────────────────────────────────────────────────────

/**
 * Sentinel value en el dropdown de color. Si el usuario lo selecciona,
 * la UI revela un input para escribir el nombre del color nuevo. El server
 * acción maneja la creación implícita en `colors` + `inventory`.
 */
export const NEW_COLOR_SENTINEL = '__new__';

/**
 * Una fila del editor de colores en la UI. RHF maneja un array de estos
 * con useFieldArray. Validamos con `.refine(...)` que `new_name` esté
 * presente cuando `color_id === NEW_COLOR_SENTINEL`.
 */
export const ColorRowSchema = z
  .object({
    color_id: z.string().min(1, 'Selecciona un color'),
    new_name: z.string().trim().max(60, 'Nombre demasiado largo').optional(),
    quantity: z
      .number({ invalid_type_error: 'Cantidad debe ser un número' })
      .int('Cantidad debe ser entero')
      .positive('Cantidad debe ser ≥ 1'),
  })
  .refine(
    (v) => {
      if (v.color_id === NEW_COLOR_SENTINEL) {
        return typeof v.new_name === 'string' && v.new_name.trim().length >= 2;
      }
      return true;
    },
    { message: 'Ingresa el nombre del color nuevo (mín. 2 caracteres)', path: ['new_name'] },
  );

export type ColorRowInput = z.infer<typeof ColorRowSchema>;

// ─── Lead create ────────────────────────────────────────────────────────

export const LeadCreateSchema = z.object({
  // Origen
  channel: z.enum(CHANNEL_VALUES, { message: 'Canal inválido' }),
  seller_id: z
    .string()
    .uuid('Selecciona un vendedor')
    .optional()
    .or(z.literal('')),
  // Chofer asignado a la entrega. Antes vivía en /payments/new pero
  // semánticamente pertenece al lead — el chofer se decide al crear el
  // pedido, no al cobrar (un mismo lead puede tener varios pagos pero
  // un solo chofer). El driver del lead es lo que filtra /driver y lo
  // que ve la entrega.
  driver_id: z
    .string()
    .uuid('Chofer inválido')
    .optional()
    .or(z.literal('')),
  sale_type: z.enum(SALE_TYPE_VALUES, { message: 'Tipo de venta inválido' }),
  sale_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (formato YYYY-MM-DD)'),

  // Cliente
  client_name: z
    .string()
    .trim()
    .min(2, 'Nombre del cliente requerido')
    .max(120, 'Nombre demasiado largo'),
  phone: z
    .string()
    .trim()
    .min(7, 'Teléfono debe tener al menos 7 dígitos')
    .max(20, 'Teléfono demasiado largo'),
  address: z
    .string()
    .trim()
    .min(3, 'Dirección requerida')
    .max(500, 'Dirección demasiado larga'),
  maps_url: z
    .string()
    .trim()
    .max(500)
    .optional()
    .or(z.literal('')),

  // Pedido
  cost_per_sheet: z
    .number({ invalid_type_error: 'Costo por hoja inválido' })
    .int('Costo debe ser entero')
    .positive('Costo debe ser > 0'),
  edge_banding: z
    .string()
    .trim()
    .max(120, 'Cubrecanto demasiado largo')
    .optional()
    .or(z.literal('')),
  product_type: z.enum(PRODUCT_TYPE_VALUES, { message: 'Tipo de producto inválido' }),
  purchase_type: z.enum(PURCHASE_TYPE_VALUES, { message: 'Tipo de compra inválido' }),
  sale_place: z.enum(SALE_PLACE_VALUES, { message: 'Lugar de venta inválido' }),

  // Colores
  colors: z.array(ColorRowSchema).min(1, 'Agrega al menos un color al pedido'),
});

export type LeadCreateInput = z.infer<typeof LeadCreateSchema>;

// ─── State del Server Action ────────────────────────────────────────────

export type LeadFormState =
  | { status: 'idle' }
  | { status: 'success'; message: string; leadId: string }
  | {
      status: 'error';
      message: string;
      // fieldErrors viene de Zod.flatten() — keys son strings (incluyendo
      // paths anidados como "colors.0.quantity"). No restringimos al keyof.
      fieldErrors?: Record<string, string[]>;
    };

export const initialLeadFormState: LeadFormState = { status: 'idle' };

// ─── Helpers compartidos ────────────────────────────────────────────────

/**
 * Normaliza un nombre para deduplicación accent-insensitive: NFD + strip
 * diacríticos + lower + trim. Idéntico a `admin/catalogs/schema.ts`.
 */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Convierte `''` o `undefined` a `null`. Útil al insertar en columnas nullable. */
export function emptyToNull(v: string | undefined | null): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}
