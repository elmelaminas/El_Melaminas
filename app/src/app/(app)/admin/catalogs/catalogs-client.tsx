'use client';

import { useState } from 'react';
import { Users, Layers } from 'lucide-react';
import { SellersTab } from './sellers-tab';
import { ColorsTab } from './colors-tab';

export type SellerRow = {
  id: string;
  name: string;
  phone: string | null;
  profile_id: string | null;
  is_active: boolean;
};

export type ColorRow = {
  id: string;
  name: string;
  is_active: boolean;
  stock_total: number;
  stock_committed: number;
  /** Calculado en page.tsx: `max(0, total - committed)`. */
  stock_available: number;
  stock_minimum: number;
  /** Si `false`, este color no tiene fila en `inventory` — los stocks son 0. */
  has_inventory_row: boolean;
};

type Tab = 'sellers' | 'colors';

export function CatalogsClient({
  initialSellers,
  initialColors,
}: {
  initialSellers: SellerRow[];
  initialColors: ColorRow[];
}) {
  const [tab, setTab] = useState<Tab>('sellers');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Catálogos</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Vendedores y colores de melamina del sistema.
        </p>
      </div>

      <div
        className="flex gap-2"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <TabButton active={tab === 'sellers'} onClick={() => setTab('sellers')}>
          <Users size={16} /> Vendedores
          <span
            className="text-xs"
            style={{
              padding: '2px 8px',
              borderRadius: 9999,
              background: 'var(--bg-subtle)',
              color: 'var(--text-tertiary)',
            }}
          >
            {initialSellers.length}
          </span>
        </TabButton>
        <TabButton active={tab === 'colors'} onClick={() => setTab('colors')}>
          <Layers size={16} /> Colores / Materiales
          <span
            className="text-xs"
            style={{
              padding: '2px 8px',
              borderRadius: 9999,
              background: 'var(--bg-subtle)',
              color: 'var(--text-tertiary)',
            }}
          >
            {initialColors.length}
          </span>
        </TabButton>
      </div>

      {tab === 'sellers' ? (
        <SellersTab initialSellers={initialSellers} />
      ) : (
        <ColorsTab initialColors={initialColors} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 px-4 py-2 text-sm font-medium"
      style={{
        color: active ? 'var(--brand-primary)' : 'var(--text-secondary)',
        borderBottom: active
          ? '2px solid var(--brand-primary)'
          : '2px solid transparent',
        marginBottom: -1,
      }}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
