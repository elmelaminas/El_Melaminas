/**
 * Schema y tipos para /leads/[id]/edit.
 *
 * El editor full reusa el schema de creación (`LeadCreateSchema`) porque
 * los campos editables son IDÉNTICOS a los de creación — un lead se
 * edita "como si se volviera a capturar". El state del action es
 * `LeadFormState` (mismo shape que el de saveLeadAction), pero
 * exportamos un alias `LeadFullEditState` para que el caller hable
 * con un nombre local.
 *
 * NB: el control de acceso (solo admin) vive en el Server Action y en
 * el page.tsx — el middleware solo restringe la ruta. La acción
 * vuelve a checkear el role aunque el page lo haya hecho — defensa en
 * profundidad.
 */

export {
  LeadCreateSchema as LeadFullEditSchema,
  type LeadCreateInput as LeadFullEditInput,
  type LeadFormState as LeadFullEditState,
  initialLeadFormState as initialLeadFullEditState,
} from '../../new/schema';
