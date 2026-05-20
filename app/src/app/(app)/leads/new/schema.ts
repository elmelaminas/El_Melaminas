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

// Costo por hoja: cuatro tarifas vigentes. La DB tiene un CHECK
// constraint sobre `leads.cost_per_sheet IN (350, 450, 600, 2200)`
// (requiere migración manual al modificar esta lista). Recordatorios:
//   1) actualizar el CHECK constraint con ALTER TABLE manual,
//   2) los leads viejos con valores fuera (ej. 750/650/600 históricos)
//      siguen siendo válidos en la DB pero NO se pueden re-guardar con
//      ese valor desde este formulario.
export const COST_PER_SHEET_VALUES = [350, 450, 600, 2200] as const;
export const COST_PER_SHEET_OPTIONS: {
  value: (typeof COST_PER_SHEET_VALUES)[number];
  label: string;
}[] = [
  { value: 350, label: '$350' },
  { value: 450, label: '$450' },
  { value: 600, label: '$600' },
  { value: 2200, label: '$2,200' },
];

// Cubrecanto: el viejo campo `edge_banding` (text libre) se reemplaza por
// un par estructurado `(edge_banding_type, edge_banding_meters)` con
// total derivado `meters * EDGE_BANDING_RATE[type]`. La columna `edge_banding`
// se mantiene en DB para compatibilidad con leads históricos pero los
// nuevos NO la llenan.
export const EDGE_BANDING_VALUES = ['19mm', '3.5mm'] as const;
export const EDGE_BANDING_OPTIONS: {
  value: (typeof EDGE_BANDING_VALUES)[number];
  label: string;
}[] = [
  { value: '19mm', label: '19 mm' },
  { value: '3.5mm', label: '3.5 mm' },
];
/** Tarifa por metro lineal según tipo de cubrecanto. */
export const EDGE_BANDING_RATE: Readonly<
  Record<(typeof EDGE_BANDING_VALUES)[number], number>
> = {
  '19mm': 5,
  '3.5mm': 8,
};

/** Tarifa por corte cuando product_type='con_corte'. */
export const CUT_RATE = 5;

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
 *
 * `cost_per_sheet` es POR FILA (cada color puede tener su propio
 * precio). Antes vivía en el nivel raíz del lead como "costo único";
 * ahora cada color carga su tarifa. El `total_amount` del lead se
 * calcula como SUM(quantity * cost_per_sheet) por cada fila + cortes +
 * cubrecanto. Para compatibilidad con el resto del sistema, el server
 * sigue escribiendo `leads.cost_per_sheet` usando el costo del PRIMER
 * color (suficiente para reportes generales; el desglose real vive en
 * `lead_colors.cost_per_sheet`).
 */
