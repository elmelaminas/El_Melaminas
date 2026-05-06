  
**ESPECIFICACIÓN DE REQUERIMIENTOS DE SOFTWARE**

*(SRS — Software Requirements Specification)*

**EL MELAMINAS**

Sistema Web de Captura de Leads · Pagos · Choferes · Almacén

Versión: 2.0  |  Mayo 2026

Stack: Next.js · Supabase · Stripe

Autor: Sergio — Founder & Operador Técnico

# **1\. Introducción**

## **1.1 Propósito**

Este documento amplía la versión 1.0 del SRS para EL MELAMINAS e incorpora cuatro nuevos módulos operativos: (1) Sistema de autenticación por roles, (2) Módulo de Pagos, (3) Vista de Chofer, y (4) Módulo de Almacén. El objetivo es definir con precisión los requerimientos funcionales, el modelo de datos, las reglas de negocio y los flujos de cada módulo, de forma que puedan servir de guía unívoca para el equipo de desarrollo, QA y los stakeholders de la empresa.

## **1.2 Alcance**

El sistema EL MELAMINAS v2 abarca el ciclo completo de la operación comercial y logística de la empresa: captura de leads (vendedoras), cobro y conciliación (administración), despacho y entrega (choferes), y control de inventario (almacén). Cada perfil de usuario accede exclusivamente a las vistas correspondientes a su rol.

## **1.3 Glosario**

| Término | Definición |
| :---- | :---- |
| Adeudo | Saldo pendiente de pago que el cliente mantiene con la empresa. |
| Anticipo | Pago parcial realizado antes de la entrega del pedido. |
| Liquidación | Pago total que cierra el adeudo del cliente. |
| Clip | Terminal de cobro con tarjeta utilizada por la empresa. |
| Deducible | Gasto o descuento que se resta del monto cobrado antes de registrar el ingreso neto. |
| Stock | Inventario físico de materiales disponibles en almacén. |
| Chofer | Perfil de usuario responsable del traslado y entrega de materiales al cliente. |
| RLS | Row Level Security — control de acceso a nivel de fila en PostgreSQL / Supabase. |
| Soft delete | Eliminación lógica mediante campo deleted\_at; el registro permanece en BD. |

## **1.4 Versiones del documento**

| Versión | Fecha | Autor | Cambios |
| :---- | :---- | :---- | :---- |
| 1.0 | Mayo 2026 | Sergio | SRS inicial: módulo de captura de leads. |
| 2.0 | Mayo 2026 | Sergio | Agrega: Login por roles, Módulo de Pagos, Vista Chofer, Módulo Almacén. |

# **2\. Sistema de Autenticación y Control de Acceso por Roles**

## **2.1 Descripción general**

El sistema contará con un Login único accesible en la ruta raíz de la aplicación (/login). Tras autenticarse con correo y contraseña mediante Supabase Auth, el usuario es redirigido automáticamente a su panel de inicio según el rol asignado. El sistema contempla cinco roles operativos definidos en la tabla profiles.

## **2.2 Roles y vistas autorizadas**

| Rol (enum) | Nombre operativo | Vistas autorizadas |
| :---- | :---- | :---- |
| admin | Administrador / Administrativa | Acceso completo: Dashboard general, Leads, Pagos, Vista Chofer, Almacén, Catálogos, Usuarios, Reportes. |
| seller | Vendedora | Solo Formulario de Captura de Leads (vista principal EL MELAMINAS). |
| driver | Chofer | Solo Vista Chofer: entregas asignadas, saldos, confirmación de entrega. |
| warehouse | Almacén | Solo Vista Almacén: stock, entradas, salidas, historial de movimientos. |
| supervisor | Supervisor | Reportes y dashboards en modo lectura. Sin capacidad de edición. |

## **2.3 Requerimientos funcionales — Autenticación**

### **RF-AUTH-001 — Pantalla de Login**

La ruta /login presentará un formulario con campos de correo electrónico y contraseña. Deberá mostrar mensajes de error claros ante credenciales incorrectas o cuenta inactiva. Incluirá enlace de "¿Olvidaste tu contraseña?" que dispara el flujo de recuperación de Supabase Auth.

### **RF-AUTH-002 — Redirección por rol post-login**

Inmediatamente tras la autenticación, el sistema consultará el campo role de la tabla profiles y redirigirá al usuario a su ruta de inicio predeterminada:

* admin → /dashboard

* seller → /leads/new

