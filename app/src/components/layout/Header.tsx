/* ═══════════════════════════════════════════
   HEADER — Barra superior con notificaciones reales
   ═══════════════════════════════════════════ */

'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bell, Menu, Search, HelpCircle } from 'lucide-react';
import { useDemo } from '@/context/DemoContext';
import { roleLabel } from '@/data/mock';
import { supabaseClient } from '@/lib/supabase/client';
import { startTour } from '@/components/ui/AppTour';
import { usePageTour } from '@/hooks/usePageTour';
import { useFaviconBadge } from '@/hooks/useFaviconBadge';

/**
 * Tipo de notificación que la app emite. Coincide con los valores que
 * insertan los Server Actions (`leads/new`, `payments/new`,
 * `warehouse/registerEntryAction`). La columna `type` en DB es `text`
 * pero la limitamos a este union para mapear color y título; cualquier
 * valor desconocido cae a un default neutral.
 */
type NotificationType =
  | 'nuevo_lead'
  | 'pago_confirmado'
  | 'entrega_confirmada'
  | 'stock_bajo'
  | 'efectivo_pendiente'
  | 'efectivo_recibido'
  // Tipos agregados con los flujos de issues/delivery/route/exit.
  | 'issue_reported'
  | 'delivery_failed'
  | 'stock_returned'
  | 'ruta_asignada'
  | 'mercancia_lista';

interface NotificationRow {
  id: string;
  recipient_id: string | null;
  type: NotificationType | string;
  message: string;
  is_read: boolean | null;
  created_at: string | null;
}

/** Mapa type → color del puntito de la izquierda en el dropdown. */
const TYPE_DOT: Record<NotificationType, string> = {
  nuevo_lead: 'bg-[#2E74B5]', // info azul
  pago_confirmado: 'bg-[#16A34A]', // success verde
  entrega_confirmada: 'bg-[#16A34A]', // success verde
  stock_bajo: 'bg-[#D97706]', // warning amarillo
  efectivo_pendiente: 'bg-[#F59E0B]', // brand-accent — algo que requiere acción
  efectivo_recibido: 'bg-[#16A34A]', // success verde — flujo completado
  // Nuevos: cada uno con su tono propio para que el admin distinga
  // de un vistazo el tipo sin leer el título.
  issue_reported: 'bg-[#DC2626]', // rojo — atención inmediata
  delivery_failed: 'bg-[#EA580C]', // naranja oscuro — falla operativa
  stock_returned: 'bg-[#16A34A]', // verde — paso completado
  ruta_asignada: 'bg-[#2563EB]', // azul medio — info logística
  mercancia_lista: 'bg-[#7C3AED]', // morado — alerta del almacén al chofer
};

/** Mapa type → título humano (la DB solo guarda `message`, generamos title). */
const TYPE_TITLE: Record<NotificationType, string> = {
  nuevo_lead: 'Nuevo lead',
  pago_confirmado: 'Pago confirmado',
  entrega_confirmada: 'Entrega confirmada',
  stock_bajo: 'Stock bajo',
  efectivo_pendiente: 'Efectivo pendiente',
  efectivo_recibido: 'Efectivo recibido',
  issue_reported: '⚠️ Faltante / Detalle reportado',
  delivery_failed: '🚫 Entrega fallida',
  stock_returned: '📦 Stock devuelto',
  ruta_asignada: '🗺️ Ruta del día asignada',
  mercancia_lista: '✅ Mercancía lista para entrega',
};

const PAGE_SIZE = 20;

/**
 * Tiempo relativo en español: "hace 12 min", "hace 3 h", "hace 2 d".
 * Para notifs muy recientes (< 60s) decimos "hace unos segundos".
 *
 * NB: El cálculo es client-side; durante hidratación el `now` puede diferir
 * del `now` del server por unos segundos. Para evitar mismatch de SSR
 * dejamos que el primer render pinte el ISO crudo y un useEffect lo
 * actualiza. Como Header es 'use client' y el contenido del dropdown
 * sólo se ve cuando el usuario clickea (mucho después de la hidratación),
 * el riesgo de hydration mismatch es nulo.
 */
function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return 'hace unos segundos';
  if (diffSec < 3600) return `hace ${Math.floor(diffSec / 60)} min`;
  if (diffSec < 86400) return `hace ${Math.floor(diffSec / 3600)} h`;
  return `hace ${Math.floor(diffSec / 86400)} d`;
}

