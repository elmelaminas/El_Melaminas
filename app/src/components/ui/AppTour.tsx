'use client';

/**
 * Tour guiado interactivo de la app usando driver.js.
 *
 * Exporta:
 *   - `startTour(role)`: dispara el tour con los pasos del rol.
 *     Llamarla desde el botón "?" del Header.
 *   - `useAutoStartTour(role)`: hook que dispara el tour la PRIMERA
 *     vez que el usuario entra (gate por localStorage). Llamarlo
 *     desde un client component que tenga acceso al rol (AppShell).
 *
 * Diseño:
 *   - Cada rol tiene su propio set de pasos. Pasos con `element` SELECTOR
 *     se anclan al DOM; pasos sin element se muestran centrados en
 *     pantalla (driver.js los maneja nativo).
 *   - Si un `element` no se encuentra al iniciar el tour (la página
 *     actual no tiene ese nav item visible para el rol), driver.js
 *     loguea un warning y salta el paso — UX aceptable.
 *   - El CSS de driver.js se importa acá; Next 16 lo bundlea
 *     correctamente en el client chunk.
 *
 * Limitaciones conocidas:
 *   - Los pasos basados en selectores del sidebar requieren que el
 *     drawer esté visible. En mobile el sidebar está colapsado; el
 *     tour funciona mejor en desktop. (Mejora futura: forzar abrir
 *     el drawer antes de iniciar.)
 */

import { driver, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { useEffect } from 'react';
import type { Role } from '@/data/mock';

/** Clave de localStorage que marca "el usuario ya vio el tour".
 *  Cambiar este valor (ej. `em_tour_completed_v2`) fuerza a TODOS los
 *  usuarios a volver a ver el tour — útil cuando hay cambios grandes. */
const STORAGE_KEY = 'em_tour_completed';

/**
 * Step con shape compatible con driver.js v1.x. La librería tipa los
 * pasos como `DriveStep`; nosotros usamos un subset (element opcional
 * + popover {title, description}) que es suficiente para todos los
 * casos del proyecto.
 */
type Step = {
  element?: string;
  popover: { title: string; description: string };
};

/** Pasos por rol. Cada array es una secuencia lineal. */
const STEPS_BY_ROLE: Readonly<Record<Role, Step[]>> = {
  admin: [
    {
      element: '#nav-dashboard',
      popover: {
        title: '📊 Dashboard',
        description:
          'Aquí ves las métricas del mes: leads, cobros, efectivo validado, entregas pendientes y stock bajo. Puedes filtrar por mes y año.',
      },
    },
    {
      element: '#nav-leads',
      popover: {
        title: '📋 Leads',
        description:
          'Lista de todos los pedidos. Las filas tienen colores: Rosa=venta empleado, Naranja=contra entrega, Amarillo=pagado sin entregar, Azul=con corte. Puedes asignar colores manualmente.',
      },
    },
    {
      element: '#nav-nuevo-lead',
      popover: {
        title: '➕ Nuevo Lead',
        description:
          'Captura un nuevo pedido: canal, vendedor, cliente, hojas, colores, cubrecanto, cortes, dirección y adjunta un PDF si tienes cotización.',
      },
    },
    {
      element: '#nav-pagos',
      popover: {
        title: '💳 Pagos',
        description:
          'Historial de todos los cobros. Puedes ver la evidencia fotográfica de cada transferencia haciendo clic en el ícono de cámara.',
      },
    },
    {
      element: '#nav-registrar-pago',
      popover: {
        title: '💰 Registrar Pago',
        description:
          'Registra un cobro: busca el cliente, ingresa el monto, método de pago y sube la foto del comprobante.',
      },
    },
    {
      element: '#nav-entregas',
      popover: {
        title: '🚚 Entregas',
        description:
          'Vista de todas las entregas. Aquí asignas la ruta del día a los choferes, ves faltantes reportados y puedes devolver stock si no se pudo entregar.',
      },
    },
    {
      element: '#nav-stock',
      popover: {
        title: '📦 Stock',
        description:
          'Control de inventario por color/material. Las filas amarillas tienen stock bajo, las rojas están sin stock.',
      },
    },
    {
      element: '#nav-usuarios',
      popover: {
        title: '👥 Usuarios',
        description:
          'Gestión del equipo: crea vendedores, choferes, almacenistas y contadores. Puedes activar/desactivar y editar su rol.',
      },
    },
    {
      element: '#nav-catalogos',
      popover: {
        title: '📚 Catálogos',
        description:
          'Administra los vendedores y los colores/materiales disponibles en el sistema.',
      },
    },
    {
      element: '#nav-caja',
      popover: {
        title: '💵 Validar Caja',
        description:
          'Valida el efectivo que el contador recibió de los choferes. Tab "Por validar" muestra lo pendiente, "Validados" el historial.',
      },
    },
    {
      element: '#tour-btn',
      popover: {
        title: '❓ Ayuda',
        description:
          '¡Este botón! Presiona aquí cuando quieras volver a ver el recorrido de la app.',
      },
    },
  ],

  seller: [
    {
      element: '#nav-nuevo-lead',
      popover: {
        title: '➕ Nuevo Lead',
        description:
          'Captura un nuevo pedido del cliente: canal de origen, datos del cliente, hojas, colores y detalles del pedido.',
      },
    },
    {
      element: '#nav-leads',
      popover: {
        title: '📋 Mis Leads',
        description:
          'Aquí ves todos los pedidos que has registrado con su estado de entrega y pago.',
      },
    },
  ],

  driver: [
    {
      element: '.driver-banner',
      popover: {
        title: '📦 Entregas del día',
        description:
          'Aquí ves cuántas entregas tienes programadas para hoy.',
      },
    },
    {
      popover: {
        title: '🗺️ Ruta secuencial',
        description:
          'El admin te asigna las entregas en orden. Verás una a la vez con el contador "Entrega 1 de N".',
      },
    },
    {
      popover: {
        title: '✅ Confirmar entrega',
        description:
          'Al entregar, presiona el botón de confirmación. Si el cliente tiene saldo pendiente, debes subir foto del cobro.',
      },
    },
    {
      popover: {
        title: '⚠️ No pude entregar',
        description:
          'Si no puedes entregar, selecciona esta opción, describe el motivo y toma foto del lugar. El admin recibirá una notificación.',
      },
    },
  ],

  warehouse: [
    {
      element: '#nav-stock',
      popover: {
        title: '📦 Stock',
        description:
          'Vista principal del inventario. Filas amarillas = stock bajo, rojas = sin stock.',
      },
    },
    {
      element: '#nav-registrar-entrada',
      popover: {
        title: '➕ Registrar Entrada',
        description:
          'Cuando llegue material nuevo, regístralo aquí con la cantidad y costo unitario.',
      },
    },
    {
      popover: {
        title: '✅ Marcar salida',
        description:
          'Cuando prepares material para entrega, márcalo como salida para actualizar el inventario.',
      },
    },
  ],

  supervisor: [
    {
      element: '#nav-dashboard',
      popover: {
        title: '📊 Dashboard',
        description:
          'Como supervisor ves las métricas globales del mes: cobros, efectivo validado, entregas pendientes y stock bajo.',
      },
    },
    {
      element: '#tour-btn',
      popover: {
        title: '❓ Ayuda',
        description:
          'Presiona este botón cuando quieras revisar de nuevo el recorrido.',
      },
    },
  ],

  contador: [
    {
      element: '#nav-contador',
      popover: {
        title: '💵 Caja',
        description:
          'Aquí ves el efectivo que traen los choferes. Selecciona el chofer y presiona "Recibí efectivo" cuando te entregue el dinero.',
      },
    },
    {
      popover: {
        title: '📋 Historial',
        description:
          'En la sección de historial puedes ver todas tus recepciones anteriores y si ya fueron validadas por el admin.',
      },
    },
  ],
};

/** Marca el tour como completado en localStorage. Idempotente. */
function markTourCompleted(): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, 'true');
  } catch (e) {
    // localStorage puede fallar en modo privado / cookies bloqueadas.
    // Loguamos y seguimos — el tour habrá funcionado igual, solo que
    // volverá a auto-iniciarse en la próxima sesión.
    console.warn('[AppTour] no se pudo guardar el flag de completado:', e);
  }
}

