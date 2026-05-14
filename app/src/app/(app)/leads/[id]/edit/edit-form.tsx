'use client';

import {
  NewLeadForm,
  type SellerOption,
  type ColorOption,
  type DriverOption,
} from '../../new/new-lead-form';
import type { LeadCreateInput } from '../../new/schema';

/**
 * Bundle de datos precargados que `page.tsx` arma desde Supabase y
 * pasa al form de edición.
 */
export type EditLeadFormData = {
  leadId: string;
  initialDocumentUrl: string | null;
  initialValues: Partial<LeadCreateInput>;
};

/**
 * Wrapper sobre `NewLeadForm` en modo edit.
 *
 * Toda la lógica del form (RHF, useFieldArray, watch del purchase_type
 * para ocultar address, validación Zod, manejo de PDF) vive en
 * `NewLeadForm`. Acá solo configuramos el modo y le pasamos los
 * initialValues + el leadId. Esto evita duplicar 800 líneas de UI
 * idéntica entre /leads/new y /leads/[id]/edit.
 *
 * Cambio del action según mode lo decide internamente NewLeadForm:
 * en mode='edit' llama a updateLeadFullAction(leadId, values); en
 * create a saveLeadAction. La forma del input y la validación son
 * idénticas (mismo LeadCreateSchema).
 */
export function EditLeadForm({
  formData,
  sellers,
  colors,
  drivers,
}: {
  formData: EditLeadFormData;
  sellers: SellerOption[];
  colors: ColorOption[];
  drivers: DriverOption[];
}) {
  return (
    <NewLeadForm
      mode="edit"
      leadId={formData.leadId}
      initialValues={formData.initialValues}
      initialDocumentUrl={formData.initialDocumentUrl}
      sellers={sellers}
      colors={colors}
      drivers={drivers}
    />
  );
}

// Re-export del tipo DriverOption por compatibilidad — algunos
// consumidores legacy del archivo importaban DriverOption desde acá.
// (Si nadie más lo usa, este re-export se puede eliminar.)
export type { DriverOption };