* driver → /driver

* warehouse → /warehouse

* supervisor → /reports

### **RF-AUTH-003 — Protección de rutas**

Cada ruta del sistema validará el rol del usuario autenticado mediante middleware (Next.js middleware \+ sesión de Supabase). Si un usuario intenta acceder a una ruta no autorizada para su rol, será redirigido a una página 403 \- Acceso denegado.

### **RF-AUTH-004 — Cierre de sesión**

El botón de cierre de sesión estará disponible en el header de todas las vistas autenticadas. Al ejecutarse destruirá la sesión en cliente y servidor y redirigirá a /login.

### **RF-AUTH-005 — Gestión de usuarios (solo admin)**

Desde /admin/users el administrador podrá: crear nuevos usuarios (nombre, correo, rol, teléfono), activar/desactivar cuentas sin eliminar el historial, y restablecer contraseñas mediante correo de Supabase Auth.

# **3\. Módulo de Pagos**

## **3.1 Descripción general**

La vista de Pagos (/payments/new o accesible desde el detalle de un lead) permite al personal administrativo registrar cobros realizados a clientes. El módulo vincula automáticamente el pago a un lead existente, gestiona anticipos y liquidaciones, captura evidencia fotográfica del cobro y registra deducciones y el chofer asignado al despacho.

## **3.2 Flujo general del módulo**

* El administrativo abre el formulario de nuevo pago.

* Selecciona el lead/cliente desde un buscador con autocompletado.

* El sistema carga automáticamente: nombre del cliente, total de la compra y saldo pendiente (adeudo calculado).

* El administrativo completa los campos del pago y sube la evidencia fotográfica.

* Guarda el registro; el sistema actualiza el saldo del lead en tiempo real.

## **3.3 Campos del formulario de Pagos**

| \# | Campo | Tipo de control | Comportamiento / Validaciones |
| :---- | :---- | :---- | :---- |
| 1 | Buscar lead / cliente | Buscador \+ autocompletado | El usuario escribe nombre, teléfono o ID del lead. Al seleccionar, se autocompletan los campos 2, 3 y 4 automáticamente. |
| 2 | Nombre del cliente | Solo lectura (auto) | Cargado automáticamente del lead seleccionado. No editable. |
| 3 | Total de la compra | Solo lectura (auto) | Cargado del campo total\_amount del lead. Muestra el importe original en MXN. |
| 4 | Adeudo / Saldo pendiente | Solo lectura (calculado) | total\_amount − suma de pagos exitosos previos del lead. Se actualiza en tiempo real cada vez que se elige un lead. |
| 5 | Monto que paga | Numérico decimal | Monto en MXN que el cliente entrega en esta transacción. Obligatorio. Validar: \> 0 y ≤ adeudo actual. |
| 6 | Evidencia fotográfica | Carga de imagen | Permite subir foto del efectivo cobrado o captura de pantalla de la transferencia. Formatos: JPG, PNG, HEIC. Tamaño máx: 10 MB. Se almacena en Supabase Storage. Obligatorio cuando tipo\_pago \= transferencia o clip. |
| 7 | Deducibles | Numérico decimal \+ texto | Campo para ingresar gastos o descuentos que se restan del monto cobrado (ej. gasolina, comisión Clip). Permite agregar múltiples líneas (concepto \+ monto). Opcional. |
| 8 | Método de pago | Desplegable (select) | Opciones: Efectivo, Transferencia, Clip. Obligatorio. |
| 9 | Tipo de pago | Desplegable (select) | Opciones: Anticipo, Liquidación. Obligatorio. Si se elige Liquidación y el monto no cubre el adeudo, el sistema muestra advertencia pero permite continuar. |
| 10 | Chofer asignado | Desplegable (select) | Lista de choferes activos (drivers) obtenida de la tabla profiles. Obligatorio. |

## **3.4 Requerimientos funcionales — Pagos**

### **RF-PAY-001 — Búsqueda de lead con autocompletado**

El campo de búsqueda consultará la tabla leads en tiempo real mientras el usuario escribe (mínimo 2 caracteres). Mostrará hasta 10 resultados con: nombre del cliente, teléfono y fecha del lead. Al seleccionar un resultado, los campos 2, 3 y 4 se completarán automáticamente.

### **RF-PAY-002 — Cálculo automático del adeudo**

