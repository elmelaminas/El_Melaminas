'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Eye, EyeOff, Layers, Lock, Mail, Loader } from 'lucide-react';
import { supabaseClient } from '@/lib/supabase/client';
import { useDemo } from '@/context/DemoContext';
import { type Role } from '@/data/mock';

/**
 * Pantalla de login real (Supabase Auth).
 *
 * Flujo:
 *   1. `auth.signInWithPassword({ email, password })` desde el browser.
 *      `@supabase/ssr` `createBrowserClient` setea las cookies de sesión
 *      automáticamente, así que `supabaseServer()` en Server Components y
 *      Server Actions las lee sin pasos extra.
 *   2. SELECT `profiles.role, full_name WHERE id = auth.uid()`. Esto
 *      requiere que `profiles` tenga RLS que permita ese SELECT al usuario
 *      autenticado (típicamente `auth.uid() = id`). Si la query devuelve
 *      vacío, mostramos un mensaje claro: el problema es de RLS, no del
 *      usuario.
 *   3. Validamos que `role` esté en la lista soportada. Si no, sign-out
 *      preventivo y mensaje al usuario — evita dejar a alguien con sesión
 *      pero rol inválido que la sidebar no sabe renderizar.
 *   4. Sembramos `DemoContext` con el usuario real (`setUser({...})`) para
 *      que sidebar/header pinten el avatar/nombre correctos, y redirigimos
 *      según el rol.
 *
 * Política de errores:
 *   - signIn falla → mensaje genérico ("Correo o contraseña incorrectos.")
 *     para no revelar si el correo existe.
 *   - cualquier otro fallo (RLS, profile faltante, throw inesperado) →
 *     mensaje específico visible.
 *
 * NOTA: `/reports` (destino de supervisor) NO existe aún en este deploy.
 * Si entras como supervisor, verás un 404. Cuando esa pantalla exista
 * o quieras un fallback, cambia el target en `ROLE_TARGET`.
 */

const ROLE_TARGET: Record<Role, string> = {
  admin: '/dashboard',
  seller: '/leads/new',
  driver: '/driver',
  warehouse: '/warehouse',
  supervisor: '/reports',
  contador: '/contador',
};

const ALLOWED_ROLES: readonly Role[] = [
  'admin',
  'seller',
  'driver',
  'warehouse',
  'supervisor',
  'contador',
];

/**
 * Default export wrapper.
 *
 * `LoginForm` usa `useSearchParams()` para leer `?reason=disabled` del
 * middleware (cuando un usuario desactivado fue kickeado). Eso hace que
 * Next bailee del prerender estático y exija un Suspense boundary, o el
 * `next build` falla con:
 *   "useSearchParams() should be wrapped in a suspense boundary at page /login"
 *   (https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout)
 *
 * El fallback replica el shell del card (gradient + max-w-md + altura
 * aproximada del form) para que no haya layout shift visible cuando el
 * subtree resuelve. Centramos un Loader spinner en el lugar donde
 * normalmente irían los inputs.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginFallback() {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{
        background: 'linear-gradient(135deg, #1B3A5C 0%, #2E74B5 100%)',
      }}
    >
      <div className="w-full max-w-md">
        <div
          className="card p-8 flex items-center justify-center"
          style={{
            boxShadow: '0 20px 60px rgba(0,0,0,0.20)',
            minHeight: 360,
          }}
        >
          <Loader
            size={28}
            className="animate-spin"
            style={{ color: 'var(--brand-primary)' }}
            aria-label="Cargando"
          />
        </div>
      </div>
    </div>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setUser } = useDemo();
  const [showPwd, setShowPwd] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);

  // Si llegamos aquí con `?reason=disabled` el middleware nos kickeó
  // por tener `is_active=false` en profiles. Mostramos el banner desde
  // el primer render para que el usuario sepa por qué fue expulsado.
  // Cualquier intento de login subsiguiente limpia este estado
  // (setError(null) al inicio del onSubmit).
  const reason = searchParams?.get('reason') ?? null;
  const [error, setError] = useState<string | null>(
    reason === 'disabled'
      ? 'Tu cuenta ha sido desactivada. Contacta al administrador.'
      : null,
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError('Ingresa correo y contraseña.');
      return;
    }

    setPending(true);
    try {
      const supabase = supabaseClient();

      // 1. Autenticación
      const { data: signInData, error: signInErr } =
        await supabase.auth.signInWithPassword({
          email: trimmedEmail,
          password,
        });
      if (signInErr || !signInData?.user) {
        // Genérico — no revelar si el correo está registrado.
        console.error('[LoginPage] signIn falló:', signInErr);
        setError('Correo o contraseña incorrectos.');
        return;
      }
      const userId = signInData.user.id;

      // 2. Lectura de rol desde profiles (RLS-protected; el usuario lee
      //    su propio profile vía la policy `auth.uid() = id`).
      const { data: profile, error: profileErr } = await supabase
        .from('profiles')
        .select('role, full_name')
        .eq('id', userId)
        .maybeSingle();

      if (profileErr) {
        console.error('[LoginPage] SELECT profile falló:', profileErr);
        await supabase.auth.signOut();
        setError(`No se pudo leer tu perfil: ${profileErr.message}`);
        return;
      }
      if (!profile) {
        // Sesión válida pero sin profile (o RLS lo bloquea). No dejamos
        // al usuario "logueado-a-medias".
        await supabase.auth.signOut();
        setError(
          'No se encontró tu perfil. Contacta al administrador para que lo cree.',
        );
        return;
      }

      const role = profile.role as Role;
      if (!ALLOWED_ROLES.includes(role)) {
        await supabase.auth.signOut();
        setError(
          `Tu cuenta tiene un rol no soportado: "${role}". Contacta al administrador.`,
        );
        return;
      }

      // 3. Poblar el contexto del cliente con el usuario real.
      setUser({
        id: userId,
        name: profile.full_name ?? signInData.user.email ?? 'Usuario',
        email: signInData.user.email ?? undefined,
        role,
      });

      // 4. Redirigir según rol. `router.refresh()` fuerza al RSC layer a
      //    re-leer la sesión; sin esto, los Server Components siguen
      //    viendo "no autenticado" durante un tick.
      router.push(ROLE_TARGET[role]);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Error al iniciar sesión';
      console.error('[LoginPage] excepción no controlada:', err);
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
                  autoComplete="current-password"
                  disabled={pending}
                />
                <button
                  type="button"
                  aria-label={
                    showPwd ? 'Ocultar contraseña' : 'Mostrar contraseña'
                  }
                  onClick={() => setShowPwd((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded"
                  style={{ color: 'var(--text-secondary)' }}
                  disabled={pending}
                >
                  {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
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
                  whiteSpace: 'pre-wrap',
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
                  <span style={{ marginLeft: 6 }}>Iniciando sesión…</span>
                </>
              ) : (
                'Iniciar sesión'
              )}
            </button>

            <div className="text-center">
              <Link
                href="/forgot-password"
                className="text-sm hover:underline"
                style={{ color: 'var(--brand-secondary)' }}
              >
                ¿Olvidaste tu contraseña?
              </Link>
            </div>
          </form>
        </div>

        {/* Footer */}
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
