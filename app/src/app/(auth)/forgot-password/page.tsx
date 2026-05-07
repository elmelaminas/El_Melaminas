'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Mail,
  Layers,
  Loader,
  CircleCheckBig,
} from 'lucide-react';
import { supabaseClient } from '@/lib/supabase/client';

/**
 * /forgot-password — solicitar email de reseteo.
 *
 * Llama `auth.resetPasswordForEmail(email, { redirectTo })`. Supabase
 * envía un email con un link que apunta a `/reset-password` (en este
 * dominio). El usuario lo abre en el MISMO browser desde el que solicitó
 * (limitación de PKCE flow — el code verifier vive en localStorage).
 *
 * Política de errores:
 *   - Form vacío o email inválido → mensaje local en banner.
 *   - Error de Supabase → mensaje genérico para no revelar si el email
 *     existe en la BD (privacidad).
 *   - Éxito → cambio a estado "sent" con instrucciones (no redirect:
 *     el usuario sigue en pantalla y ve la confirmación).
 *
 * Esta ruta es pública (whitelist en middleware.ts).
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Ingresa tu correo electrónico.');
      return;
    }
    // Validación cliente mínima — el server hará la real.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('El formato del correo no es válido.');
      return;
    }

    setPending(true);
    try {
      const supabase = supabaseClient();
      // `redirectTo` debe ser una URL absoluta y debe estar incluida en
      // la lista "Redirect URLs" del proyecto Supabase (Authentication →
      // URL Configuration). Si no lo está, el email se envía pero el
      // link redirige a la default (típicamente la URL del proyecto).
      const redirectTo = `${window.location.origin}/reset-password`;
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(
        trimmed,
        { redirectTo },
      );
      if (resetErr) {
        // Mensaje genérico — no revelar si el email existe.
        console.error('[ForgotPasswordPage] resetPasswordForEmail falló:', resetErr);
        setError(
          'No se pudo enviar el correo de recuperación. Intenta de nuevo.',
        );
        return;
      }
      setSent(true);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Error de red al solicitar reset';
      console.error('[ForgotPasswordPage] excepción:', err);
      setError(message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{
        background: 'linear-gradient(135deg, #1B3A5C 0%, #2E74B5 100%)',
      }}
    >
      <div className="w-full max-w-md">
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
                fontSize: '1.5rem',
                fontWeight: 800,
                color: 'var(--brand-primary)',
                letterSpacing: '0.02em',
                textAlign: 'center',
              }}
            >
              {sent ? 'Revisa tu correo' : 'Recuperar contraseña'}
            </h1>
            <p
              className="mt-1 text-sm text-center"
              style={{ color: 'var(--text-secondary)' }}
            >
              {sent
                ? 'Te enviamos un enlace para restablecer tu contraseña.'
                : 'Te enviaremos un enlace para que la restablezcas.'}
            </p>
          </div>

          {sent ? (
            <div className="space-y-5">
              <div
                role="status"
                className="text-sm flex items-start gap-3"
                style={{
                  color: 'var(--success, #15803D)',
                  background: 'var(--success-bg, rgba(22,163,74,0.08))',
                  border: '1px solid rgba(22,163,74,0.25)',
                  padding: '12px',
                  borderRadius: 8,
                }}
              >
                <CircleCheckBig
                  size={20}
                  style={{ flexShrink: 0, marginTop: 1 }}
                />
                <div>
                  <strong>Correo enviado a {email.trim()}.</strong>
                  <br />
                  Revisa tu bandeja (y la carpeta de spam). El enlace
                  caduca en 1 hora.
                </div>
              </div>

              <div
                className="text-xs"
                style={{ color: 'var(--text-tertiary)' }}
              >
                <strong>Importante:</strong> abre el enlace en este mismo
                navegador. Si lo abres en otro dispositivo (por ejemplo el
                celular cuando solicitaste desde tu compu), el reset no
                funcionará.
              </div>

              <Link
                href="/login"
                className="btn btn-outline w-full"
                style={{ height: 44 }}
              >
                <ArrowLeft size={16} /> Volver a iniciar sesión
              </Link>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
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
                    autoComplete="email"
                    disabled={pending}
                    placeholder="usuario@elmelaminas.com"
                    autoFocus
                  />
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  className="text-sm"
                  style={{
                    color: 'var(--danger, #dc2626)',
                    background: 'var(--danger-bg, rgba(220,38,38,0.08))',
                    border: '1px solid rgba(220,38,38,0.25)',
                    padding: '8px 12px',
                    borderRadius: 6,
                  }}
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary w-full"
                style={{ height: 44 }}
                disabled={pending}
                aria-busy={pending}
              >
                {pending ? (
                  <>
                    <Loader size={16} className="animate-spin" />
                    <span style={{ marginLeft: 6 }}>Enviando…</span>
                  </>
                ) : (
                  'Enviar enlace de recuperación'
                )}
              </button>

              <Link
                href="/login"
                className="btn btn-ghost w-full"
                style={{ height: 40, fontSize: '0.875rem' }}
              >
                <ArrowLeft size={14} /> Volver a iniciar sesión
              </Link>
            </form>
          )}
        </div>

        <div
          className="text-center mt-6 text-xs"
          style={{ color: 'rgba(255,255,255,0.7)' }}
        >
          © {new Date().getFullYear()} EL MELAMINAS · Sistema de Gestión Operativa
        </div>
      </div>
    </div>
  );
}