El sistema calculará el saldo pendiente como: adeudo \= total\_amount − SUM(payments.amount WHERE status \= 'exitoso' AND lead\_id \= seleccionado). Este valor se mostrará de forma prominente (destacado visualmente) para que el administrativo lo tenga siempre presente.

### **RF-PAY-003 — Carga y almacenamiento de evidencia fotográfica**

La imagen se almacenará en Supabase Storage bajo el bucket payments-evidence con la ruta: {lead\_id}/{payment\_id}/{timestamp}.{ext}. El acceso al bucket será privado; se generará una URL firmada temporal para mostrar la imagen en el detalle del pago.

### **RF-PAY-004 — Registro de deducibles**

El formulario permitirá agregar N líneas de deducibles, cada una con: concepto (texto libre, ej. "Gasolina", "Comisión Clip") y monto (numérico decimal en MXN). El total de deducibles se almacenará en la tabla payment\_deductibles vinculada al pago. El ingreso neto \= monto\_pagado − total\_deducibles.

### **RF-PAY-005 — Actualización de estado del lead**

Al guardar un pago exitoso, el sistema recalculará el campo payment\_status del lead: si adeudo restante \= 0 → 'pagado'; si adeudo \> 0 → 'parcial'; si nunca se ha pagado → 'pendiente'.

### **RF-PAY-006 — Historial de pagos**

La vista /payments mostrará el historial de todos los pagos registrados con filtros por: fecha, cliente, chofer, método de pago, tipo de pago y estado. Disponible para roles admin y supervisor.

# **4\. Vista del Chofer**

## **4.1 Descripción general**

La Vista Chofer (/driver) es una interfaz simplificada y orientada a móvil que muestra al chofer únicamente las entregas que tiene asignadas. Su función principal es gestionar la entrega de materiales, registrar evidencia de cobro cuando haya saldo pendiente y confirmar la entrega al administrativo receptor.

## **4.2 Información mostrada por entrega**

| Dato mostrado | Origen / Descripción |
| :---- | :---- |
| Nombre del cliente | Campo client\_name del lead asociado. |
| Dirección de entrega | Campo address del lead. Incluye botón para abrir la URL de Google Maps en el mapa nativo del dispositivo. |
| Cantidad de materiales | Suma de hojas del lead (sheets\_count) más detalle de colores (lead\_colors). Lista: "5 negras, 6 gris, 2 parota". |
| Adeudo del cliente | Saldo pendiente calculado: total\_amount − pagos exitosos previos. Se muestra en rojo si \> 0\. |
| Saldos pendientes | Resumen de pagos registrados vs. total. Indica si hay anticipo registrado y cuánto falta por cobrar. |
| Estado de la entrega | Uno de: Pendiente, En camino, Entregado. Visible para el chofer y el admin. |

## **4.3 Campos de acción del chofer**

| Campo / Acción | Tipo de control | Descripción |
| :---- | :---- | :---- |
| Fotografía de evidencia | Carga de imagen | Visible únicamente si el adeudo del cliente es \> 0\. El chofer sube foto del efectivo cobrado o del comprobante de transferencia. Obligatorio antes de marcar como entregado si hay saldo. |
| Administrativo receptor | Desplegable (select) | Lista de usuarios con rol admin activos. El chofer selecciona a quién le entrega el efectivo cobrado. Obligatorio si hay saldo pendiente. |
| Botón: Marcar como entregado | Botón de confirmación | Al presionarlo, el sistema registra: timestamp de entrega, administrativo receptor, referencia a la foto de evidencia (si aplica), y actualiza el estado de la entrega a "Entregado". El botón muestra el texto dinámico: "Entregado a \[nombre del admin seleccionado\]". |

## **4.4 Requerimientos funcionales — Chofer**

### **RF-DRV-001 — Lista de entregas del chofer**

La vista /driver mostrará únicamente los leads donde: el campo driver\_id \= usuario autenticado Y el estado de entrega \!= 'Entregado'. Las entregas completadas podrán consultarse en una pestaña de historial paginada.

### **RF-DRV-002 — Visualización de adeudo en tiempo real**

El saldo pendiente del cliente se calculará en el momento de cargar la vista, consultando payments de ese lead. Si el adeudo es cero, la sección de "Cobro pendiente" no se mostrará y el campo de fotografía será opcional.

### **RF-DRV-003 — Evidencia fotográfica obligatoria con saldo**

Si el adeudo \> 0 al momento de marcar como entregado, el sistema validará que exista al menos una fotografía cargada. De lo contrario, bloqueará la acción y mostrará el mensaje: "Debes subir una foto del cobro antes de confirmar la entrega."

