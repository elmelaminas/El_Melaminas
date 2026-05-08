import { supabaseAdmin } from './admin';

/**
 * Helpers para trabajar con Supabase Storage cuando los buckets son
 * PRIVADOS y la URL "pública" devuelta por `getPublicUrl(...)` da 404.
 *
 * Patrón en este proyecto:
 *   - Algunos buckets se crearon como privados en Supabase Dashboard
 *     (ej. `payments-evidence`, `driver-evidence`).
 *   - El código que SUBE archivos guarda `pub.publicUrl` en la columna
 *     `*_photo_url` (formato `…/storage/v1/object/public/{bucket}/…`).
 *   - Esa URL no funciona en navegador autenticado para buckets
 *     privados — devuelve 404. Hay que firmar una URL temporal.
 *
 * Solución: server-side, antes de mandar las URLs al cliente,
 * extraemos el path interno y lo firmamos con `createSignedUrl`.
 * Esto se hace por request (1h de TTL) — el cliente nunca ve el path
 * desnudo, solo la URL firmada.
 */

const PUBLIC_MARKER = '/storage/v1/object/public/';
const SIGN_MARKER = '/storage/v1/object/sign/';

/**
 * Extrae el path interno (relativo al bucket) de una Supabase Storage
 * URL.
 *
 * Acepta tanto el formato público como el firmado:
 *   https://xxx.supabase.co/storage/v1/object/public/{bucket}/{path}
 *   https://xxx.supabase.co/storage/v1/object/sign/{bucket}/{path}?token=…
 *
 * Devuelve `null` si la URL no contiene el marker del bucket esperado
 * (ej. URL externa, otro bucket, o formato distinto). En ese caso el
 * caller debe dejar la URL original sin tocar.
 */
export function extractStoragePath(
  url: string,
  bucket: string,
): string | null {
  if (!url) return null;
  for (const marker of [
    `${PUBLIC_MARKER}${bucket}/`,
    `${SIGN_MARKER}${bucket}/`,
  ]) {
    const idx = url.indexOf(marker);
    if (idx === -1) continue;
    let path = url.slice(idx + marker.length);
    // Las signed URLs traen ?token=…; públicas pueden traer ?t=cache-buster.
    const q = path.indexOf('?');
    if (q !== -1) path = path.slice(0, q);
    // Path puede tener segmentos URL-encoded (ej. espacios). Decodear
    // para que createSignedUrl reciba la forma canónica.
    try {
      return decodeURIComponent(path);
    } catch {
      return path;
    }
  }
  return null;
}

/**
 * Si `url` pertenece al `bucket` privado, genera una signed URL válida
 * por `expiresIn` segundos (default 1h = 3600s). Si no se puede
 * extraer el path o la firma falla, devuelve la URL ORIGINAL como
 * fallback — preferimos un 404 visible en el cliente a romper la
 * página entera por una sola foto. Errores se loguean.
 *
 * Si `url` es null/empty, devuelve sin tocar.
 */
export async function signEvidenceUrl(
  url: string | null | undefined,
  bucket: string,
  expiresIn = 3600,
): Promise<string | null> {
  if (!url) return url ?? null;
  const path = extractStoragePath(url, bucket);
  if (!path) return url; // URL externa o de otro bucket — no tocar.
  try {
    const admin = supabaseAdmin();
    const { data, error } = await admin.storage
      .from(bucket)
      .createSignedUrl(path, expiresIn);
    if (error || !data?.signedUrl) {
      console.error(
        `[signEvidenceUrl] no se pudo firmar (${bucket}/${path}):`,
        error,
      );
      return url;
    }
    return data.signedUrl;
  } catch (e) {
    console.error(`[signEvidenceUrl] excepción firmando (${bucket}):`, e);
    return url;
  }
}

/**
 * Versión bulk: dado un array de URLs del MISMO bucket, las firma en
 * paralelo. Útil cuando hay N filas en una página y queremos minimizar
 * latencia. Las URLs null/empty pasan tal cual.
 *
 * Devuelve un array del mismo largo y orden, con cada entrada firmada
 * (o el fallback original si no se pudo).
 */
export async function signEvidenceUrls(
  urls: (string | null | undefined)[],
  bucket: string,
  expiresIn = 3600,
): Promise<(string | null)[]> {
  return Promise.all(urls.map((u) => signEvidenceUrl(u, bucket, expiresIn)));
}
