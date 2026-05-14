'use client';

/**
 * Hook que retorna los pasos del tour específico de la ruta actual.
 *
 * Devuelve `null` cuando la página actual no tiene tour propio — el
 * caller debe caer al tour global por rol en ese caso.
 *
 * Estrategia de matching:
 *   1. Match exacto del `pathname` contra las keys de `PAGE_TOURS`.
 *   2. Si no hay exacto, busca por PREFIJO (la primera key tal que
 *      `pathname.startsWith(key)`). Útil para rutas dinámicas como
 *      `/leads/[id]/edit` que pueden compartir el tour de `/leads/new`
 *      si no hay uno propio (orden de declaración importa — el
 *      primer prefijo que coincida gana).
 *
 * Para evitar ciclo de imports, el tipo `TourStep` se importa solo
 * como tipo (TS lo borra en build), no como valor.
 */

import { usePathname } from 'next/navigation';
import type { TourStep } from '@/components/ui/AppTour';

/**
 * Mapa ruta → pasos del tour contextual. Las keys son rutas exactas
 * o prefijos (ver estrategia de matching). Los selectores `#field-*`
 * apuntan a IDs aplicados en los formularios y tablas; selectores que
 * no resuelven al iniciar el tour son skipped por driver.js (warning
 * en consola, no crash).
 */
