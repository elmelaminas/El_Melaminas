/**
 * Helpers compartidos para validación de fotos/imágenes en uploads.
 *
 * Patrón usado por la app:
 *   - El cliente envía la foto vía FormData (no por Zod resolver
 *     porque `File` no se serializa en JSON).
 *   - El cliente NO valida con un schema Zod sobre el File: lo hace
 *     manualmente con `validatePhotoFile()` antes de enviar, y
 *     deshabilita el botón submit cuando la validación no pasa.
 *   - El servidor RE-valida con la MISMA función como defensa en
 *     profundidad (defensa contra manipulación del FormData, RPC
 *     directa, etc.).
 *
 * Por qué no exportamos un `z.instanceof(File)`: el tipo `File` no
 * existe en SSR/Node (sólo en `lib.dom`). Importar un schema con
 * `z.instanceof(File)` desde un módulo neutro hace que el bundle
 * server crashee. Resolvemos con un validador puro (función) que
 * acepta `unknown` y opera defensivamente sobre las propiedades
 * relevantes (size, type, name).
 */

/** Tamaño máximo aceptado: 10 MB (suficiente para fotos HEIC de iPhone). */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/** Extensiones de archivo aceptadas. HEIC viene de iPhone — algunos
 *  browsers no lo previsualizan pero Supabase Storage lo guarda igual. */
export const PHOTO_ALLOWED_EXTS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'heic',
] as const;

/** Mime types correspondientes a las extensiones aceptadas. */
export const PHOTO_ALLOWED_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const;

export type PhotoValidationResult =
  | { ok: true; file: { name: string; size: number; type: string } }
  | { ok: false; message: string };

/**
 * Valida que `candidate` sea un File con contenido y extensión válida.
 * Compatible cliente/servidor: en server `File` puede no existir como
 * global pero los objetos Web `File` que llegan por FormData en
 * Next.js exponen `size`, `type` y `name`. Operamos defensivamente
 * sobre esas propiedades en lugar de `instanceof File`.
 *
 * Reglas:
 *   1. Debe existir y `size > 0` (no input vacío).
 *   2. `size <= PHOTO_MAX_BYTES`.
 *   3. Extensión en `PHOTO_ALLOWED_EXTS` (lowercase, derivada de
 *      `name`). El mime type se valida cuando viene presente; si está
 *      vacío (algunos browsers/iOS), aceptamos basados en la extensión
 *      sola.
 */
export function validatePhotoFile(
  candidate: unknown,
): PhotoValidationResult {
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !('size' in candidate) ||
    !('name' in candidate)
  ) {
    return { ok: false, message: 'La foto es obligatoria.' };
  }
  const file = candidate as { size: number; name: string; type?: string };
  const size = Number(file.size ?? 0);
  if (!size || size <= 0) {
    return { ok: false, message: 'La foto es obligatoria.' };
  }
  if (size > PHOTO_MAX_BYTES) {
    return {
      ok: false,
      message: `La imagen excede ${Math.floor(PHOTO_MAX_BYTES / (1024 * 1024))} MB.`,
    };
  }
  const name = String(file.name ?? '');
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (!(PHOTO_ALLOWED_EXTS as readonly string[]).includes(ext)) {
    return {
      ok: false,
      message: 'Formato no soportado. Usa JPG, PNG, WEBP o HEIC.',
    };
  }
  return {
    ok: true,
    file: {
      name,
      size,
      type: typeof file.type === 'string' ? file.type : '',
    },
  };
}

/** Atributo `accept` para `<input type="file">`. */
export const PHOTO_ACCEPT_ATTR = 'image/jpeg,image/png,image/webp,image/heic';