### **RF-DRV-004 — Confirmación de entrega con administrativo**

Al confirmar la entrega, el sistema creará un registro en la tabla driver\_deliveries con: driver\_id, lead\_id, admin\_receiver\_id, delivered\_at (timestamp), evidence\_photo\_url, y amount\_collected (si aplica). El estado del lead se actualizará a 'En tránsito → Entregado'.

### **RF-DRV-005 — Notificación al administrativo**

Al marcarse como entregado, el sistema enviará una notificación interna (registro en tabla notifications) al administrativo receptor, informando: nombre del chofer, cliente, monto cobrado y timestamp. Si se integra email, se enviará también un correo de confirmación.

### **RF-DRV-006 — Interfaz optimizada para móvil**

La Vista Chofer estará diseñada prioritariamente para dispositivos móviles (pantalla \< 768 px): botones grandes (mínimo 48 px de alto), fuentes legibles (≥ 16 px), mapa abre en app nativa, carga de foto directamente desde la cámara del dispositivo.

# **5\. Módulo de Almacén**

## **5.1 Descripción general**

El módulo de Almacén (/warehouse) permite al personal de almacén controlar el inventario de materiales de la empresa. Registra entradas (compras o devoluciones de material), salidas (despacho de pedidos al cliente), y ofrece visibilidad en tiempo real del stock disponible por tipo de material y color. Cada vez que se registra un nuevo lead, el sistema descuenta automáticamente el material comprometido del stock disponible.

## **5.2 Conceptos de inventario**

* Stock disponible: cantidad física de material en almacén no comprometida con ningún pedido.

* Stock comprometido: material vinculado a leads con estado pendiente o en tránsito (aún no entregado).

* Stock total: disponible \+ comprometido.

* Movimiento de entrada: ingreso de material nuevo (compra al proveedor, devolución, ajuste).

* Movimiento de salida: despacho de material al cliente vinculado a un lead. También puede ser merma o ajuste negativo.

## **5.3 Vista principal de stock**

La pantalla principal del almacén mostrará una tabla de stock con las siguientes columnas por tipo de material / color:

| Material / Color | Stock total | Disponible | Comprometido | Mínimo | Alerta |
| :---- | :---- | :---- | :---- | :---- | :---- |
| Negra | 120 | 80 | 40 | 20 | — OK |
| Gris | 15 | 5 | 10 | 20 | ⚠ Bajo stock |
| Parota | 0 | 0 | 0 | 10 | 🔴 Sin stock |

Las filas con stock disponible ≤ mínimo configurado se resaltarán visualmente (amarillo: bajo stock, rojo: sin stock). El umbral mínimo es configurable por tipo de material desde el panel admin.

## **5.4 Formulario de ingreso de material (Entrada)**

| \# | Campo | Tipo | Descripción |
| :---- | :---- | :---- | :---- |
| 1 | Tipo de material / Color | Desplegable \+ nuevo | Selección del catálogo colors. Si el material no existe, se puede crear desde aquí. |
| 2 | Cantidad | Numérico entero | Número de hojas o unidades que ingresan. Mínimo 1\. |
| 3 | Proveedor | Texto libre | Nombre del proveedor o fuente del material. Opcional. |
| 4 | Costo unitario | Numérico decimal | Costo por unidad en MXN. Opcional, para referencia de costo de inventario. |
| 5 | Nota / Referencia | Texto libre | Número de factura, remisión u observaciones. Opcional. |
| 6 | Fecha de entrada | Selector de fecha | Por defecto: fecha actual. Editable. |

## **5.5 Historial de movimientos**

La vista de historial mostrará todos los movimientos de inventario (entradas y salidas) en orden cronológico descendente, con filtros por: tipo de movimiento, material/color, fecha y usuario. Cada fila incluirá: fecha, tipo (entrada/salida), material, cantidad, referencia (lead\_id si es salida automática, o nota si es manual) y usuario que registró.

## **5.6 Requerimientos funcionales — Almacén**

### **RF-WH-001 — Descuento automático al registrar un lead**

Cada vez que se guarde un nuevo lead en el formulario principal, el sistema ejecutará automáticamente un descuento de stock comprometido por cada color registrado en lead\_colors. Flujo: lead guardado → por cada fila de lead\_colors → buscar el color\_id en inventory → restar quantity de stock\_committed. Si el stock disponible (total − committed) es insuficiente para algún color, el sistema mostrará una advertencia al vendedor, pero permitirá guardar el lead (el vendedor no bloquea la operación, el almacén gestiona el faltante).

