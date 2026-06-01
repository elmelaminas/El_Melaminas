/**
 * `normalizeSearch(text)` — colapsa una string a una forma plana para
 * comparaciones de búsqueda: lowercase + sin diacríticos + trim.
 *
 * Sirve para que un input "García" matchee contra "garcia" y viceversa
 * en filtros locales (en memoria), donde tenemos control de ambos
 * lados de la comparación.
 *
 * Para filtros server-side contra Supabase (PostgREST `ilike`) la
 * normalización del input ayuda solo en una dirección — si los datos
 * en DB todavía tienen acentos, no van a matchear contra el input
 * de-acentuado. La solución completa requiere una columna generada o
 * una función `unaccent_lower` en SQL (acción manual de Sergio).
 * Mientras tanto, este helper igual reduce las inconsistencias del
 * lado del usuario.
 */

// Rango de combining diacritical marks (U+0300..U+036F) escapado en
// hex para no depender de cómo el editor renderiza los caracteres
// combining. NFD descompone "í" en "i" + U+0301; este replace borra
// el U+0301 dejando solo la base.
const DIACRITICS_RE = new RegExp('[\\u0300-\\u036f]', 'g');

export function normalizeSearch(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(DIACRITICS_RE, '').trim();
}
