import type { SocketFactory } from '../platform/socket.ts';

/**
 * `pnpm dev` with `VITE_MOCK_API=1` answers /v1 (sign-in, menu, orders, sync) and the realtime
 * socket from the made-up server in mock-server.ts, so the screens can be tried without an API
 * (the deployed API is never called from a dev server). `import.meta.env.DEV` is false in a
 * production build, which removes this branch and the mock with it.
 */
export async function devBackend(): Promise<
  { fetch: typeof fetch; createSocket: SocketFactory } | undefined
> {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK_API === '1') {
    const { createMockServer } = await import('./mock-server.ts');
    const server = createMockServer({ delayMs: 150 });
    // Try the kitchen view without a second device: __sdsMock.incomingOrder() in the console.
    Object.assign(globalThis, {
      __sdsMock: { incomingOrder: () => server.simulateIncomingOrder() },
    });
    return { fetch: server.fetch, createSocket: server.createSocket };
  }
  return undefined;
}
