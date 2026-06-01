import { ImageResponse } from 'next/og';

/**
 * Icono 512x512 para PWA splash screen — servido como ruta
 * `/icon-512`. Mismo patrón que `/icon-192` pero escalado. Es el
 * tamaño que Android usa para el splash al abrir la app instalada.
 */
const size = { width: 512, height: 512 };

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
          borderRadius: 112,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
          }}
        >
          <div
            style={{
              width: 200,
              height: 200,
              borderRadius: '50%',
              border: '10px solid #8B6914',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span
              style={{
                color: '#8B6914',
                fontSize: 80,
                fontWeight: 800,
                letterSpacing: -3,
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
                fontSize: 62,
                fontWeight: 300,
                letterSpacing: 22,
              }}
            >
              EL
            </span>
            <span
              style={{
                color: '#8B6914',
                fontSize: 52,
                fontWeight: 600,
                letterSpacing: 12,
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
