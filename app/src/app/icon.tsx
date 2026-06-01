import { ImageResponse } from 'next/og';

/**
 * Favicon 32x32 — convención `icon.tsx` del App Router. Next.js lo
 * sirve como PNG y lo agrega como `<link rel="icon">` en el head.
 *
 * Diseño temporal con las iniciales "EE" y la palabra "EM" en dorado
 * sobre crema, replicando el contraste del logo. Cuando Sergio suba
 * el SVG/PNG final, reemplazamos este archivo por una imagen estática
 * en `public/`.
 */
export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
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
          borderRadius: 6,
          border: '1px solid #C9A96E',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: '50%',
              border: '1.5px solid #8B6914',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 1,
            }}
          >
            <span
              style={{
                color: '#8B6914',
                fontSize: 7,
                fontWeight: 700,
                letterSpacing: '-0.5px',
              }}
            >
              EE
            </span>
          </div>
          <span
            style={{
              color: '#8B6914',
              fontSize: 6,
              fontWeight: 600,
              letterSpacing: 1,
            }}
          >
            EM
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
