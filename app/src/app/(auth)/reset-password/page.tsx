'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Layers,
  Lock,
  Loader,
  CircleCheckBig,
} from 'lucide-react';
import { supabaseClient } from '@/lib/supabase/client';

/**
 * /reset-password — el usuario llega aquí desde el link del email.
 *
 * Flujo (PKCE):
 *   1. El email lleva a `…/reset-password?code=…` (o con tokens en hash
 *      si el proyecto está en flow `implicit`).
 *   2. `@supabase/ssr` `createBrowserClient` detecta la URL al cargar y
 *      hace el `exchangeCodeForSession` automáticamente — eso pone una
 *      sesión "recovery" en cookies/localStorage.
 *   3. Esta página verifica que existe sesión via `getSession()`. Si
 *      no, muestra "link inválido o expirado".
 *   4. Si sí, muestra form de nueva contraseña + confirmación.
 *   5. Submit → `auth.updateUser({ password })` actualiza la contraseña
 *      del usuario logueado por la sesión de recovery.
 *   6. Tras éxito mostramos confirmación y un botón a /login (no
 *      autoredirect: el usuario debe entender que el cambio se aplicó).
 *
 * Esta ruta es pública (whitelist en middleware.ts) porque el middleware
 * verifica `auth.getUser()` y la sesión de recovery aún no está confirmada
 * cuando llega el code en la URL.
 */

const MIN_PASSWORD_LENGTH = 8;

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Estado del check de sesión:
  //   'checking'  — verificando si llegamos con sesión recovery activa
  //   'ready'     — sesión válida, mostramos form
  //   'no-session' — link inválido / expirado / abrió en otro browser
  type CheckState = 'checking' | 'ready' | 'no-session';
  const [checkState, setCheckState] = useState<CheckState>('checking');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = supabaseClient();
        // El SDK ya intentó intercambiar el code de la URL al inicializar
        // (flowType pkce, detectSessionInUrl true por default).
        // Damos un tick para asegurar que el intercambio asíncrono terminó.
        await new Promise((r) => setTimeout(r, 100));
        const { data, error: sessErr } = await supabase.auth.getSession();
        if (cancelled) return;
        if (sessErr) {
          console.error('[ResetPasswordPage] getSession falló:', sessErr);
          setCheckState('no-session');
          return;
        }
        if (!data.session) {
          setCheckState('no-session');
          return;
        }
        setCheckState('ready');
      } catch (err) {
        if (cancelled) return;
        console.error('[ResetPasswordPage] check session excepción:', err);
        setCheckState('no-session');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }
    if (password !== confirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }

    setPending(true);
    try {
      const supabase = supabaseClient();
      const { error: upErr } = await supabase.auth.updateUser({ password });
      if (upErr) {
        console.error('[ResetPasswordPage] updateUser falló:', upErr);
        setError(`No se pudo actualizar la contraseña: ${upErr.message}`);
        return;
      }
      // Cerramos la sesión de recovery — el usuario debe iniciar sesión
      // explícitamente con la nueva contraseña. Esto evita que un browser
      // compartido herede la sesión sin re-autenticar.
      await supabase.auth.signOut().catch((e) => {
        console.error('[ResetPasswordPage] signOut tras reset falló:', e);
      });
      setSuccess(true);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Error al actualizar contraseña';
      console.error('[ResetPasswordPage] excepción:', err);
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
              {success ? 'Contraseña actualizada' : 'Nueva contraseña'}
            </h1>
            <p
              className="mt-1 text-sm text-center"
              style={{ color: 'var(--text-secondary)' }}
            >
              {success
                ? 'Ya puedes iniciar sesión con tu nueva contraseña.'
                : 'Ingrésala dos veces para confirmar.'}
            </p>
          </div>

          {/* Estados */}
          {checkState === 'checking' && (
            <div
              className="text-sm flex items-center justify-center gap-2 py-4"
              style={{ color: 'var(--text-secondary)' }}
            >
              <Loader size={16} className="animate-spin" />
              <span>Verificando enlace…</span>
            </div>
          )}

          {checkState === 'no-session' && (
            <div className="space-y-5">
              <div
                role="alert"
                className="text-sm"
                style={{
                  color: 'var(--danger, #dc2626)',
                  background: 'var(--danger-bg, rgba(220,38,38,0.08))',
                  border: '1px solid rgba(220,38,38,0.25)',
                  padding: '12px',
                  borderRadius: 8,
                }}
              >
                <strong>Enlace inválido o expirado.</strong>
                <br />
                <br />
                Posibles causas:
                <ul style={{ marginLeft: 18, marginTop: 6, listStyle: 'disc' }}>
                  <li>El enlace ya se utilizó.</li>
                  <li>Pasó más de 1 hora desde que lo solicitaste.</li>
                  <li>
                    Lo abriste en un dispositivo o navegador distinto al
                    que usaste para solicitarlo.
                  </li>
                </ul>
              </div>
              <Link
                href="/forgot-password"
                className="btn btn-primary w-full"
                style={{ height: 44 }}
              >
                Solicitar otro enlace
              </Link>
              <Link
                href="/login"
                className="btn btn-ghost w-full"
                style={{ height: 40, fontSize: '0.875rem' }}
              >
                <ArrowLeft size={14} /> Volver a iniciar sesión
              </Link>
            </div>
          )}

          {checkState === 'ready' && success && (
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
                  <strong>Listo.</strong>
                  <br />
                  Tu contraseña fue actualizada correctamente.
                </div>
              </div>
              <button
                type="button"
                onClick={() => router.push('/login')}
                className="btn btn-primary w-full"
                style={{ height: 44 }}
              >
                Iniciar sesión
              </button>
            </div>
          )}

          {checkState === 'ready' && !success && (
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <div>
                <label className="label">Nueva contraseña</label>
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
                    autoComplete="new-password"
                    disabled={pending}
                    minLength={MIN_PASSWORD_LENGTH}
                    autoFocus
                  />
                  <button
                    type="button"
                    aria-label={showPwd ? 'Ocultar' : 'Mostrar'}
                    onClick={() => setShowPwd((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded"
                    style={{ color: 'var(--text-secondary)' }}
                    disabled={pending}
                  >
                    {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <div
                  className="text-[11px] mt-1"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  Mínimo {MIN_PASSWORD_LENGTH} caracteres.
                </div>
              </div>

              <div>
                <label className="label">Confirmar contraseña</label>
                <div className="relative">
                  <Lock
                    size={16}
                    className="absolute left-3 top-1/2 -translate-y-1/2"
                    style={{ color: 'var(--text-tertiary)' }}
                  />
                  <input
                    type={showPwd ? 'text' : 'password'}
                    className="input"
                    style={{ paddingLeft: 38 }}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    autoComplete="new-password"
                    disabled={pending}
                    minLength={MIN_PASSWORD_LENGTH}
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
                    <span style={{ marginLeft: 6 }}>Actualizando…</span>
                  </>
                ) : (
                  'Actualizar contraseña'
                )}
              </button>
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
