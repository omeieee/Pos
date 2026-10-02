/**
 * Screen Wake Lock seam: a wall-mounted kitchen display must not go to sleep. Features call
 * `keepAwake()`; the P10 shells can swap the implementation (a native "keep screen on" flag).
 *
 * Web rules this follows:
 * - the browser drops the lock whenever the page is hidden, so it is asked for again when the
 *   page comes back to the front (`lifecycle.visible`);
 * - a request can be refused (low battery, a policy): that is quiet, the display just may sleep;
 * - where there is no Wake Lock API (iOS before 16.4, some browsers) `keepAwake()` does nothing and
 *   `supported` says so. The shop can also set Auto-Lock to Never on the iPad (docs/04 §5).
 */
import type { Lifecycle } from './lifecycle.ts';

/** The part of `WakeLockSentinel` that is used. */
export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockApi {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface ScreenWakeLock {
  readonly supported: boolean;
  /** Keeps the screen awake until the returned function is called. */
  keepAwake(): () => void;
}

const browserApi = (): WakeLockApi | null => {
  if (typeof navigator === 'undefined') return null;
  const wakeLock = (navigator as { wakeLock?: WakeLockApi }).wakeLock;
  return wakeLock && typeof wakeLock.request === 'function' ? wakeLock : null;
};

export function createWebWakeLock(options: {
  api?: WakeLockApi | null;
  lifecycle: Pick<Lifecycle, 'isVisible' | 'subscribe'>;
}): ScreenWakeLock {
  const api = options.api === undefined ? browserApi() : options.api;
  return {
    supported: api !== null,
    keepAwake() {
      if (!api) return () => undefined;
      let wanted = true;
      let held: WakeLockSentinelLike | null = null;
      let asking = false;

      async function acquire() {
        if (!wanted || held || asking || !options.lifecycle.isVisible()) return;
        asking = true;
        try {
          const sentinel = await api?.request('screen');
          if (!sentinel) return;
          if (!wanted) {
            // The screen stopped needing it while the request was on its way.
            await sentinel.release().catch(() => undefined);
            return;
          }
          held = sentinel;
          sentinel.addEventListener('release', () => {
            if (held === sentinel) held = null;
          });
        } catch {
          // Refused (low battery, no permission): the display may sleep. Nothing to tell anyone.
        } finally {
          asking = false;
        }
      }

      void acquire();
      const unsubscribe = options.lifecycle.subscribe({ visible: () => void acquire() });
      return () => {
        wanted = false;
        unsubscribe();
        const sentinel = held;
        held = null;
        void sentinel?.release().catch(() => undefined);
      };
    },
  };
}