### **RF-WH-002 — Liberación de stock al cancelar o eliminar un lead**

Si un lead es cancelado (soft delete o cambio de estado a 'cancelado'), el sistema revertirá el descuento comprometido correspondiente, restaurando el stock disponible de cada color vinculado.

### **RF-WH-003 — Salida definitiva al marcar entrega del chofer**

Cuando el chofer marca una entrega como 'Entregado', el sistema convertirá el stock comprometido en salida definitiva: stock\_committed − cantidad\_entregada y stock\_total − cantidad\_entregada. Se registrará un movimiento de tipo 'salida' en inventory\_movements vinculado al lead y al driver\_delivery.

### **RF-WH-004 — Formulario de ingreso de material**

El personal de almacén (rol warehouse o admin) podrá registrar entradas de material manualmente. Cada entrada creará un registro en inventory\_movements de tipo 'entrada' y actualizará el stock\_total del material correspondiente en la tabla inventory.

### **RF-WH-005 — Alertas de bajo stock**

El sistema verificará el nivel de stock disponible al cargar la vista de almacén y también después de cada movimiento de salida. Si stock\_available ≤ stock\_minimum para cualquier material, se mostrará una alerta visual en la vista de almacén y se creará una notificación interna para el rol admin.

### **RF-WH-006 — Ajustes manuales de inventario (solo admin)**

El administrador podrá registrar ajustes de inventario positivos o negativos (mermas, correcciones de conteo) con un concepto obligatorio. Estos ajustes se registran en inventory\_movements con tipo 'ajuste'.

# **6\. Modelo de Base de Datos Completo (v2)**

## **6.1 Tablas heredadas de v1**

Las tablas profiles, sellers, colors, leads, lead\_colors y payments permanecen con los cambios y ampliaciones descritos a continuación. Las tablas nuevas se detallan en las secciones 6.2 en adelante.

## **6.2 Cambios en tabla: profiles**

Se agrega el valor 'driver' y 'warehouse' al enum de roles. La tabla ya contemplaba role como enum editable.

| Columna | Tipo | Restricción | Descripción |
| :---- | :---- | :---- | :---- |
| id | uuid | PK, FK auth.users | Identificador del perfil de usuario. |
| full\_name | text | NOT NULL | Nombre completo (aparece en desplegables de choferes y admins). |
| role | enum | NOT NULL | Valores: admin, seller, driver, warehouse, supervisor. |
| phone | text | NULL | Teléfono de contacto. |
| is\_active | boolean | DEFAULT true | Flag de activación de la cuenta. |
| created\_at | timestamptz | DEFAULT now() | Fecha de creación. |
| updated\_at | timestamptz | DEFAULT now() | Última actualización. |

## **6.3 Cambios en tabla: leads**

Se agregan columnas de seguimiento de entrega y vinculación con chofer y estado de almacén.

| Columna nueva | Tipo | Restricción | Descripción |
| :---- | :---- | :---- | :---- |
| driver\_id | uuid | FK profiles, NULL | Chofer asignado al despacho del pedido. |
| delivery\_status | enum | DEFAULT pendiente | Valores: pendiente, en\_transito, entregado, cancelado. |
| payment\_status | enum | DEFAULT pendiente | Valores: pendiente, parcial, pagado, cancelado. |
| stock\_committed | boolean | DEFAULT false | Indica si el material ya fue descontado del inventario. |

## **6.4 Tabla: payments (ampliada)**

| Columna | Tipo | Restricción | Descripción |
| :---- | :---- | :---- | :---- |
| id | uuid | PK | Identificador del pago. |
| lead\_id | uuid | FK leads, NOT NULL | Lead al que se vincula el pago. |
| amount | numeric(12,2) | CHECK \> 0 | Monto bruto cobrado en MXN. |
| net\_amount | numeric(12,2) | NULL | Ingreso neto \= amount − total\_deductibles. |
| payment\_method | enum | NOT NULL | Valores: efectivo, transferencia, clip. |
| payment\_type | enum | NOT NULL | Valores: anticipo, liquidacion. |
| driver\_id | uuid | FK profiles, NULL | Chofer asignado en el momento del cobro. |
| evidence\_photo\_url | text | NULL | URL firmada de la foto en Supabase Storage. |
| status | enum | DEFAULT exitoso | Valores: exitoso, fallido, reembolsado. |
| registered\_by | uuid | FK profiles | Administrativo que registró el pago. |
| paid\_at | timestamptz | DEFAULT now() | Fecha y hora del cobro. |
| created\_at | timestamptz | DEFAULT now() | Fecha de registro en el sistema. |