/** Lee el flag de completado. true si ya se vio. */
function hasTourBeenCompleted(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Inicia el tour para el rol dado. Si la role no tiene pasos
 * definidos (raro: contador/supervisor están cubiertos), no hace
 * nada. Tras completarse o cancelarse, marca el flag en localStorage
 * — así el auto-start del próximo arranque no vuelve a dispararlo.
 *
 * Se puede invocar libremente desde el botón "?" — siempre arranca
 * un tour nuevo aunque ya esté marcado como completado.
 */
export function startTour(role: Role): void {
  const steps = STEPS_BY_ROLE[role];
  if (!steps || steps.length === 0) return;

  let instance: Driver | null = null;
  try {
    instance = driver({
      showProgress: true,
      // Labels en español (default en inglés).
      nextBtnText: 'Siguiente →',
      prevBtnText: '← Anterior',
      doneBtnText: '¡Listo!',
      progressText: 'Paso {{current}} de {{total}}',
      // Highlighter levemente más suave que el default — el overlay
      // del default es muy oscuro y compite con los popovers.
      overlayColor: 'rgba(15, 23, 42, 0.5)',
      // Cierra el tour cuando se hace click fuera del popover/elemento
      // resaltado — UX más permisiva.
      allowClose: true,
      steps,
      onDestroyed: () => {
        markTourCompleted();
      },
    });
    instance.drive();
  } catch (err) {
    console.error('[AppTour] error al iniciar:', err);
    if (instance) {
      try {
        instance.destroy();
      } catch {
        /* swallow */
      }
    }
  }
}

/**
 * Hook que auto-inicia el tour la primera vez que el usuario carga
 * la app autenticada. Una vez completado (o cerrado), guarda flag en
 * localStorage y no vuelve a dispararse hasta que el flag se borre.
 *
 * Delay corto para que el sidebar / header ya estén montados cuando
 * driver.js intente resolver los selectores. Sin el delay, los pasos
 * basados en `#nav-*` fallarían al iniciar.
 */
export function useAutoStartTour(role: Role): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (hasTourBeenCompleted()) return;
    // 500ms ≈ tiempo para que React monte sidebar/header y el browser
    // pinte. Más corto puede fallar resolviendo selectores; más largo
    // se siente lento.
    const t = window.setTimeout(() => {
      startTour(role);
    }, 500);
    return () => {
      window.clearTimeout(t);
    };
    // Solo nos importa el rol del primer render. Si el usuario cambia
    // de rol con el override del DemoContext durante la sesión, no
    // re-disparamos el tour — sería invasivo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
