/**
 * The web implementation of `ServiceWorkerHost` (see appUpdates.ts): registers the Workbox worker
 * that `vite-plugin-pwa` generates. The registration code is loaded on first use, so it is not
 * part of the first screen. `supportsServiceWorker` is false in the dev server (it has no worker)
 * and in browsers without one; the P10 shells provide their own host or none.
 */
import type { ServiceWorkerHost } from './appUpdates.ts';

export const supportsServiceWorker = (): boolean =>
  import.meta.env.PROD && typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

export const webServiceWorker: ServiceWorkerHost = {
  register(handlers) {
    let update: ((reload?: boolean) => Promise<void>) | undefined;
    const ready = import('virtual:pwa-register').then(({ registerSW }) => {
      update = registerSW({
        onNeedRefresh: handlers.onNeedRefresh,
        onRegisteredSW: (_url, registration) => handlers.onRegistered(registration),
      });
    });
    return async (reload) => {
      await ready;
      await update?.(reload);
    };
  },
};