## **6.5 Tabla: payment\_deductibles**

Almacena las líneas de deducibles (gastos o descuentos) asociadas a cada pago.

| Columna | Tipo | Restricción | Descripción |
| :---- | :---- | :---- | :---- |
| id | uuid | PK | Identificador del deducible. |
| payment\_id | uuid | FK payments, NOT NULL | Pago al que pertenece el deducible. |
| concept | text | NOT NULL | Descripción del deducible (ej. Gasolina, Comisión Clip). |
| amount | numeric(12,2) | CHECK \> 0 | Monto del deducible en MXN. |
| created\_at | timestamptz | DEFAULT now() | Fecha de registro. |

## **6.6 Tabla: driver\_deliveries**

Registra la confirmación formal de cada entrega realizada por el chofer.

| Columna | Tipo | Restricción | Descripción |
| :---- | :---- | :---- | :---- |
| id | uuid | PK | Identificador de la entrega. |
| lead\_id | uuid | FK leads, NOT NULL | Lead entregado. |
| driver\_id | uuid | FK profiles, NOT NULL | Chofer que realizó la entrega. |
| admin\_receiver\_id | uuid | FK profiles, NOT NULL | Administrativo que recibe el efectivo del chofer. |
| amount\_collected | numeric(12,2) | NULL | Efectivo entregado al administrativo (puede ser 0 si ya estaba liquidado). |
| evidence\_photo\_url | text | NULL | Foto del cobro en campo (Supabase Storage). |
| delivered\_at | timestamptz | DEFAULT now() | Timestamp exacto de la confirmación. |
| notes | text | NULL | Observaciones adicionales del chofer. |

## **6.7 Tabla: inventory**

Stock actual por tipo de material / color. Es la tabla de estado vivo del inventario.

| Columna | Tipo | Restricción | Descripción |
| :---- | :---- | :---- | :---- |
| id | uuid | PK | Identificador del registro de inventario. |
| color\_id | uuid | FK colors, UNIQUE | Material / color al que pertenece este stock. Un registro por color. |
| stock\_total | integer | DEFAULT 0, CHECK \>= 0 | Total de unidades físicas en almacén (disponibles \+ comprometidas). |
| stock\_committed | integer | DEFAULT 0, CHECK \>= 0 | Unidades comprometidas con leads pendientes o en tránsito. |
| stock\_available | integer | GENERATED (computed) | stock\_total − stock\_committed. Columna generada por DB. |
| stock\_minimum | integer | DEFAULT 10 | Umbral mínimo configurable para alertas de bajo stock. |
| updated\_at | timestamptz | DEFAULT now() | Última actualización del registro. |

## **6.8 Tabla: inventory\_movements**

Bitácora completa de todos los movimientos de inventario: entradas, salidas y ajustes.

| Columna | Tipo | Restricción | Descripción |
| :---- | :---- | :---- | :---- |
| id | uuid | PK | Identificador del movimiento. |
| color\_id | uuid | FK colors, NOT NULL | Material afectado. |
| movement\_type | enum | NOT NULL | Valores: entrada, salida, compromiso, liberacion, ajuste. |
| quantity | integer | NOT NULL | Cantidad de unidades. Positivo siempre; el tipo determina la dirección. |
| lead\_id | uuid | FK leads, NULL | Lead vinculado si el movimiento es automático por lead. |
| reference | text | NULL | Nota, número de factura, remisión o causa del ajuste. |
| unit\_cost | numeric(12,2) | NULL | Costo unitario para entradas (referencia contable). |
| registered\_by | uuid | FK profiles | Usuario que generó el movimiento. |
| created\_at | timestamptz | DEFAULT now() | Timestamp del movimiento. |

## **6.9 Tabla: notifications**

Centro de notificaciones internas del sistema. Registra alertas para admins y usuarios relevantes.

