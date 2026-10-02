import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { pwaOptions } from './pwa-options.ts';

/**
 * Dev server only (`apply: 'serve'`, never in a build): answers `GET /v1/payments/<id>/qr.png` with
 * a placeholder picture, so the `<img>` of the PromptPay screen has something to load when the app
 * runs against the made-up API (`VITE_MOCK_API=1`). An `<img>` bypasses the mock's fetch, which is
 * why this lives in the server. The picture says it is a sample and is not a real PromptPay QR.
 */
function mockQrPicture(): Plugin {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320">
<rect width="320" height="320" fill="#fff"/>
<g fill="#1f1a17">
<rect x="20" y="20" width="80" height="80"/><rect x="220" y="20" width="80" height="80"/><rect x="20" y="220" width="80" height="80"/>
<rect x="36" y="36" width="48" height="48" fill="#fff"/><rect x="236" y="36" width="48" height="48" fill="#fff"/><rect x="36" y="236" width="48" height="48" fill="#fff"/>
<rect x="48" y="48" width="24" height="24"/><rect x="248" y="48" width="24" height="24"/><rect x="48" y="248" width="24" height="24"/>
<rect x="120" y="30" width="20" height="20"/><rect x="160" y="50" width="30" height="20"/><rect x="120" y="120" width="40" height="30"/>
<rect x="190" y="130" width="30" height="40"/><rect x="130" y="190" width="30" height="30"/><rect x="220" y="200" width="60" height="20"/>
<rect x="170" y="250" width="40" height="30"/><rect x="250" y="250" width="30" height="30"/><rect x="30" y="130" width="40" height="20"/>
</g>
<rect x="60" y="136" width="200" height="48" rx="8" fill="#fff" stroke="#e4dcd1" stroke-width="3"/>
<text x="160" y="168" font-family="sans-serif" font-size="18" font-weight="700" text-anchor="middle" fill="#5e554d">SAMPLE QR - NOT REAL</text>
</svg>`;
  return {
    name: 'mock-qr-picture',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url && /^\/v1\/payments\/[^/?]+\/qr\.png(\?|$)/.test(request.url)) {
          response.setHeader('content-type', 'image/svg+xml');
          response.setHeader('cache-control', 'no-store');
          response.end(svg);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), VitePWA(pwaOptions), mockQrPicture()],
  build: { outDir: 'dist' },
});
