import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';

/**
 * Middleware de autenticación + RBAC.
 *
 * Vive en `src/middleware.ts` (no en `src/app/middleware.ts`) porque Next
 * lo carga desde la raíz del directorio fuente (`src/` cuando existe;
 * raíz del proyecto cuando no). Ver
 * `node_modules/next/dist/docs/.../middleware*.md`.
 *
 * Responsabilidades:
 *   1. Refrescar la sesión de Supabase: `@supabase/ssr` `createServerClient`
 *      lee/escribe cookies en cada request — sin esto los Server Components
 *      pueden ver una sesión expirada que el browser ya renovó.
 *      DOC: https://supabase.com/docs/guides/auth/server-side/nextjs#middleware
 *   2. Bloquear rutas privadas si no hay sesión → redirect a `/login`.
 *   3. Si autenticado y va a `/login` → redirect a su home según rol.
 *   4. RBAC: cada path tiene un set de roles permitidos; si el del usuario
 *      no está, redirect a su home (no 403, mejor UX).
 *
 * **Caveats**:
 *   - Hacemos un SELECT de `profiles.role` en CADA request al servidor (con
 *     service_role para bypassar RLS). En una iteración futura cachearíamos
 *     el rol en una cookie firmada o en custom JWT claims para evitar el
 *     round-trip a Postgres por hit. Por ahora la simplicidad pesa más
 *     que la latencia.
 *   - Si las env vars faltan, el middleware deja pasar la request — la
 *     página renderizará su propio `<ErrorState>` con la causa precisa.
 *     No queremos que la app muera silenciosamente por un misconfig de Vercel.
 *   - Las rutas `/api/*` quedan exentas: que cada endpoint haga su propio
 *     auth si lo necesita. Esto preserva `/api/test-supabase` accesible
 *     para diagnóstico sin sesión.
 */

const ROLES = ['admin', 'seller', 'driver', 'warehouse', 'supervisor'] as const;
type Role = (typeof ROLES)[number];

/** Pantalla principal por rol — destino tras login y fallback de RBAC. */
const HOME_BY_ROLE: Record<Role, string> = {
  admin: '/dashboard',
  seller: '/leads/new',
  driver: '/driver',
  warehouse: '/warehouse',
  supervisor: '/reports',
};

/**
 * Devuelve la lista de roles permitidos para `pathname`, o `null` si la
 * ruta no tiene restricción específica de rol (público para autenticados).
 *
 * El orden de los `if` importa: `/leads/new` se chequea ANTES de `/leads`
 * porque ambos prefijos chocan y la regla de `/leads/new` es más estricta.
 */
function rolesAllowed(pathname: string): readonly Role[] | null {
  if (pathname.startsWith('/admin')) return ['admin'];
  if (pathname === '/leads/new' || pathname.startsWith('/leads/new/')) return ['admin', 'seller'];
  if (pathname === '/leads' || pathname.startsWith('/leads/')) return ['admin', 'supervisor'];
  if (pathname === '/payments' || pathname.startsWith('/payments/')) return ['admin', 'supervisor'];
  if (pathname === '/dashboard') return ['admin', 'supervisor'];
  if (pathname === '/driver' || pathname.startsWith('/driver/')) return ['admin', 'driver'];
  if (pathname === '/warehouse' || pathname.startsWith('/warehouse/')) return ['admin', 'warehouse'];
  if (pathname === '/reports' || pathname.startsWith('/reports/')) return ['admin', 'supervisor'];
  return null;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // API routes: que cada endpoint haga su propio auth. Salimos sin tocar
  // cookies para no perturbar Stripe webhooks, health checks, etc.
  if (pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Sin env vars no podemos validar nada — dejar pasar para que la página
  // muestre el error real (NEXT_PUBLIC_X no definida) en lugar de un
  // redirect loop o pantalla blanca.
  if (!url || !anonKey) {
    return NextResponse.next();
  }

  // CRÍTICO (per docs Supabase): el response que retornamos al final tiene
  // que ser el MISMO objeto que mutó setAll. Reasignamos `response` cada
  // vez que las cookies cambian para que las cookies refrescadas lleguen
  // al browser.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // **No metas lógica entre createServerClient y getUser** — la doc oficial
  // advierte que el token refresh puede invalidarse si algo se interpone.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // ── Caso 1: NO autenticado
  if (!user) {
    if (pathname === '/login') return response;
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    return NextResponse.redirect(loginUrl);
  }

  // ── Caso 2: autenticado, leer rol
  let role: Role | null = null;
  if (serviceKey) {
    try {
      const admin = createClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: profile } = await admin
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();
      if (profile?.role && (ROLES as readonly string[]).includes(profile.role)) {
        role = profile.role as Role;
      }
    } catch (err) {
      console.error('[middleware] no se pudo leer profile.role:', err);
      // Si falla la lectura, dejamos `role = null` y el flujo de RBAC abajo
      // tratará al usuario como sin rol asignado (lo manda a /login).
    }
  }

  // ── Caso 2a: autenticado pero sin rol válido en profiles
  //    (RLS bloqueando service_role no aplica porque usamos service_role,
  //     pero puede ser que el profile no exista o tenga role no soportado)
  if (!role) {
    if (pathname === '/login') return response;
    // Lo mandamos a /login para que el handler ahí muestre el mensaje
    // "No se encontró tu perfil…" o "Rol no soportado…" como ya implementa.
    await supabase.auth.signOut().catch((e) => {
      console.error('[middleware] signOut preventivo falló:', e);
    });
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    return NextResponse.redirect(loginUrl);
  }

  // ── Caso 3: autenticado en /login → mandar a su home
  if (pathname === '/login') {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = HOME_BY_ROLE[role];
    homeUrl.search = '';
    return NextResponse.redirect(homeUrl);
  }

  // ── Caso 4: ruta protegida y rol no permitido → mandar a su home
  const allowed = rolesAllowed(pathname);
  if (allowed && !allowed.includes(role)) {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = HOME_BY_ROLE[role];
    homeUrl.search = '';
    return NextResponse.redirect(homeUrl);
  }

  return response;
}

/**
 * Matcher: corre el middleware en TODAS las rutas excepto:
 *   - `_next/static` y `_next/image` (assets internos)
 *   - `favicon.ico` y otros archivos con extensión común
 *
 * NOTA: el matcher es un negative-lookahead — si tu archivo no está en la
 * lista de extensiones, se aplica el middleware. Para excluir más
 * extensiones, agrégalas separadas por `|` dentro del grupo `(?:...)`.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|woff|woff2|ttf)$).*)',
  ],
};
