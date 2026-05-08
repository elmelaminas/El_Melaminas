/**
 * Constantes neutras compartidas entre el Server Component (page.tsx) y
 * el Client Component (dashboard-client.tsx).
 *
 * Vive en su propio archivo SIN `'use client'` ni `'use server'` porque
 * los exports no-función de un módulo `'use client'` son referencias
 * opacas vistas desde un Server Component (Next 16 RSC los serializa
 * para el bundle del cliente y el server no puede leerlos como valores).
 * Eso causaba el bug del subtitle "Métricas de — 2026" — `MES_LABEL[mes]`
 * retornaba undefined en el server. Al moverlo aquí, ambos contextos
 * acceden al mismo objeto plano.
 */

export const MES_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Enero' },
  { value: 2, label: 'Febrero' },
  { value: 3, label: 'Marzo' },
  { value: 4, label: 'Abril' },
  { value: 5, label: 'Mayo' },
  { value: 6, label: 'Junio' },
  { value: 7, label: 'Julio' },
  { value: 8, label: 'Agosto' },
  { value: 9, label: 'Septiembre' },
  { value: 10, label: 'Octubre' },
  { value: 11, label: 'Noviembre' },
  { value: 12, label: 'Diciembre' },
];

export const MES_LABEL: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(MES_OPTIONS.map((m) => [m.value, m.label])),
);