| Columna | Tipo | Restricción | Descripción |
| :---- | :---- | :---- | :---- |
| id | uuid | PK | Identificador. |
| recipient\_id | uuid | FK profiles | Usuario destinatario. |
| type | text | NOT NULL | Tipo: delivery\_confirmed, low\_stock, payment\_received. |
| message | text | NOT NULL | Texto de la notificación. |
| is\_read | boolean | DEFAULT false | Indica si el usuario ya leyó la notificación. |
| created\_at | timestamptz | DEFAULT now() | Timestamp. |

## **6.10 Diagrama de relaciones (ERD textual)**

| Relación | Cardinalidad |
| :---- | :---- |
| auth.users  ←→  profiles | 1:1 |
| profiles  →  leads (seller\_id) | 1:N — Un vendedor tiene muchos leads |
| profiles  →  leads (driver\_id) | 1:N — Un chofer tiene muchos leads asignados |
| leads  →  lead\_colors | 1:N — Un lead tiene N filas de color |
| lead\_colors  →  colors | N:1 — Muchos lead\_colors apuntan a un color |
| colors  →  inventory | 1:1 — Un color tiene un registro de stock |
| inventory\_movements  →  colors | N:1 — Muchos movimientos por color |
| inventory\_movements  →  leads | N:1 — Opcional: vinculación al lead disparador |
| leads  →  payments | 1:N — Un lead puede tener varios pagos |
| payments  →  payment\_deductibles | 1:N — Un pago puede tener varios deducibles |
| leads  →  driver\_deliveries | 1:1 — Un lead tiene una entrega confirmada |
| profiles (driver)  →  driver\_deliveries | 1:N — Un chofer puede tener muchas entregas |
| profiles (admin)  →  driver\_deliveries (admin\_receiver\_id) | 1:N — Un admin puede recibir de varios choferes |
| notifications  →  profiles | N:1 — Muchas notificaciones por usuario |

# **7\. Seguridad y Políticas RLS por Tabla**

| Tabla | Rol | Política RLS |
| :---- | :---- | :---- |
| leads | seller | SELECT / INSERT / UPDATE: solo leads donde created\_by \= auth.uid(). No DELETE. |
| leads | driver | SELECT: solo leads donde driver\_id \= auth.uid(). |
| leads | warehouse | SELECT: todos los leads. Sin INSERT/UPDATE/DELETE. |
| leads | admin | Acceso total: SELECT, INSERT, UPDATE, DELETE. |
| payments | admin | Acceso total. |
| payments | seller / driver | Sin acceso. |
| payments | supervisor | SELECT únicamente. |
| driver\_deliveries | driver | INSERT donde driver\_id \= auth.uid(). SELECT propio. |
| driver\_deliveries | admin | Acceso total. |
| inventory | warehouse | SELECT \+ UPDATE (cantidad). Sin DELETE. |
| inventory | admin | Acceso total. |
| inventory\_movements | warehouse | SELECT \+ INSERT (solo tipo entrada y ajuste aprobado por admin). |
| inventory\_movements | seller / driver | Sin acceso directo (movimientos generados por triggers del sistema). |
| colors | seller / warehouse | SELECT \+ INSERT (nuevos colores). Sin UPDATE/DELETE. |
| colors | admin | Acceso total. |
| notifications | Todos | SELECT solo registros donde recipient\_id \= auth.uid(). Sin INSERT/DELETE para usuarios. |

# **8\. Arquitectura de Rutas y Navegación**

## **8.1 Mapa de rutas del sistema**

| Ruta | Roles con acceso | Descripción |
| :---- | :---- | :---- |
| /login | Público | Pantalla de inicio de sesión. |
| /dashboard | admin, supervisor | Panel principal con resumen de métricas: leads, pagos, stock, entregas. |
| /leads | admin, supervisor | Listado de todos los leads con filtros. |
| /leads/new | admin, seller | Formulario EL MELAMINAS de captura de lead. |
| /leads/\[id\] | admin, seller\* | Detalle del lead. \*seller solo ve sus propios. |
| /payments | admin, supervisor | Historial de pagos con filtros. |
| /payments/new | admin | Formulario de registro de nuevo pago. |
| /payments/\[id\] | admin, supervisor | Detalle del pago con foto de evidencia. |
| /driver | driver, admin | Vista del chofer: entregas pendientes y confirmación. |
| /driver/history | driver, admin | Historial de entregas del chofer. |
| /warehouse | warehouse, admin | Stock actual por material con alertas. |
| /warehouse/movements | warehouse, admin | Historial de movimientos de inventario. |
| /warehouse/entry | warehouse, admin | Formulario de ingreso de material. |
| /admin/users | admin | Gestión de usuarios y roles. |
| /admin/catalogs | admin | Gestión de colores, vendedores y choferes. |
| /reports | admin, supervisor | Reportes de ventas, pagos e inventario. |
| /403 | Todos | Página de acceso denegado cuando el rol no tiene permiso. |

