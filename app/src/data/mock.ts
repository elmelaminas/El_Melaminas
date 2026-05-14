/* ═══════════════════════════════════════════
   DATOS MOCK — EL MELAMINAS
   Fuente única de verdad para el prototipo visual.
   Sin Supabase: todos los datos viven aquí.
   ═══════════════════════════════════════════ */

export type Role = 'admin' | 'admin2' | 'seller' | 'driver' | 'warehouse' | 'supervisor' | 'contador';

export interface MockUser {
  id: string;
  name: string;
  role: Role;
  email: string;
  phone?: string;
  active?: boolean;
}

export interface ColorQty {
  qty: number;
  color: string;
}

export type Channel = 'WHATSAPP' | 'TIKTOK' | 'GOOGLE' | 'TIENDA';
export type SalePlace = 'Online' | 'En Fábrica';
export type SaleType =
  | 'Primer Contacto'
  | 'Recompra'
  | 'Seguimiento'
  | 'Venta Empleado';
export type PurchaseType = 'A Domicilio' | 'En Fábrica';
export type ProductType = 'Con Corte' | 'Sin Corte';
export type DeliveryStatus = 'pendiente' | 'en_transito' | 'entregado' | 'cancelado';
export type PaymentStatus = 'pendiente' | 'parcial' | 'pagado' | 'cancelado';

export interface MockLead {
  id: string;
  client_name: string;
  channel: Channel;
  seller: string;
  sheets_count: number;
  colors: ColorQty[];
  address: string;
  phone: string;
  cost_per_sheet: number;
  sale_place: SalePlace;
  sale_type: SaleType;
  sale_date: string;
  purchase_type: PurchaseType;
  product_type: ProductType;
  total_amount: number;
  delivery_status: DeliveryStatus;
  payment_status: PaymentStatus;
  driver: string | null;
  adeudo: number;
}

export type PaymentMethod = 'Efectivo' | 'Transferencia' | 'Clip';
export type PaymentType = 'Anticipo' | 'Liquidación' | 'Contra entrega';

export interface Deductible {
  concept: string;
  amount: number;
}

export interface MockPayment {
  id: string;
  lead_id: string;
  client_name: string;
  amount: number;
  net_amount: number;
  method: PaymentMethod;
  type: PaymentType;
  driver: string;
  deductibles: Deductible[];
  status: 'exitoso' | 'pendiente' | 'rechazado';
  date: string;
}

export type StockStatus = 'ok' | 'warning' | 'danger';

export interface MockInventory {
  color: string;
  stock_total: number;
  stock_committed: number;
  stock_available: number;
  stock_minimum: number;
  status: StockStatus;
}

export interface MockDelivery {
  id: string;
  client_name: string;
  address: string;
  maps_url: string;
  colors: ColorQty[];
  total_amount: number;
  adeudo: number;
  payment_status: PaymentStatus;
  delivery_status: DeliveryStatus;
}

export interface MockMovement {
  id: string;
  date: string;
  type: 'Entrada' | 'Salida' | 'Ajuste';
  material: string;
  quantity: number;
  reference: string;
  user: string;
}

export interface MockSeller {
  id: string;
  name: string;
  phone: string;
  linked_user: boolean;
  active: boolean;
}

export interface MockColorCatalog {
  id: string;
  name: string;
  current_stock: number;
  active: boolean;
}

/* ── Usuarios ── */
export const mockUsers: MockUser[] = [
  { id: '1', name: 'Sergio Granados', role: 'admin',      email: 'sergio@elmelaminas.com',  phone: '5511110001', active: true },
  { id: '2', name: 'Ana López',       role: 'seller',     email: 'ana@elmelaminas.com',     phone: '5511110002', active: true },
  { id: '3', name: 'Carlos Ramírez',  role: 'driver',     email: 'carlos@elmelaminas.com',  phone: '5511110003', active: true },
  { id: '4', name: 'Pedro Méndez',    role: 'warehouse',  email: 'pedro@elmelaminas.com',   phone: '5511110004', active: true },
  { id: '5', name: 'Laura Vega',      role: 'supervisor', email: 'laura@elmelaminas.com',   phone: '5511110005', active: true },
  { id: '6', name: 'Javier Torres',   role: 'seller',     email: 'javier@elmelaminas.com',  phone: '5511110006', active: false },
  { id: '7', name: 'Mónica Castillo', role: 'contador',   email: 'monica@elmelaminas.com',  phone: '5511110007', active: true },
];