const PAGE_TOURS: Readonly<Record<string, TourStep[]>> = {
  '/leads/new': [
    {
      element: '#field-channel',
      popover: {
        title: '📱 Canal de origen',
        description:
          'Selecciona por dónde llegó el cliente: TikTok, WhatsApp, Google o Tienda física.',
      },
    },
    {
      element: '#field-seller',
      popover: {
        title: '👤 Vendedor',
        description: 'Elige el vendedor que atendió al cliente.',
      },
    },
    {
      element: '#field-driver',
      popover: {
        title: '🚚 Chofer asignado',
        description:
          'Opcional: asigna desde aquí el chofer que hará la entrega.',
      },
    },
    {
      element: '#field-client',
      popover: {
        title: '👥 Datos del cliente',
        description: 'Nombre completo y teléfono del cliente.',
      },
    },
    {
      element: '#field-sheets',
      popover: {
        title: '📋 Número de hojas',
        description: 'Cantidad total de hojas de melamina que pide.',
      },
    },
    {
      element: '#field-colors',
      popover: {
        title: '🎨 Colores',
        description:
          'Agrega los colores y cantidades. Puedes escribir un color nuevo y se guardará automáticamente en el catálogo.',
      },
    },
    {
      element: '#field-edgebanding',
      popover: {
        title: '📏 Cubrecanto',
        description:
          'Selecciona 19mm ($5/m) o 3.5mm ($8/m) e ingresa los metros. El total se calcula automáticamente.',
      },
    },
    {
      element: '#field-cuts',
      popover: {
        title: '✂️ Cortes',
        description:
          'Si el producto es "Con corte", ingresa el número de cortes. Se multiplican por $5 automáticamente.',
      },
    },
    {
      element: '#field-address',
      popover: {
        title: '📍 Dirección',
        description:
          'Dirección de entrega y link de Google Maps para el chofer.',
      },
    },
    {
      element: '#field-cost',
      popover: {
        title: '💰 Costo por hoja',
        description:
          'Precio unitario: $350, $600 o $2,200 según el tipo de material.',
      },
    },
    {
      element: '#field-total',
      popover: {
        title: '💵 Total',
        description:
          'Se calcula automáticamente: hojas × costo + cortes + cubrecanto.',
      },
    },
    {
      element: '#field-pdf',
      popover: {
        title: '📄 PDF adjunto',
        description:
          'Opcional: adjunta una cotización o contrato en PDF.',
      },
    },
    {
      element: '#btn-save-lead',
      popover: {
        title: '✅ Guardar',
        description:
          'Al guardar, el material se compromete en el inventario automáticamente.',
      },
    },
  ],

  '/leads': [
    {
      element: '#leads-search',
      popover: {
        title: '🔍 Buscador',
        description: 'Busca por nombre del cliente o teléfono.',
      },
    },
    {
      element: '#leads-filter-channel',
      popover: {
        title: '📱 Filtro canal',
        description: 'Filtra por el canal de origen del lead.',
      },
    },
    {
      element: '#leads-filter-delivery',
      popover: {
        title: '🚚 Filtro entrega',
        description:
          '"Pendientes" incluye tanto pendiente como en tránsito.',
      },
    },
    {
      element: '#leads-filter-payment',
      popover: {
        title: '💳 Filtro pago',
        description:
          'Filtra por estado del pago: pendiente, parcial o pagado.',
      },
    },
    {
      element: '#leads-legend',
      popover: {
        title: '🎨 Código de colores',
        description:
          'Rosa=venta empleado, Naranja=contra entrega, Amarillo=pagado sin entregar, Azul=con corte. Puedes asignar color manualmente con el círculo en Acciones.',
      },
    },
    {
      element: '#leads-table',
      popover: {
        title: '📋 Tabla de leads',
        description:
          'El ícono PDF abre el documento adjunto. El lápiz edita fecha y chofer. El círculo cambia el color de la fila.',
      },
    },
  ],

  '/payments/new': [
    {
      element: '#field-lead-search',
      popover: {
        title: '🔍 Buscar cliente',
        description:
          'Escribe el nombre o teléfono del cliente. Se autocarga el total y el adeudo pendiente.',
      },
    },
    {
      element: '#field-amount',
      popover: {
        title: '💰 Monto que paga',
        description:
          'Ingresa cuánto está pagando en esta ocasión.',
      },
    },
    {
      element: '#field-method',
      popover: {
        title: '💳 Método de pago',
        description: 'Efectivo, Transferencia o Clip.',
      },
    },
    {
      element: '#field-payment-type',
      popover: {
        title: '📑 Tipo de pago',
        description:
          'Anticipo (pago parcial), Liquidación (pago final) o Contra entrega.',
      },
    },
    {
      element: '#field-evidence',
      popover: {
        title: '📸 Evidencia',
        description:
          'Sube foto del comprobante. Obligatoria para transferencias y Clip.',
      },
    },
    {
      element: '#field-deductibles',
      popover: {
        title: '➖ Deducibles',
        description:
          'Agrega gastos o descuentos: gasolina, comisión Clip, etc. El ingreso neto se calcula automáticamente.',
      },
    },
  ],

  '/payments': [
    {
      element: '#payments-totals',
      popover: {
        title: '💰 Totales',
        description:
          'Cobrado bruto, deducibles totales e ingreso neto del período filtrado.',
      },
    },
    {
      element: '#payments-filter-method',
      popover: {
        title: '💳 Filtro método',
        description: 'Filtra por efectivo, transferencia o Clip.',
      },
    },
    {
      element: '#payments-table',
      popover: {
        title: '📋 Historial',
        description:
          'El ícono de cámara abre la foto de evidencia del pago en pantalla completa.',
      },
    },
  ],

  '/warehouse': [
    {
      element: '#stock-table',
      popover: {
        title: '📦 Stock por color',
        description:
          'Fila amarilla = bajo el mínimo. Fila roja = sin stock. Stock disponible = total - comprometido.',
      },
    },
    {
      element: '#stock-exit-section',
      popover: {
        title: '✅ Salidas pendientes',
        description:
          'Leads listos para salir del almacén. Presiona "Registrar salida" para descontar del inventario y notificar al chofer.',
      },
    },
    {
      element: '#movements-table',
      popover: {
        title: '📊 Movimientos',
        description:
          'Historial completo: entradas, salidas, compromisos y devoluciones. La columna Cliente muestra qué pedido originó el movimiento.',
      },
    },
  ],

  '/admin/entregas': [
    {
      element: '#entregas-date',
      popover: {
        title: '📅 Ruta del día',
        description:
          'Selecciona la fecha y asigna el orden de entrega a cada pedido. Al guardar, el chofer recibe una notificación.',
      },
    },
    {
      element: '#entregas-filter-driver',
      popover: {
        title: '🚗 Filtro chofer',
        description: 'Filtra las entregas por chofer específico.',
      },
    },
    {
      element: '#entregas-table',
      popover: {
        title: '📋 Tabla de entregas',
        description:
          'Filas rojas = material pendiente de devolución. Badge naranja = no entregado. Badge ⚠️ = faltante o detalle reportado por el chofer.',
      },
    },
  ],

  '/admin/users': [
    {
      element: '#btn-new-user',
      popover: {
        title: '➕ Nuevo usuario',
        description:
          'Crea vendedores, choferes, almacenistas o contadores. Recibirán un correo para configurar su contraseña.',
      },
    },
    {
      element: '#users-table',
      popover: {
        title: '👥 Tabla de usuarios',
        description:
          'El toggle activa/desactiva la cuenta. El lápiz edita nombre, teléfono y rol.',
      },
    },
  ],

  '/admin/catalogs': [
    {
      popover: {
        title: '📚 Catálogos',
        description:
          'Gestiona vendedores y materiales. Los colores nuevos se crean automáticamente cuando los agregas en un lead.',
      },
    },
  ],

  '/admin/caja': [
    {
      element: '#tab-por-validar',
      popover: {
        title: '⏳ Por validar',
        description:
          'Efectivo que el contador ya recibió de los choferes pero que aún no has confirmado tú como admin.',
      },
    },
    {
      element: '#tab-validados',
      popover: {
        title: '✅ Validados',
        description:
          'Historial de efectivo que ya confirmaste. Muestra el total validado del mes actual.',
      },
    },
  ],

  '/contador': [
    {
      popover: {
        title: '💵 Vista contador',
        description:
          'Ves el efectivo que trae cada chofer pendiente de entregarte.',
      },
    },
    {
      popover: {
        title: '✅ Recibir efectivo',
        description:
          'Selecciona el chofer y presiona "Recibí efectivo". El admin recibirá una notificación para validarlo.',
      },
    },
    {
      popover: {
        title: '📋 Historial',
        description:
          'Tus últimas recepciones. "Recibido" = esperando validación del admin. "Validado" = ciclo cerrado.',
      },
    },
  ],

  '/driver': [
    {
      popover: {
        title: '📦 Banner de entregas',
        description:
          'Muestra cuántas entregas tienes programadas para hoy.',
      },
    },
    {
      popover: {
        title: '🗺️ Entrega actual',
        description:
          'Ves una entrega a la vez en el orden que el admin asignó. El contador "1 de N" te indica tu progreso.',
      },
    },
    {
      popover: {
        title: '✅ Confirmar entrega',
        description:
          'Al entregar presiona el botón. Si hay saldo, sube foto del cobro.',
      },
    },
    {
      popover: {
        title: '⚠️ No pude entregar',
        description:
          'Si no puedes entregar: describe el motivo y toma foto del lugar. Es obligatorio para continuar con la siguiente entrega.',
      },
    },
    {
      popover: {
        title: '🔧 Reportar faltante',
        description:
          'Si falta material o hay un detalle, repórtalo con foto. El admin lo verá en su vista de entregas.',
      },
    },
  ],
};

/**
 * Detecta la ruta actual y devuelve los pasos del tour contextual,
 * o `null` si la página no tiene tour propio.
 *
 * El orden de evaluación es:
 *   1. Match exacto (`PAGE_TOURS[pathname]`).
 *   2. Match por prefijo (primera key tal que pathname.startsWith).
 *      Como `Object.entries` preserva el orden de declaración en JS
 *      moderno, las rutas MÁS específicas se declaran primero arriba.
 *      Ej: `/leads/new` antes que `/leads` para evitar que un usuario
 *      en `/leads/new` reciba el tour de `/leads`.
 *   3. Fallback `null` → el caller debe usar el tour global por rol.
 */
export function usePageTour(): TourStep[] | null {
  const pathname = usePathname();
  const exact = PAGE_TOURS[pathname];
  if (exact) return exact;
  for (const [key, steps] of Object.entries(PAGE_TOURS)) {
    if (pathname.startsWith(key + '/') || pathname === key) {
      return steps;
    }
  }
  return null;
}