export default function Header({
  onMenuClick,
}: {
  /** Callback para abrir el sidebar drawer. Solo se invoca desde el botón
   *  hamburger visible en mobile (`lg:hidden`). En desktop el sidebar
   *  ya está siempre visible y el botón no aparece. */
  onMenuClick?: () => void;
}) {
  const { user, role } = useDemo();
  // pageSteps = pasos del tour contextual de la ruta actual. Si hay,
  // el botón "?" arranca ese tour y muestra un puntito azul como
  // indicador visual de "tour disponible para esta vista".
  const pageSteps = usePageTour();
  const hasPageTour = pageSteps !== null;
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * Carga inicial + suscripción Realtime.
   *
   * 1. `auth.getUser()` desde el cliente (cookies del browser ya están
   *    sync por @supabase/ssr) para obtener el id del usuario logueado.
   * 2. SELECT inicial de las últimas 20 notificaciones donde
   *    `recipient_id = userId`. RLS de `notifications` debe permitir
   *    `auth.uid() = recipient_id` para SELECT — si no, la query
   *    devuelve filas vacías sin error y el dropdown queda vacío.
   * 3. Subscribe a `postgres_changes` event=INSERT en `notifications`
   *    filtrado por recipient_id. Cada INSERT que matchee el filter
   *    se prepende al state y mantenemos el cap de 20.
   *
   * Caveats que el usuario debe atender en Supabase Dashboard:
   *  - Realtime habilitado para tabla `notifications`
   *    (Database → Replication). Sin esto, la subscription se monta
   *    sin error pero nunca recibe eventos.
   *  - RLS policy SELECT `auth.uid() = recipient_id` para que el cliente
   *    pueda leer sus propias notifs.
   *  - RLS policy UPDATE `auth.uid() = recipient_id` para que `markRead`
   *    y `markAllRead` funcionen.
   */
  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<ReturnType<typeof supabaseClient>['channel']> | null = null;

    (async () => {
      try {
        const supabase = supabaseClient();

        const {
          data: { user: authUser },
        } = await supabase.auth.getUser();
        if (cancelled) return;
        if (!authUser) {
          // No hay sesión activa (ej. /login) — el header sigue funcionando
          // sin notifs. No es un error.
          return;
        }
        setUserId(authUser.id);

        const { data, error } = await supabase
          .from('notifications')
          .select('id, recipient_id, type, message, is_read, created_at')
          .eq('recipient_id', authUser.id)
          .order('created_at', { ascending: false })
          .limit(PAGE_SIZE);
        if (cancelled) return;
        if (error) {
          console.error('[Header] fetchNotifications falló:', error);
          setLoadError(error.message);
        } else {
          setNotifications((data ?? []) as NotificationRow[]);
        }

        // Realtime: solo INSERTs nuevos. UPDATEs (mark-as-read) los hago
        // optimísticos en el cliente, no necesito recibirlos por el canal.
        channel = supabase
          .channel(`notifications:${authUser.id}`)
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'notifications',
              filter: `recipient_id=eq.${authUser.id}`,
            },
            (payload) => {
              const next = payload.new as NotificationRow;
              setNotifications((prev) => [next, ...prev].slice(0, PAGE_SIZE));
            },
          )
          .subscribe();
      } catch (err) {
        console.error('[Header] excepción al cargar notificaciones:', err);
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : 'Error desconocido',
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      if (channel) {
        try {
          supabaseClient().removeChannel(channel);
        } catch (e) {
          console.error('[Header] removeChannel falló:', e);
        }
      }
    };
  }, []);

  const unread = useMemo(
    () => notifications.filter((n) => !n.is_read).length,
    [notifications],
  );

  // Sincroniza el favicon de la pestaña con el contador de no leídas.
  // Patrón Gmail/Slack: el usuario ve "hay algo nuevo" sin tener la
  // pestaña activa. Al cambiar `unread` el hook re-pinta el icono.
  useFaviconBadge(unread);

  /**
   * Marcar una notificación como leída.
   * - Optimistic update: pintamos `is_read=true` en cliente inmediato.
   * - UPDATE en DB. Si falla, revertimos.
   * - El RLS policy debe permitir UPDATE para `auth.uid()=recipient_id`.
   */
  const markRead = async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)),
    );
    try {
      const { error } = await supabaseClient()
        .from('notifications')
        .update({ is_read: true })
        .eq('id', id);
      if (error) {
        console.error('[Header] markRead falló:', error);
        // Revertir
        setNotifications((prev) =>
          prev.map((n) => (n.id === id ? { ...n, is_read: false } : n)),
        );
      }
    } catch (e) {
      console.error('[Header] markRead excepción:', e);
    }
  };

  /**
   * Marcar todas como leídas. Ejecutamos UPDATE bulk con filtro
   * `recipient_id = userId AND is_read = false` (el segundo filtro
   * reduce el footprint de la query: no toca filas que ya estaban
   * leídas).
   */
  const markAllRead = async () => {
    if (!userId) return;
    if (unread === 0) return;
    const snapshot = notifications;
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    try {
      const { error } = await supabaseClient()
        .from('notifications')
        .update({ is_read: true })
        .eq('recipient_id', userId)
        .eq('is_read', false);
      if (error) {
        console.error('[Header] markAllRead falló:', error);
        setNotifications(snapshot);
      }
    } catch (e) {
      console.error('[Header] markAllRead excepción:', e);
      setNotifications(snapshot);
    }
  };

  return (
    <header className="app-header">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {/* Botón hamburger — solo en mobile/tablet. Abre el sidebar drawer. */}
        {onMenuClick && (
          <button
            type="button"
            onClick={onMenuClick}
            className="lg:hidden flex items-center justify-center rounded-lg"
            style={{
              width: 40,
              height: 40,
              color: 'var(--text-secondary)',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              flexShrink: 0,
            }}
            aria-label="Abrir menú"
          >
            <Menu size={22} />
          </button>
        )}

        {/* Search — visible solo en md+ (≥768px) */}
        <div
          className="hidden md:flex items-center gap-2 px-3 py-2 rounded-lg"
          style={{ background: 'var(--bg-muted)', minWidth: 320 }}
        >
          <Search size={16} style={{ color: 'var(--text-tertiary)' }} />
          <input
            placeholder="Buscar leads, clientes, pagos…"
            className="bg-transparent outline-none text-sm flex-1"
            style={{ color: 'var(--text-primary)' }}
          />
          <kbd
            className="hidden lg:inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium"
            style={{ background: '#fff', border: '1px solid var(--border)', color: 'var(--text-tertiary)' }}
          >
            Ctrl + K
          </kbd>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {/* Tour guiado — botón "?" para (re)iniciar el recorrido por
            la app. Si la página actual tiene un tour propio (hook
            usePageTour devuelve pasos), arranca ese tour contextual;
            si no, cae al tour global por rol. Un puntito azul en la
            esquina superior derecha del botón señala que hay un tour
            contextual disponible para esta vista. */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            id="tour-btn"
            onClick={() => startTour(role, pageSteps)}
            className="flex items-center justify-center rounded-full hover:bg-[var(--bg-muted)]"
            style={{
              width: 32,
              height: 32,
              color: '#1B3A5C',
              border: '2px solid var(--brand-primary)',
              background: '#fff',
              cursor: 'pointer',
            }}
            aria-label={
              hasPageTour
                ? 'Ayuda contextual de esta vista'
                : 'Iniciar recorrido guiado de la app'
            }
            title={
              hasPageTour
                ? 'Tour contextual disponible para esta vista'
                : 'Ayuda — recorrido guiado'
            }
          >
            <HelpCircle size={18} />
          </button>
          {hasPageTour && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                top: -2,
                right: -2,
                width: 10,
                height: 10,
                borderRadius: 9999,
                background: 'var(--brand-secondary, #2E74B5)',
                border: '2px solid #fff',
              }}
            />
          )}
        </div>

        {/* Notifications */}
        <div className="relative">
          <button
            onClick={() => setOpen((v) => !v)}
            className="relative flex items-center justify-center rounded-full hover:bg-[var(--bg-muted)]"
            style={{ width: 40, height: 40, color: 'var(--text-secondary)' }}
            aria-label={
              unread > 0
                ? `Notificaciones (${unread} sin leer)`
                : 'Notificaciones'
            }
            aria-expanded={open}
            aria-haspopup="dialog"
          >
            <Bell size={20} />
            {unread > 0 && (
              <span
                className="absolute flex items-center justify-center"
                style={{
                  top: 6,
                  right: 6,
                  minWidth: 18,
                  height: 18,
                  padding: '0 5px',
                  borderRadius: 9999,
                  background: 'var(--danger)',
                  color: '#fff',
                  fontSize: '0.625rem',
                  fontWeight: 700,
                }}
                aria-hidden="true"
              >
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>

          {open && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setOpen(false)}
              />
              <div
                role="dialog"
                aria-label="Panel de notificaciones"
                className="absolute right-0 mt-2 z-20 animate-fade card"
                style={{ width: 360, padding: 0, maxWidth: 'calc(100vw - 24px)' }}
              >
                <div
                  className="px-4 py-3 border-b flex items-center justify-between gap-3"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <div>
                    <div className="font-semibold text-sm">Notificaciones</div>
                    <div
                      className="text-xs"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {unread === 0
                        ? 'Sin notificaciones nuevas'
                        : unread === 1
                        ? 'Tienes 1 sin leer'
                        : `Tienes ${unread} sin leer`}
                    </div>
                  </div>
                  {unread > 0 && (
                    <button
                      type="button"
                      onClick={markAllRead}
                      className="text-xs hover:underline"
                      style={{
                        color: 'var(--brand-secondary)',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 0,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Marcar todas
                    </button>
                  )}
                </div>

                <div className="max-h-80 overflow-y-auto">
                  {loadError ? (
                    <div
                      className="p-4 text-sm"
                      style={{ color: 'var(--danger)' }}
                    >
                      No se pudieron cargar: {loadError}
                    </div>
                  ) : notifications.length === 0 ? (
                    <div
                      className="p-6 text-sm text-center"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      No tienes notificaciones.
                    </div>
                  ) : (
                    notifications.map((n) => {
                      const t = (n.type as NotificationType) ?? 'nuevo_lead';
                      const dot = TYPE_DOT[t] ?? 'bg-[#94A3B8]';
                      const title = TYPE_TITLE[t] ?? 'Notificación';
                      const isRead = n.is_read === true;
                      return (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => {
                            if (!isRead) markRead(n.id);
                          }}
                          className="flex gap-3 px-4 py-3 cursor-pointer hover:bg-[var(--bg-muted)] border-b last:border-b-0 w-full text-left"
                          style={{
                            borderColor: 'var(--border)',
                            background: isRead
                              ? 'transparent'
                              : 'rgba(46,116,181,0.04)',
                          }}
                        >
                          <span
                            className={`mt-1.5 inline-block rounded-full ${dot}`}
                            style={{
                              width: 8,
                              height: 8,
                              flexShrink: 0,
                              opacity: isRead ? 0.4 : 1,
                            }}
                          />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                              className="text-sm font-medium truncate"
                              style={{
                                color: isRead
                                  ? 'var(--text-secondary)'
                                  : 'var(--text-primary)',
                              }}
                            >
                              {title}
                            </div>
                            <div
                              className="text-xs"
                              style={{ color: 'var(--text-secondary)' }}
                            >
                              {n.message}
                            </div>
                            <div
                              className="text-[11px] mt-1"
                              style={{ color: 'var(--text-tertiary)' }}
                            >
                              {timeAgo(n.created_at)}
                            </div>
                          </div>
                          {!isRead && (
                            <span
                              className="self-center"
                              style={{
                                width: 6,
                                height: 6,
                                borderRadius: 9999,
                                background: 'var(--brand-secondary)',
                                flexShrink: 0,
                              }}
                              aria-label="No leída"
                            />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* User */}
        <div
          className="flex items-center gap-3 px-3 py-1.5 rounded-lg"
          style={{ background: 'var(--bg-muted)' }}
        >
          <div
            className="flex items-center justify-center"
            style={{
              width: 32,
              height: 32,
              borderRadius: 9999,
              background: 'var(--brand-primary)',
              color: '#fff',
              fontSize: '0.75rem',
              fontWeight: 700,
            }}
          >
            {user.name.charAt(0)}
          </div>
          <div className="hidden sm:block leading-tight">
            <div className="text-sm font-semibold">{user.name}</div>
            <div
              className="text-[11px]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {roleLabel(role)}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