/* ── Leads ── */
export const mockLeads: MockLead[] = [
  { id: 'L001', client_name: 'Juan Pérez García',  channel: 'WHATSAPP', seller: 'Ana López', sheets_count: 13, colors: [{qty:5,color:'Negra'},{qty:6,color:'Gris'},{qty:2,color:'Parota'}],   address: 'Calle Roble 45, Col. Centro, CDMX',     phone: '5512345678', cost_per_sheet: 750, sale_place: 'Online',     sale_type: 'Primer Contacto', sale_date: '2026-05-05', purchase_type: 'A Domicilio', product_type: 'Con Corte', total_amount: 9750,  delivery_status: 'pendiente',   payment_status: 'parcial',   driver: 'Carlos Ramírez', adeudo: 4875 },
  { id: 'L002', client_name: 'María Fernández',    channel: 'TIKTOK',   seller: 'Ana López', sheets_count: 8,  colors: [{qty:4,color:'Blanca'},{qty:4,color:'Nogal'}],                       address: 'Av. Insurgentes 230, Col. Roma, CDMX',  phone: '5598765432', cost_per_sheet: 650, sale_place: 'En Fábrica', sale_type: 'Recompra',        sale_date: '2026-05-04', purchase_type: 'En Fábrica',  product_type: 'Sin Corte', total_amount: 5200,  delivery_status: 'entregado',   payment_status: 'pagado',    driver: 'Carlos Ramírez', adeudo: 0    },
  { id: 'L003', client_name: 'Roberto Sánchez',    channel: 'GOOGLE',   seller: 'Ana López', sheets_count: 20, colors: [{qty:10,color:'Negra'},{qty:5,color:'Wengue'},{qty:5,color:'Gris'}], address: 'Calle Pino 12, Tlalpan, CDMX',          phone: '5511223344', cost_per_sheet: 600, sale_place: 'Online',     sale_type: 'Seguimiento',     sale_date: '2026-05-03', purchase_type: 'A Domicilio', product_type: 'Con Corte', total_amount: 12000, delivery_status: 'en_transito', payment_status: 'parcial',   driver: 'Carlos Ramírez', adeudo: 6000 },
  { id: 'L004', client_name: 'Sofía Martínez',     channel: 'TIENDA',   seller: 'Ana López', sheets_count: 5,  colors: [{qty:3,color:'Blanca'},{qty:2,color:'Parota'}],                      address: 'Blvd. Adolfo López 88, Coyoacán',       phone: '5544332211', cost_per_sheet: 750, sale_place: 'En Fábrica', sale_type: 'Venta Empleado',  sale_date: '2026-05-05', purchase_type: 'En Fábrica',  product_type: 'Sin Corte', total_amount: 3750,  delivery_status: 'pendiente',   payment_status: 'pendiente', driver: null,             adeudo: 3750 },
  { id: 'L005', client_name: 'Diego Hernández',    channel: 'WHATSAPP', seller: 'Ana López', sheets_count: 15, colors: [{qty:8,color:'Gris'},{qty:7,color:'Nogal'}],                         address: 'Calle Cedro 55, Azcapotzalco',          phone: '5566778899', cost_per_sheet: 650, sale_place: 'Online',     sale_type: 'Recompra',        sale_date: '2026-05-02', purchase_type: 'A Domicilio', product_type: 'Con Corte', total_amount: 9750,  delivery_status: 'entregado',   payment_status: 'pagado',    driver: 'Carlos Ramírez', adeudo: 0    },
];

/* ── Pagos ── */
export const mockPayments: MockPayment[] = [
  { id: 'P001', lead_id: 'L001', client_name: 'Juan Pérez García', amount: 4875, net_amount: 4695, method: 'Transferencia', type: 'Anticipo',    driver: 'Carlos Ramírez', deductibles: [{concept:'Gasolina', amount:180}],          status: 'exitoso', date: '2026-05-05' },
  { id: 'P002', lead_id: 'L002', client_name: 'María Fernández',   amount: 5200, net_amount: 5200, method: 'Efectivo',      type: 'Liquidación', driver: 'Carlos Ramírez', deductibles: [],                                          status: 'exitoso', date: '2026-05-04' },
  { id: 'P003', lead_id: 'L003', client_name: 'Roberto Sánchez',   amount: 6000, net_amount: 5750, method: 'Clip',          type: 'Anticipo',    driver: 'Carlos Ramírez', deductibles: [{concept:'Comisión Clip', amount:250}],     status: 'exitoso', date: '2026-05-03' },
  { id: 'P004', lead_id: 'L005', client_name: 'Diego Hernández',   amount: 9750, net_amount: 9750, method: 'Efectivo',      type: 'Liquidación', driver: 'Carlos Ramírez', deductibles: [],                                          status: 'exitoso', date: '2026-05-02' },
];

/* ── Inventario ── */
export const mockInventory: MockInventory[] = [
  { color: 'Negra',  stock_total: 120, stock_committed: 40, stock_available: 80, stock_minimum: 20, status: 'ok'      },
  { color: 'Gris',   stock_total: 25,  stock_committed: 20, stock_available: 5,  stock_minimum: 20, status: 'warning' },
  { color: 'Blanca', stock_total: 60,  stock_committed: 10, stock_available: 50, stock_minimum: 15, status: 'ok'      },
  { color: 'Parota', stock_total: 8,   stock_committed: 8,  stock_available: 0,  stock_minimum: 10, status: 'danger'  },
  { color: 'Nogal',  stock_total: 35,  stock_committed: 14, stock_available: 21, stock_minimum: 15, status: 'ok'      },
  { color: 'Wengue', stock_total: 18,  stock_committed: 5,  stock_available: 13, stock_minimum: 20, status: 'warning' },
];

