import { describe, expect, test, vi } from 'vitest';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { createWebWakeLock, type WakeLockApi } from './wakeLock.ts';

/** A Wake Lock API that, like the real one, drops its lock when the page is hidden. */
function fakeApi(options: { rejects?: boolean } = {}) {
  const sentinels: { released: boolean; release: () => Promise<void>; drop: () => void }[] = [];
  const api: WakeLockApi = {
    request: vi.fn(async () => {
      if (options.rejects) throw new DOMException('low battery', 'NotAllowedError');
      const listeners: (() => void)[] = [];
      const sentinel = {
        released: false,
        release: vi.fn(async () => {
          sentinel.released = true;
        }),
        addEventListener: (_: 'release', l: () => void) => void listeners.push(l),
        /** What the browser does when the page goes to the background. */
        drop: () => {
          sentinel.released = true;
          for (const l of listeners) l();
        },
      };
      sentinels.push(sentinel);
      return sentinel;
    }),
  };
  return { api, sentinels };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('keeping the screen awake', () => {
  test('asks for a screen lock and releases it when the screen no longer needs it', async () => {
    const { api, sentinels } = fakeApi();
    const life = createFakeLifecycle();
    const wake = createWebWakeLock({ api, lifecycle: life.lifecycle });
    const stop = wake.keepAwake();
    await flush();
    expect(api.request).toHaveBeenCalledWith('screen');
    expect(sentinels[0]?.released).toBe(false);
    stop();
    await flush();
    expect(sentinels[0]?.released).toBe(true);
    expect(life.listenerCount()).toBe(0);
  });

  test('asks again when the page comes back to the front (the browser dropped the lock)', async () => {
    const { api, sentinels } = fakeApi();
    const life = createFakeLifecycle();
    const wake = createWebWakeLock({ api, lifecycle: life.lifecycle });
    wake.keepAwake();
    await flush();
    life.hide();
    sentinels[0]?.drop();
    life.show();
    await flush();
    expect(api.request).toHaveBeenCalledTimes(2);
    expect(sentinels[1]?.released).toBe(false);
  });

  test('does not ask twice while a lock is held', async () => {
    const { api } = fakeApi();
    const life = createFakeLifecycle();
    createWebWakeLock({ api, lifecycle: life.lifecycle }).keepAwake();
    await flush();
    life.show();
    await flush();
    expect(api.request).toHaveBeenCalledTimes(1);
  });

  test('does not ask while the page is hidden', async () => {
    const { api } = fakeApi();
    const life = createFakeLifecycle({ visible: false });
    createWebWakeLock({ api, lifecycle: life.lifecycle }).keepAwake();
    await flush();
    expect(api.request).not.toHaveBeenCalled();
    life.show();
    await flush();
    expect(api.request).toHaveBeenCalledTimes(1);
  });

  test('a lock that arrives after the screen stopped needing it is let go at once', async () => {
    const { api, sentinels } = fakeApi();
    const life = createFakeLifecycle();
    const stop = createWebWakeLock({ api, lifecycle: life.lifecycle }).keepAwake();
    stop();
    await flush();
    expect(sentinels[0]?.released).toBe(true);
  });

  test('a refusal (low battery, no permission) is quiet: the display just may sleep', async () => {
    const { api } = fakeApi({ rejects: true });
    const life = createFakeLifecycle();
    const wake = createWebWakeLock({ api, lifecycle: life.lifecycle });
    expect(() => wake.keepAwake()).not.toThrow();
    await flush();
    expect(api.request).toHaveBeenCalledTimes(1);
  });

  test('where the browser has no Wake Lock (older iOS) it is a no-op and says so', () => {
    const life = createFakeLifecycle();
    const wake = createWebWakeLock({ api: null, lifecycle: life.lifecycle });
    expect(wake.supported).toBe(false);
    const stop = wake.keepAwake();
    expect(life.listenerCount()).toBe(0);
    expect(() => stop()).not.toThrow();
  });
});