## **8.2 Stack tecnológico completo**

| Capa | Tecnología |
| :---- | :---- |
| Framework frontend | Next.js 15+ con App Router y TypeScript. |
| Estilos | Tailwind CSS \+ shadcn/ui \+ lucide-react. |
| Formularios / Validación | react-hook-form \+ Zod. |
| Backend / Auth / DB / Storage | Supabase: PostgreSQL, Auth, Storage, Edge Functions, Realtime. |
| Pagos | Stripe Checkout MXN \+ webhooks vía Supabase Edge Functions. |
| Almacenamiento de fotos | Supabase Storage (buckets: payments-evidence, driver-evidence). |
| Hosting | Vercel (frontend) \+ Supabase (backend gestionado). |
| Control de versiones | GitHub con Conventional Commits. |
| Notificaciones internas | Supabase Realtime suscripciones en tabla notifications. |

# **9\. Plan de Implementación — Sprints v2**

| Sprint | Módulo principal | Entregables clave |
| :---- | :---- | :---- |
| Sprint 1 | Fundación \+ Auth | Proyecto Next.js \+ Supabase configurado. Esquema de BD completo con migraciones y RLS. Login funcional con redirección por rol. |
| Sprint 2 | Leads (v1 mejorada) | Formulario EL MELAMINAS completo. Persistencia de leads y lead\_colors. Descuento automático de stock al guardar lead. Catálogo dinámico de colores. |
| Sprint 3 | Módulo de Pagos | Formulario de pagos con autocompletado. Carga de foto a Supabase Storage. Deducibles. Actualización automática de saldo del lead. |
| Sprint 4 | Vista Chofer | Lista de entregas por chofer. Confirmación de entrega con foto y admin receptor. Notificación interna al admin. Actualización de stock en entrega. |
| Sprint 5 | Módulo Almacén | Vista de stock con alertas. Formulario de ingreso de material. Historial de movimientos. Ajustes manuales admin. |
| Sprint 6 | Admin \+ Reportes | Gestión de usuarios y roles. Catálogos. Dashboard de métricas. Reportes exportables. |
| Sprint 7 | QA \+ Producción | Pruebas integrales de todos los flujos. Optimización de rendimiento. Despliegue productivo. Capacitación al equipo. |

## **9.1 Criterios de aceptación globales v2**

* Login funcional con redirección correcta para cada uno de los 5 roles.

* Formulario de leads captura, valida y persiste todos los campos definidos con descuento de stock automático.

* Módulo de pagos calcula adeudo correctamente, almacena evidencia fotográfica y actualiza estado del lead.

* Vista chofer muestra únicamente sus entregas, permite subir foto y marcar como entregado con admin receptor.

* Almacén refleja en tiempo real entradas, salidas y compromisos. Alertas de bajo stock activas.

* Políticas RLS impiden que un rol acceda a datos de otro rol (validado con usuarios de prueba por rol).

* Aplicación carga en menos de 3 segundos en conexión 4G en dispositivos móviles.

## **9.2 Riesgos identificados v2**

| Riesgo | Probabilidad | Impacto | Mitigación |
| :---- | :---- | :---- | :---- |
| Chofer sin conectividad al confirmar entrega. | Media | Alto | Modo offline parcial con sincronización al recuperar señal (Progressive Web App). |
| Fotos de evidencia de tamaño excesivo congestionan Storage. | Media | Medio | Comprimir imágenes en cliente antes de subir (max 1 MB post-compresión). |
| Descuento de stock incorrecto si el lead se edita después de guardarse. | Media | Alto | Trigger en DB que recalcula el compromiso de stock en cada UPDATE de lead\_colors. |
| Conflicto de acceso si un lead cambia de chofer después de asignado. | Baja | Medio | Solo admin puede reasignar chofer; el sistema libera el lead de la vista del chofer anterior. |
| Adopción baja del módulo por parte de choferes no familiarizados con apps. | Media | Alto | UX ultra-simplificado, pantalla de 3 pasos, botones grandes, capacitación inicial. |

*— Fin del documento SRS v2.0 — EL MELAMINAS —*