/* ═══════════════════════════════════════════
   BADGES — helpers de presentación
   ═══════════════════════════════════════════ */

import type {
  Channel,
  DeliveryStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
  Role,
  StockStatus,
} from '@/data/mock';

const CHANNEL_BADGE: Record<Channel, string> = {
  TIKTOK: 'badge badge-purple',
  WHATSAPP: 'badge badge-success',
  GOOGLE: 'badge badge-info',
  TIENDA: 'badge badge-orange',
};
const CHANNEL_LABEL: Record<Channel, string> = {
  TIKTOK: 'TikTok',
  WHATSAPP: 'WhatsApp',
  GOOGLE: 'Google',
  TIENDA: 'Tienda',
};

export function ChannelBadge({ channel }: { channel: Channel }) {
  return <span className={CHANNEL_BADGE[channel]}>{CHANNEL_LABEL[channel]}</span>;
}

const DELIVERY_BADGE: Record<DeliveryStatus, string> = {
  pendiente: 'badge badge-neutral',
  en_transito: 'badge badge-info',
  entregado: 'badge badge-success',
  cancelado: 'badge badge-danger',
};
const DELIVERY_LABEL: Record<DeliveryStatus, string> = {
  pendiente: 'Pendiente',
  en_transito: 'En tránsito',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};

export function DeliveryBadge({ status }: { status: DeliveryStatus }) {
  return <span className={DELIVERY_BADGE[status]}>{DELIVERY_LABEL[status]}</span>;
}

const PAYMENT_BADGE: Record<PaymentStatus, string> = {
  pendiente: 'badge badge-danger',
  parcial: 'badge badge-warning',
  pagado: 'badge badge-success',
  cancelado: 'badge badge-neutral',
};
const PAYMENT_LABEL: Record<PaymentStatus, string> = {
  pendiente: 'Pendiente',
  parcial: 'Parcial',
  pagado: 'Pagado',
  cancelado: 'Cancelado',
};

export function PaymentBadge({ status }: { status: PaymentStatus }) {
  return <span className={PAYMENT_BADGE[status]}>{PAYMENT_LABEL[status]}</span>;
}

const METHOD_BADGE: Record<PaymentMethod, string> = {
  Efectivo: 'badge badge-success',
  Transferencia: 'badge badge-info',
  Clip: 'badge badge-purple',
};
export function MethodBadge({ method }: { method: PaymentMethod }) {
  return <span className={METHOD_BADGE[method]}>{method}</span>;
}

const TYPE_BADGE: Record<PaymentType, string> = {
  Anticipo: 'badge badge-warning',
  Liquidación: 'badge badge-success',
};
export function TypeBadge({ type }: { type: PaymentType }) {
  return <span className={TYPE_BADGE[type]}>{type}</span>;
}

const STOCK_BADGE: Record<StockStatus, string> = {
  ok: 'badge badge-success',
  warning: 'badge badge-warning',
  danger: 'badge badge-danger',
};
const STOCK_LABEL: Record<StockStatus, string> = {
  ok: 'OK',
  warning: 'Bajo',
  danger: 'Sin stock',
};
export function StockBadge({ status }: { status: StockStatus }) {
  return <span className={STOCK_BADGE[status]}>{STOCK_LABEL[status]}</span>;
}

const ROLE_BADGE: Record<Role, string> = {
  admin: 'badge badge-primary',
  seller: 'badge badge-success',
  driver: 'badge badge-purple',
  warehouse: 'badge badge-orange',
  supervisor: 'badge badge-neutral',
};
const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrador',
  seller: 'Vendedor',
  driver: 'Chofer',
  warehouse: 'Almacén',
  supervisor: 'Supervisor',
};
export function RoleBadge({ role }: { role: Role }) {
  return <span className={ROLE_BADGE[role]}>{ROLE_LABEL[role]}</span>;
}
