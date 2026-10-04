import type { VitePWAOptions } from 'vite-plugin-pwa';

/**
 * The service worker's rules (D-05 item 4), kept in one place so a test can pin them.
 *
 * App shell only. The worker precaches what the build emits (HTML, JS, CSS, fonts, icons, the manifest)
 * and answers navigations with index.html when offline. There is NO runtime caching: `/v1`
 * answers, `/v1/sync` and the PromptPay QR picture are never stored, and a WebSocket never goes
 * through a worker. The API lives on another origin anyway; the navigation deny-list covers a
 * same-origin proxy too.
 */
export const pwaOptions: Partial<VitePWAOptions> = {
  // A new version waits for the app to apply it (src/platform/appUpdates.ts), so a reload never
  // lands in the middle of an order.
  registerType: 'prompt',
  // The page registers through src/platform/serviceWorker.ts. An inline script would break the
  // CSP (`script-src 'self'`).
  injectRegister: false,
  // The manifest is public/manifest.webmanifest (Thai name, token colours, icons).
  manifest: false,
  workbox: {
    globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,woff2}'],
    navigateFallback: 'index.html',
    navigateFallbackDenylist: [/^\/v1\//, /^\/healthz/, /^\/readyz/],
    cleanupOutdatedCaches: true,
    clientsClaim: true,
    skipWaiting: false,
    runtimeCaching: [],
  },
  devOptions: { enabled: false },
};
