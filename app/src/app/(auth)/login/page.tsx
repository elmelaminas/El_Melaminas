'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Layers, Lock, Mail } from 'lucide-react';
import { useDemo } from '@/context/DemoContext';
import { roleLabel, type Role } from '@/data/mock';

const ROLE_TARGET: Record<Role, string> = {
  admin: '/dashboard',
  seller: '/leads',
  driver: '/driver',
  warehouse: '/warehouse',
  supervisor: '/dashboard',
};

const ROLES: Role[] = ['admin', 'seller', 'driver', 'warehouse', 'supervisor'];

export default function LoginPage() {
  const router = useRouter();
  const { role, setRole } = useDemo();
  const [showPwd, setShowPwd] = useState(false);
  const [email, setEmail] = useState('sergio@elmelaminas.com');
  const [password, setPassword] = useState('demo1234');

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    router.push(ROLE_TARGET[role]);
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{
        background:
          'linear-gradient(135deg, #1B3A5C 0%, #2E74B5 100%)',
      }}
    >
      <div className="w-full max-w-md">
        {/* Card */}
        <div
          className="card p-8"
          style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.20)' }}
        >
          {/* Logo */}
          <div className="flex flex-col items-center mb-7">
            <div
              className="flex items-center justify-center mb-4"
              style={{
                width: 56,
                height: 56,
                borderRadius: 14,
                background: 'var(--brand-accent)',
                color: '#1F2937',
                boxShadow: '0 6px 16px rgba(245,158,11,0.35)',
              }}
            >
              <Layers size={28} />
            </div>
            <h1
              style={{
                fontSize: '1.75rem',
                fontWeight: 800,
                color: 'var(--brand-primary)',
                letterSpacing: '0.02em',
              }}
            >
              EL MELAMINAS
            </h1>
            <p
              className="mt-1 text-sm"
              style={{ color: 'var(--text-secondary)' }}
            >
              Sistema de Gestión Operativa
            </p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="label">Correo electrónico</label>
              <div className="relative">
                <Mail
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--text-tertiary)' }}
                />
                <input
                  type="email"
                  className="input"
                  style={{ paddingLeft: 38 }}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>

            <div>
              <label className="label">Contraseña</label>
              <div className="relative">
                <Lock
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--text-tertiary)' }}
                />
                <input
                  type={showPwd ? 'text' : 'password'}
                  className="input"
                  style={{ paddingLeft: 38, paddingRight: 38 }}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  aria-label={showPwd ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  onClick={() => setShowPwd((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button type="submit" className="btn btn-primary w-full" style={{ height: 44 }}>
              Iniciar sesión
            </button>

            <div className="text-center">
              <a
                href="#"
                className="text-sm hover:underline"
                style={{ color: 'var(--brand-secondary)' }}
              >
                ¿Olvidaste tu contraseña?
              </a>
            </div>
          </form>
        </div>

        {/* Demo role selector */}
        <div
          className="card mt-5 p-5"
          style={{
            background: 'rgba(255,255,255,0.95)',
            border: '1px dashed rgba(255,255,255,0.5)',
          }}
        >
          <div className="flex items-center gap-2 mb-3">
            <span
              className="badge badge-warning"
              style={{ fontSize: '0.6875rem' }}
            >
              DEMO
            </span>
            <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              Selecciona un rol para previsualizar la app
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {ROLES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors`}
                style={
                  r === role
                    ? {
                        background: 'var(--brand-primary)',
                        color: '#fff',
                        borderColor: 'var(--brand-primary)',
                      }
                    : {
                        background: '#fff',
                        color: 'var(--text-secondary)',
                        borderColor: 'var(--border-strong)',
                      }
                }
              >
                {roleLabel(r)}
              </button>
            ))}
          </div>
          <div
            className="mt-3 text-[11px]"
            style={{ color: 'var(--text-tertiary)' }}
          >
            Al iniciar sesión serás dirigido a la pantalla principal del rol{' '}
            <strong>{roleLabel(role)}</strong>.
          </div>
        </div>

        <div
          className="text-center mt-6 text-xs"
          style={{ color: 'rgba(255,255,255,0.7)' }}
        >
          © {new Date().getFullYear()} EL MELAMINAS · Prototipo visual v0.1
        </div>
      </div>
    </div>
  );
}
