'use client';

import Link from 'next/link';
import { Plus, Search, Eye, Pencil, ChevronLeft, ChevronRight } from 'lucide-react';
import { mockLeads, formatMXN } from '@/data/mock';
import { ChannelBadge, DeliveryBadge, PaymentBadge } from '@/components/ui/Badges';

export default function LeadsPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Leads</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {mockLeads.length} leads registrados — gestiona pedidos, entregas y pagos.
          </p>
        </div>
        <Link href="/leads/new" className="btn btn-primary">
          <Plus size={16} /> Nuevo Lead
        </Link>
      </div>

      {/* Filters */}
      <div className="card p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="lg:col-span-2 relative">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--text-tertiary)' }}
            />
            <input
              placeholder="Buscar por nombre o teléfono…"
              className="input"
              style={{ paddingLeft: 36 }}
            />
          </div>
          <select className="select" defaultValue="">
            <option value="">Todos los canales</option>
            <option>WhatsApp</option>
            <option>TikTok</option>
            <option>Google</option>
            <option>Tienda</option>
          </select>
          <select className="select" defaultValue="">
            <option value="">Vendedora</option>
            <option>Ana López</option>
            <option>Javier Torres</option>
          </select>
          <div className="grid grid-cols-2 gap-2">
            <select className="select" defaultValue="">
              <option value="">Entrega</option>
              <option>Pendiente</option>
              <option>En tránsito</option>
              <option>Entregado</option>
            </select>
            <select className="select" defaultValue="">
              <option value="">Pago</option>
              <option>Pendiente</option>
              <option>Parcial</option>
              <option>Pagado</option>
            </select>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="tbl-wrap">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>ID</th>
                <th>Cliente</th>
                <th>Canal</th>
                <th>Vendedora</th>
                <th className="text-center">Hojas</th>
                <th>Total</th>
                <th>Fecha</th>
                <th>Entrega</th>
                <th>Pago</th>
                <th>Chofer</th>
                <th className="text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {mockLeads.map((l) => (
                <tr key={l.id}>
                  <td className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {l.id}
                  </td>
                  <td>
                    <div className="font-medium">{l.client_name}</div>
                    <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {l.phone}
                    </div>
                  </td>
                  <td><ChannelBadge channel={l.channel} /></td>
                  <td>{l.seller}</td>
                  <td className="text-center">{l.sheets_count}</td>
                  <td className="font-semibold">{formatMXN(l.total_amount)}</td>
                  <td className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {l.sale_date}
                  </td>
                  <td><DeliveryBadge status={l.delivery_status} /></td>
                  <td><PaymentBadge status={l.payment_status} /></td>
                  <td className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {l.driver ?? '—'}
                  </td>
                  <td>
                    <div className="flex justify-end gap-1">
                      <button className="btn btn-ghost" style={{ padding: '6px' }} aria-label="Ver">
                        <Eye size={16} />
                      </button>
                      <button className="btn btn-ghost" style={{ padding: '6px' }} aria-label="Editar">
                        <Pencil size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div
          className="flex items-center justify-between px-6 py-3 border-t"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-subtle)' }}
        >
          <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            Mostrando <strong>1-5</strong> de <strong>5</strong> resultados
          </div>
          <div className="flex items-center gap-1">
            <button className="btn btn-ghost" style={{ padding: '6px 10px' }} disabled>
              <ChevronLeft size={14} />
            </button>
            <button
              className="btn"
              style={{
                padding: '4px 10px',
                background: 'var(--brand-primary)',
                color: '#fff',
                fontSize: '0.75rem',
              }}
            >
              1
            </button>
            <button className="btn btn-ghost" style={{ padding: '6px 10px' }} disabled>
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
