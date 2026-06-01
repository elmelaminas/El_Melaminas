import { ImageResponse } from 'next/og';

/**
 * Apple touch icon 180x180 — convención `apple-icon.tsx` del App
 * Router. Next.js lo expone como `<link rel="apple-touch-icon">` para
 * cuando el usuario añade la app a la pantalla de inicio en iOS/iPad.
 *
 * Diseño compartido con `icon.tsx` pero a mayor escala: círculo con
 * "EE" + nombre "EL MELAMINAS" debajo en dos líneas con tracking.
 */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
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
          borderRadius: 40,
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
              width: 70,
              height: 70,
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
                fontSize: 28,
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
                fontSize: 22,
                fontWeight: 300,
                letterSpacing: 8,
              }}
            >
              EL
            </span>
            <span
              style={{
                color: '#8B6914',
                fontSize: 18,
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
