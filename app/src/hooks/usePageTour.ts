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
  '/dashboard': [
    {
      element: '#dashboard-filter',
      popover: {
        title: '📅 Filtro de mes',
        description:
          'Cambia el mes y año para ver las métricas de cualquier período.',
      },
    },
    {
      element: '#dashboard-metrics',
      popover: {
        title: '📊 Métricas',
        description:
          'Haz clic en cualquier recuadro para ver el detalle desglosado de esa métrica.',
      },
    },
    {
      element: '#dashboard-chart',
      popover: {
        title: '📈 Leads por canal',
        description:
          'Distribución de leads de los últimos 7 días por canal de origen.',
      },
    },
  ],

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
      element: '#field-purchase-type',
      popover: {
        title: '🏭 Tipo de compra',
        description:
          'A domicilio: se habilitará campo de dirección, maps y costo de envío. En fábrica: el cliente recoge directamente.',
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
      element: '#field-address',
      popover: {
        title: '📍 Dirección',
        description:
          'Dirección de entrega y link de Google Maps para el chofer. Solo aparece si es A domicilio.',
      },
    },
    {
      element: '#field-delivery-cost',
      popover: {
        title: '🚗 Costo de envío',
        description:
          'Solo aparece si es A domicilio. Se suma automáticamente al total del pedido.',
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
          'Agrega los colores, cantidades y el costo de cada uno ($350, $600 o $2,200). Puedes escribir un color nuevo y se guardará automáticamente en el catálogo.',
      },
    },
    {
      element: '#field-edgebanding',
      popover: {
        title: '📏 Cubrecanto',
        description:
          '19mm cuesta $5/metro, 3.5mm cuesta $8/metro. Ingresa los metros y el total se calcula solo.',
      },
    },
    {
      element: '#field-cuts',
      popover: {
        title: '✂️ Cortes',
        description:
          'Aparece solo si el producto es "Con corte". Cada corte cuesta $5. El total se suma al pedido.',
      },
    },
    {
      element: '#field-total',
      popover: {
        title: '💵 Total',
        description:
          'Se calcula automáticamente: (hojas × costo) + cortes + cubrecanto + envío.',
      },
    },
    {
      element: '#field-pdf',
      popover: {
        title: '📎 Archivos adjuntos',
        description:
          'Puedes subir hasta 5 archivos: PDFs o imágenes. Útil para cotizaciones, contratos o fotos del espacio.',
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
      element: '#color-filter-tabs',
      popover: {
        title: '🎨 Filtrar por color',
        description:
          'Filtra tus leads por color: Azul=con corte, Rosa=venta empleado, Naranja=contra entrega, Amarillo=pagado sin entregar, Verde y Morado son manuales.',
      },
    },
    {
      element: '#leads-legend',
      popover: {
        title: '🏷️ Código de colores',
        description:
          'Los colores se asignan automáticamente según el tipo de lead. Puedes cambiarlos manualmente con el círculo de color en la columna Acciones.',
      },
    },
    {
      element: '#leads-table',
      popover: {
        title: '📋 Tabla de leads',
        description:
          'El clip con número abre los archivos adjuntos del lead. El lápiz edita el lead completo. El círculo cambia el color de la fila.',
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
      element: '#tab-choferes',
      popover: {
        title: '🚗 Efectivo de choferes',
        description:
          'Confirma aquí el efectivo que te entregan los choferes después de sus entregas.',
      },
    },
    {
      element: '#tab-validados',
      popover: {
        title: '✅ Validados por contador',
        description:
          'Historial del efectivo que el contador ya recibió y validó de tu parte.',
      },
    },
    {
      element: '#tab-mi-caja',
      popover: {
        title: '💰 Mi caja personal',
        description:
          'Resumen de tu efectivo: ingresos (pagos + choferes) menos lo que ya entregaste al contador = tu saldo actual.',
      },
    },
  ],

  '/contador': [
    {
      popover: {
        title: '💵 Efectivo del administrador',
        description:
          'Ves cuánto efectivo acumulado tiene cada administrador: pagos directos que cobró + efectivo que recibió de choferes.',
      },
    },
    {
      popover: {
        title: '✅ Validar efectivo',
        description:
          'Cuando el admin te entregue su efectivo, presiona "Recibí efectivo de {admin}". Esto registra el egreso de su caja y notifica al admin.',
      },
    },
    {
      popover: {
        title: '📋 Mi historial',
        description:
          'Todas las validaciones que has hecho, con fecha y monto.',
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