export const ColorRowSchema = z
  .object({
    color_id: z.string().min(1, 'Selecciona un color'),
    new_name: z.string().trim().max(60, 'Nombre demasiado largo').optional(),
    quantity: z
      .number({ invalid_type_error: 'Cantidad debe ser un número' })
      .int('Cantidad debe ser entero')
      .positive('Cantidad debe ser ≥ 1'),
    cost_per_sheet: z
      .number({ invalid_type_error: 'Costo por hoja inválido' })
      .int('Costo debe ser entero')
      .refine(
        (v) => (COST_PER_SHEET_VALUES as readonly number[]).includes(v),
        { message: 'Costo por hoja debe ser uno de los valores permitidos' },
      ),
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

/**
 * Una fila de cubrecanto (color + cantidad + costo unitario). El
 * costo del cubrecanto ahora se ingresa POR FILA (cada color con su
 * propio precio unitario), igual que en hojas. El total contribuido
 * al `total_amount` del lead es SUM(quantity × unit_cost) sobre todas
 * las filas. El campo `edgebanding_manual_cost` ya no existe.
 *
 * Persistencia: el `unit_cost` viaja a `lead_edgebanding_colors.unit_cost`
 * (columna agregada vía migración manual).
 *
 * `color_id` puede ser un UUID o el sentinel NEW_COLOR_SENTINEL; en
 * el segundo caso `new_name` debe traer un nombre nuevo (mín. 2
 * chars). Mismo patrón que `ColorRowSchema`.
 */
export const EdgebandingColorRowSchema = z
  .object({
    color_id: z.string().min(1, 'Selecciona un color'),
    new_name: z.string().trim().max(60, 'Nombre demasiado largo').optional(),
    quantity: z
      .number({ invalid_type_error: 'Cantidad debe ser un número' })
      .int('Cantidad debe ser entero')
      .positive('Cantidad debe ser ≥ 1'),
    unit_cost: z
      .number({ invalid_type_error: 'Costo inválido' })
      .min(0, 'El costo no puede ser negativo')
      .max(1_000_000, 'Costo demasiado grande'),
  })
  .refine(
    (v) => {
      if (v.color_id === NEW_COLOR_SENTINEL) {
        return typeof v.new_name === 'string' && v.new_name.trim().length >= 2;
      }
      return true;
    },
    {
      message: 'Ingresa el nombre del color nuevo (mín. 2 caracteres)',
      path: ['new_name'],
    },
  );

export type EdgebandingColorRowInput = z.infer<typeof EdgebandingColorRowSchema>;

// ─── Costos extras ──────────────────────────────────────────────────────
//
// Sección libre de cargos adicionales al pedido (flete especial,
// instalación, ajustes, etc.). Se persiste como JSONB en
// `leads.extra_costs`:
//   [{"description": "Flete especial", "amount": 200}, ...]
//
// Requiere migración manual previa:
//   ALTER TABLE leads ADD COLUMN IF NOT EXISTS extra_costs jsonb
//     DEFAULT '[]';
//
// Su contribución al `total_amount` es SUM(amount). El admin lo edita
// libremente desde /leads/new y /leads/[id]/edit; no compromete
// inventario ni dispara movimientos.

export const ExtraCostSchema = z.object({
  description: z
    .string()
    .trim()
    .min(1, 'Descripción requerida')
    .max(100, 'Descripción demasiado larga'),
  amount: z
    .number({ invalid_type_error: 'Monto inválido' })
    .min(0, 'El monto debe ser mayor a 0')
    .max(1_000_000, 'Monto demasiado grande'),
});

export type ExtraCostInput = z.infer<typeof ExtraCostSchema>;

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
  // `phone` y `address` son OPCIONALES a nivel de tipo. La
  // obligatoriedad real depende de `purchase_type` + `has_hojas`:
  //   - domicilio + has_hojas → phone (10 dígitos) + address (≥5
  //     chars) requeridos
  //   - cualquier otro caso (fábrica, o pedido solo de catálogo /
  //     cubrecanto sin entrega física a domicilio) → ambos opcionales
  // El refine cross-field abajo aplica esa lógica condicional.
  phone: z
    .string()
    .trim()
    .max(20, 'Teléfono demasiado largo')
    .optional()
    .or(z.literal('')),
  address: z
    .string()
    .trim()
    .max(500, 'Dirección demasiado larga')
    .optional()
    .or(z.literal('')),
  maps_url: z
    .string()
    .trim()
    .max(500)
    .optional()
    .or(z.literal('')),

  // Pedido
  //
  // `cost_per_sheet` se MOVIÓ a ColorRowSchema: cada color tiene su
  // propio costo. El server escribe `leads.cost_per_sheet` con el costo
  // del primer color por compatibilidad con reportes/queries existentes,
  // y `lead_colors.cost_per_sheet` con el costo real de cada fila.

  // Cortes — solo aplica cuando product_type='con_corte'.
  // `cuts_total` lo recalcula el server desde `cuts_count * CUT_RATE`;
  // lo dejamos en el schema para que el form pueda enviarlo y el server
  // tenga defensa en profundidad, pero el cliente NO debe confiar en él
  // (lo computamos en JS para mostrar en pantalla).
  cuts_count: z
    .number({ invalid_type_error: 'Número de cortes inválido' })
    .int('Cortes debe ser entero')
    .min(1, 'Mínimo 1 corte')
    .optional()
    .nullable(),
  cuts_total: z.number().optional().nullable(),

  // Cubrecanto estructurado. `edge_banding_type=''` (literal vacío del
  // dropdown "Sin cubrecanto") se trata como ausente; el server lo
  // convierte a null. Si hay tipo, los metros son requeridos (validado
  // con .refine cross-field abajo).
  //
  // NB: usamos `z.string().refine(...)` en lugar de
  // `z.enum(EDGE_BANDING_VALUES).or(z.literal(''))` porque el segundo
  // patrón no produce un union útil en Zod 3.25 (TS narrowea al enum
  // sin incluir '' en el inferred type, rompiendo refines abajo).
  edge_banding_type: z
    .string()
    .refine(
      (v) =>
        v === '' ||
        (EDGE_BANDING_VALUES as readonly string[]).includes(v),
      { message: 'Tipo de cubrecanto inválido' },
    )
    .optional()
    .nullable(),
  edge_banding_meters: z
    .number({ invalid_type_error: 'Metros inválidos' })
    .min(0, 'Metros debe ser ≥ 0')
    .optional()
    .nullable(),
  edge_banding_total: z.number().optional().nullable(),

  product_type: z.enum(PRODUCT_TYPE_VALUES, { message: 'Tipo de producto inválido' }),
  purchase_type: z.enum(PURCHASE_TYPE_VALUES, { message: 'Tipo de compra inválido' }),
  sale_place: z.enum(SALE_PLACE_VALUES, { message: 'Lugar de venta inválido' }),

  // Costo del envío a domicilio. Solo aplica cuando
  // purchase_type='domicilio'; en 'fabrica' el form lo oculta y el
  // server lo descarta a null. Se SUMA al total_amount.
  delivery_cost: z
    .number({ invalid_type_error: 'Costo de envío inválido' })
    .min(0, 'Costo de envío no puede ser negativo')
    .optional()
    .nullable(),

  // ── Tipos de pedido (selección múltiple) ────────────────────────
  //
  // Un lead puede incluir 1, 2 o los 3 tipos simultáneamente. Al
  // menos uno debe estar activo (validado con superRefine abajo).
  //
  // - has_hojas      → la sección de colores/hojas/cortes/cubrecanto
  //                    estructurado aplica. Si false, no se
  //                    compromete inventario y `colors` se ignora.
  // - has_cubrecanto → cubrecanto adicional (manual, fuera del
  //                    cálculo por metros). Costo libre en
  //                    `edgebanding_manual_cost`.
  // - has_catalogo   → suma `catalog_price` al total (default $500).
  has_hojas: z.boolean(),
  has_cubrecanto: z.boolean(),
  has_catalogo: z.boolean(),

  /** Precio del catálogo cuando `has_catalogo=true`. Default $500
   *  pero el admin puede ajustarlo si aplica descuento o markup.
   *  El form siempre lo provee (RHF defaultValues), por eso no
   *  necesitamos `.default()` aquí (que rompería el resolver de
   *  RHF al hacer el campo `T | undefined` en el input type). */
  catalog_price: z
    .number({ invalid_type_error: 'Precio del catálogo inválido' })
    .min(0, 'El precio del catálogo no puede ser negativo'),

  // Colores: la lista vive en el schema siempre; el server decide
  // si crear lead_colors/inventory según `has_hojas`. Si has_hojas
  // es true se exige al menos un color; si es false la lista puede
  // estar vacía (refine cross-field abajo).
  colors: z.array(ColorRowSchema),

  /**
   * Colores del cubrecanto (informativo). Se persiste en
   * `lead_edgebanding_colors` cuando has_cubrecanto=true. El costo
   * total sigue viniendo de `edgebanding_manual_cost`; estos colores
   * NO comprometen inventario.
   */
  edgebanding_colors: z.array(EdgebandingColorRowSchema),

  /**
   * Cargos adicionales al pedido (flete, instalación, etc.). Sin
   * límite de items. Cada fila aporta `amount` al `total_amount`.
   * Persistido como JSONB en `leads.extra_costs`.
   *
   * Required array (vacío por default). Sin `.optional()` para no
   * romper la inferencia del input-type que RHF pide del resolver
   * — el form siempre envía `[]` cuando no hay extras.
   */
  extra_costs: z.array(ExtraCostSchema),
})
.refine(
  // Al menos uno de los 3 tipos de pedido debe estar activo.
  (d) => d.has_hojas || d.has_cubrecanto || d.has_catalogo,
  {
    message: 'El pedido debe incluir al menos un tipo (hojas, cubrecanto o catálogo).',
    path: ['has_hojas'],
  },
)
.refine(
  // Si has_hojas=true, debe haber al menos un color con su costo.
  (d) => {
    if (!d.has_hojas) return true;
    return d.colors && d.colors.length > 0;
  },
  {
    message: 'Agrega al menos un color al pedido cuando incluye hojas.',
    path: ['colors'],
  },
)
.refine(
  // Si has_cubrecanto=true, al menos UNO de los dos campos debe
  // estar definido:
  //   - tipo de cubrecanto (19mm/3.5mm) con metros > 0
  //   - al menos un color registrado (con su costo unitario)
  // Cualquiera de los dos justifica activar la sección. El refine
  // específico sobre `edge_banding_meters` (abajo) asegura que si
  // el tipo está seleccionado, los metros sean > 0.
  (d) => {
    if (!d.has_cubrecanto) return true;
    const typeIsSet =
      d.edge_banding_type === '19mm' || d.edge_banding_type === '3.5mm';
    const hasColors =
      Array.isArray(d.edgebanding_colors) && d.edgebanding_colors.length > 0;
    return typeIsSet || hasColors;
  },
  {
    message: 'Define al menos el tipo de cubrecanto o un color.',
    path: ['edge_banding_type'],
  },
)
.refine(
  // Si el producto es "Con corte" Y el pedido incluye hojas,
  // cuts_count es obligatorio ≥ 1. Sin hojas (catálogo/cubrecanto
  // sueltos), product_type no aplica y no exigimos cortes.
  (d) => {
    if (!d.has_hojas) return true;
    if (d.product_type === 'con_corte') {
      return typeof d.cuts_count === 'number' && d.cuts_count >= 1;
    }
    return true;
  },
  {
    message:
      'El número de cortes es requerido cuando el producto es "Con corte"',
    path: ['cuts_count'],
  },
)
.refine(
  // Si has_cubrecanto=true y se eligió un tipo (no vacío/null), los
  // metros deben venir definidos y > 0. El tipo + metros viven ahora
  // en la sección Cubrecanto (antes estaba dentro de Hojas).
  (d) => {
    if (!d.has_cubrecanto) return true;
    const typeIsSet = d.edge_banding_type && d.edge_banding_type !== '';
    if (typeIsSet) {
      return (
        typeof d.edge_banding_meters === 'number' &&
        d.edge_banding_meters > 0
      );
    }
    return true;
  },
  {
    message: 'Los metros son requeridos cuando seleccionas cubrecanto',
    path: ['edge_banding_meters'],
  },
)
.refine(
  // address es requerida SOLO cuando la entrega es a domicilio Y el
  // pedido incluye hojas. Pedidos solo de cubrecanto o catálogo
  // (incluso a domicilio) suelen ir sin entrega física típica
  // — preferimos no obligar y dejar que el operador decida.
  (d) => {
    if (d.purchase_type === 'domicilio' && d.has_hojas) {
      return typeof d.address === 'string' && d.address.trim().length >= 5;
    }
    return true;
  },
  {
    message:
      'Dirección requerida (mínimo 5 caracteres) cuando la compra es a domicilio y el pedido incluye hojas',
    path: ['address'],
  },
)
.refine(
  // phone es requerido (mín. 10 dígitos numéricos) bajo el mismo
  // criterio que address: solo cuando hay que entregar a domicilio
  // hojas. Para catálogo/cubrecanto suelto no se exige.
  (d) => {
    if (d.purchase_type === 'domicilio' && d.has_hojas) {
      if (typeof d.phone !== 'string') return false;
      const digits = d.phone.replace(/\D/g, '');
      return digits.length >= 10;
    }
    return true;
  },
  {
    message:
      'Teléfono requerido (10 dígitos) cuando la compra es a domicilio y el pedido incluye hojas',
    path: ['phone'],
  },
);

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

