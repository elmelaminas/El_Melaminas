import { ImageResponse } from 'next/og';

/**
 * Icono 192x192 para PWA Android — servido como ruta `/icon-192`.
 * El manifest.ts lo referencia en su array `icons`. Usa el mismo
 * diseño que `apple-icon.tsx` escalado.
 *
 * Implementado como route handler (en vez de la convención `icon.tsx`
 * de Next) porque el manifest requiere una URL estable y la
 * convención auto-genera paths con hash.
 */
const size = { width: 192, height: 192 };

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          background: '#F5F0E8',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 42,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <div
            style={{
              width: 75,
              height: 75,
              borderRadius: '50%',
              border: '4px solid #8B6914',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span
              style={{
                color: '#8B6914',
                fontSize: 30,
                fontWeight: 800,
                letterSpacing: -1,
              }}
            >
              EE
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
          >
            <span
              style={{
                color: '#8B6914',
                fontSize: 23,
                fontWeight: 300,
                letterSpacing: 8,
              }}
            >
              EL
            </span>
            <span
              style={{
                color: '#8B6914',
                fontSize: 19,
                fontWeight: 600,
                letterSpacing: 4,
              }}
            >
              MELAMINAS
            </span>
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
