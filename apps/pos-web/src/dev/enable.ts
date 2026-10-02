import type { SocketFactory } from '../platform/socket.ts';

const OFFLINE_KEY = 'sds-mock-offline';

const readOffline = (): boolean => {
  try {
    return sessionStorage.getItem(OFFLINE_KEY) === '1';
  } catch {
    return false;
  }
};

const writeOffline = (on: boolean): void => {
  try {
    if (on) sessionStorage.setItem(OFFLINE_KEY, '1');
    else sessionStorage.removeItem(OFFLINE_KEY);
  } catch {
    // dev only: nothing to do
  }
};

/**
 * `pnpm dev` with `VITE_MOCK_API=1` answers /v1 (sign-in, menu, orders, sync) and the realtime
 * socket from the made-up server in mock-server.ts, so the screens can be tried without an API
 * (the deployed API is never called from a dev server). `import.meta.env.DEV` is false in a
 * production build, which removes this branch and the mock with it.
 *
 * Offline: a button (and `__sdsMock.setOffline(true)`) takes the mock network away. DevTools
 * "offline" would not do it, because the mock answers inside the page. Requests then fail like a
 * lost connection and the socket drops. `bumpPrices(500)` and `soldOut(1)` change the server's menu
 * without telling the app, so an order saved while offline is refused (or its cash comes up short)
 * when it syncs. These are English dev labels: they are not part of the shipped app.
 *
 * The offline switch survives a page reload (kept in sessionStorage, dev only), so "reload while
 * offline" can be tried: the mock's sessions and device tokens are self-describing, so the saved
 * PIN session is accepted again after the reload.
 */
export async function devBackend(): Promise<
  { fetch: typeof fetch; createSocket: SocketFactory } | undefined
> {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK_API === '1') {
    const { createMockServer } = await import('./mock-server.ts');
    const server = createMockServer({ delayMs: 150 });
    const setOffline = (on: boolean) => {
      server.setOffline(on);
      writeOffline(on);
      // What the browser does when the network goes: the app listens for these.
      window.dispatchEvent(new Event(on ? 'offline' : 'online'));
      const button = document.getElementById('sds-mock-offline');
      if (button) {
        button.textContent = on ? 'Mock network: OFF (tap to restore)' : 'Mock network: on';
        button.setAttribute('aria-pressed', String(on));
      }
    };
    // Try the kitchen view without a second device: __sdsMock.incomingOrder() in the console.
    Object.assign(globalThis, {
      __sdsMock: {
        incomingOrder: () => server.simulateIncomingOrder(),
        setOffline,
        bumpPrices: server.bumpPrices,
        soldOut: server.soldOut,
      },
    });
    const startOffline = readOffline();
    addOfflineButton(setOffline, startOffline);
    if (startOffline) setOffline(true);
    return { fetch: server.fetch, createSocket: server.createSocket };
  }
  return undefined;
}

function addOfflineButton(setOffline: (on: boolean) => void, startOffline: boolean): void {
  const button = document.createElement('button');
  button.id = 'sds-mock-offline';
  button.type = 'button';
  button.textContent = 'Mock network: on';
  button.setAttribute('aria-pressed', 'false');
  button.style.cssText =
    'position:fixed;right:8px;bottom:140px;z-index:99999;min-height:44px;padding:0 12px;' +
    'border-radius:22px;border:2px solid #444;background:#fff;color:#000;font:600 14px system-ui;';
  let off = startOffline;
  button.addEventListener('click', () => {
    off = !off;
    setOffline(off);
  });
  document.body.append(button);
}