// ─── Upload de documentos (Grupo 3) ──────────────────────────────────

/**
 * Upload de documentos asociados a un lead — hasta 5 archivos, mezcla
 * libre de PDFs e imágenes. La validación de archivo (mime, size) vive
 * en el action porque `File` no se serializa en JSON; el schema valida
 * solo el `lead_id`.
 *
 * Flujo: al guardar el lead, si el usuario adjuntó documentos, después
 * del INSERT exitoso se llama `uploadLeadDocumentsAction(leadId,
 * files[])` que sube todos al bucket `lead-documents` y UPDATEa
 * `leads.document_urls` (array) + `leads.document_url` (primer archivo,
 * compat con vista legacy). La subida es non-fatal: si falla, el lead
 * sigue creado y la UI muestra warning.
 *
 * Migración manual previa en Supabase:
 *   ALTER TABLE leads ADD COLUMN IF NOT EXISTS document_url text;
 *   ALTER TABLE leads ADD COLUMN IF NOT EXISTS document_urls text[] DEFAULT '{}';
 *   -- Storage: crear bucket 'lead-documents' (público o con políticas).
 */
export const UploadLeadDocumentsSchema = z.object({
  lead_id: z.string().uuid('lead_id inválido'),
});

export type UploadLeadDocumentsState =
  | { status: 'idle' }
  | { status: 'success'; document_urls: string[] }
  | { status: 'error'; message: string };

export const initialUploadLeadDocumentsState: UploadLeadDocumentsState = {
  status: 'idle',
};

/** Tamaño máximo por archivo (10 MB). Igual al límite del File input
 *  en el form para feedback temprano. */
export const LEAD_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Cantidad máxima de archivos adjuntos por lead. */
export const LEAD_DOCUMENT_MAX_FILES = 5;

/** Bucket de Supabase Storage donde van los documentos de leads. Crear
 *  manualmente en el dashboard si no existe. */
export const LEAD_DOCUMENT_BUCKET = 'lead-documents';

/** Extensiones permitidas (PDF + imágenes comunes). El form valida en
 *  cliente; el server revalida por defensa. HEIC viene de iPhone — lo
 *  aceptamos aunque algunos browsers no lo previsualicen nativamente. */
export const LEAD_DOCUMENT_EXTS = [
  'pdf',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'heic',
] as const;

/** Helper: deduce si una URL apunta a PDF mirando la extensión final.
 *  Útil para la UI cuando solo tenemos la URL (no el File original). */
export function isPdfUrl(url: string): boolean {
  const clean = url.split('?')[0].toLowerCase();
  return clean.endsWith('.pdf');
}

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