/* ── Entregas (chofer) ── */
export const mockDeliveries: MockDelivery[] = [
  { id: 'L001', client_name: 'Juan Pérez García', address: 'Calle Roble 45, Col. Centro, CDMX',  maps_url: '#', colors: [{qty:5,color:'Negra'},{qty:6,color:'Gris'},{qty:2,color:'Parota'}],   total_amount: 9750,  adeudo: 4875, payment_status: 'parcial', delivery_status: 'pendiente'   },
  { id: 'L003', client_name: 'Roberto Sánchez',   address: 'Calle Pino 12, Tlalpan, CDMX',       maps_url: '#', colors: [{qty:10,color:'Negra'},{qty:5,color:'Wengue'},{qty:5,color:'Gris'}], total_amount: 12000, adeudo: 6000, payment_status: 'parcial', delivery_status: 'en_transito' },
];

/* ── Movimientos de inventario ── */
export const mockMovements: MockMovement[] = [
  { id: 'M001', date: '2026-05-05 14:32', type: 'Salida',  material: 'Negra',  quantity: -5,  reference: 'Lead L001', user: 'Pedro Méndez'  },
  { id: 'M002', date: '2026-05-05 14:32', type: 'Salida',  material: 'Gris',   quantity: -6,  reference: 'Lead L001', user: 'Pedro Méndez'  },
  { id: 'M003', date: '2026-05-05 11:10', type: 'Entrada', material: 'Blanca', quantity: 30,  reference: 'OC-2026-082', user: 'Pedro Méndez'},
  { id: 'M004', date: '2026-05-04 16:48', type: 'Salida',  material: 'Nogal',  quantity: -4,  reference: 'Lead L002', user: 'Pedro Méndez'  },
  { id: 'M005', date: '2026-05-04 09:00', type: 'Ajuste',  material: 'Parota', quantity: -2,  reference: 'Merma',     user: 'Pedro Méndez'  },
  { id: 'M006', date: '2026-05-03 18:20', type: 'Salida',  material: 'Wengue', quantity: -5,  reference: 'Lead L003', user: 'Pedro Méndez'  },
  { id: 'M007', date: '2026-05-03 12:05', type: 'Entrada', material: 'Negra',  quantity: 50,  reference: 'OC-2026-081', user: 'Pedro Méndez'},
  { id: 'M008', date: '2026-05-02 17:45', type: 'Salida',  material: 'Gris',   quantity: -8,  reference: 'Lead L005', user: 'Pedro Méndez'  },
];

/* ── Vendedores (catálogo) ── */
export const mockSellers: MockSeller[] = [
  { id: 'S1', name: 'Ana López',       phone: '5511110002', linked_user: true,  active: true  },
  { id: 'S2', name: 'Javier Torres',   phone: '5511110006', linked_user: true,  active: false },
  { id: 'S3', name: 'Mariana Rojas',   phone: '5511110007', linked_user: false, active: true  },
  { id: 'S4', name: 'Erick Salazar',   phone: '5511110008', linked_user: false, active: true  },
];

/* ── Colores (catálogo) — derivado de inventario ── */
export const mockColorCatalog: MockColorCatalog[] = mockInventory.map((m, i) => ({
  id: `C${i + 1}`,
  name: m.color,
  current_stock: m.stock_total,
  active: true,
}));

/* ── Constantes para selects ── */
export const COLORS_LIST = ['Negra', 'Gris', 'Blanca', 'Parota', 'Nogal', 'Wengue'] as const;
export const COST_PER_SHEET_OPTIONS = [750, 650, 600] as const;
export const CHANNELS: Channel[] = ['WHATSAPP', 'TIKTOK', 'GOOGLE', 'TIENDA'];
export const SALE_TYPES: SaleType[] = ['Primer Contacto', 'Recompra', 'Seguimiento', 'Venta Empleado'];
export const PAYMENT_METHODS: PaymentMethod[] = ['Efectivo', 'Transferencia', 'Clip'];
export const PAYMENT_TYPES: PaymentType[] = ['Anticipo', 'Liquidación'];

/* ── Utilidades de formato ── */
export const formatMXN = (n: number): string =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 0 }).format(n);

export const roleLabel = (r: Role): string =>
  ({
    admin: 'Administrador',
    admin2: 'Administrador 2',
    seller: 'Vendedor',
    driver: 'Chofer',
    warehouse: 'Almacén',
    supervisor: 'Supervisor',
    contador: 'Contador',
  }[r]);
