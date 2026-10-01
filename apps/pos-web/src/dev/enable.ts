/**
 * `pnpm dev` with `VITE_MOCK_API=1` answers /v1/auth from the made-up server in mock-server.ts,
 * so the screens can be tried without an API (the deployed API is never called from a dev
 * server). `import.meta.env.DEV` is false in a production build, which removes this branch and
 * the mock with it.
 */
export async function devFetch(): Promise<typeof fetch | undefined> {
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK_API === '1') {
    const { createMockServer } = await import('./mock-server.ts');
    return createMockServer({ delayMs: 150 }).fetch;
  }
  return undefined;
}
