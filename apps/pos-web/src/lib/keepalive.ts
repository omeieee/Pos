import type { Lifecycle } from '../platform/lifecycle.ts';
import { subscribeTicks } from './clock.ts';

/** Well inside the server's idle limit for a PIN session (2 hours). */
export const KEEPALIVE_INTERVAL_MS = 10 * 60_000;

/**
 * Keeps a listen-only screen signed in (the kitchen display).
 *
 * Why: the server ends a session that has made no REST call for its idle limit (PIN session: 2
 * hours), and an open WebSocket never counts as activity, so a display that only listens would be
 * closed with 4401 in the middle of a shift. While this runs, and only while the page is in
 * front, one cheap authenticated call (`GET /v1/auth/me`, which the server's guard counts as
 * activity) is made about every ten minutes, and once when the page returns after a longer pause.
 *
 * Trade-off (deliberate; the owner should know): a kitchen display left open stays signed in until
 * the ABSOLUTE session limit (12 hours), then the normal 4401 path returns it to the PIN screen.
 * The idle limit therefore does not protect a screen that is left open in the kitchen.
 *
 * A failed ping is ignored. A 401 already signs the app out through the API client; any other
 * failure (offline) is simply tried again at the next interval. Returns the function that stops it.
 */
export function startSessionKeepalive(deps: {
  ping: () => Promise<unknown>;
  lifecycle: Pick<Lifecycle, 'isVisible' | 'subscribe'>;
  intervalMs?: number;
  now?: () => number;
}): () => void {
  const interval = deps.intervalMs ?? KEEPALIVE_INTERVAL_MS;
  const now = deps.now ?? Date.now;
  let lastAt = now();
  let running = false;

  async function ping() {
    if (running) return;
    running = true;
    lastAt = now();
    try {
      await deps.ping();
    } catch {
      // see above: nothing to do
    } finally {
      running = false;
    }
  }

  const stopTicks = subscribeTicks(interval, () => {
    if (deps.lifecycle.isVisible()) void ping();
  });
  const unsubscribe = deps.lifecycle.subscribe({
    visible() {
      if (now() - lastAt >= interval) void ping();
    },
  });
  return () => {
    stopTicks();
    unsubscribe();
  };
}
