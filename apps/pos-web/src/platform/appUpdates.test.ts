import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { createAppUpdates, type ServiceWorkerHost } from './appUpdates.ts';

function setup(options: { busy?: () => boolean } = {}) {
  const life = createFakeLifecycle();
  const registration = { update: vi.fn(async () => undefined) };
  const applyUpdate = vi.fn(async (_reload: boolean) => undefined);
  let needRefresh: (() => void) | undefined;
  let registered: ((r: typeof registration | undefined) => void) | undefined;
  const host: ServiceWorkerHost = {
    register(handlers) {
      needRefresh = handlers.onNeedRefresh;
      registered = handlers.onRegistered;
      return applyUpdate;
    },
  };
  const updates = createAppUpdates({
    host,
    lifecycle: life.lifecycle,
    isBusy: options.busy ?? (() => false),
    checkEveryMs: 60 * 60 * 1000,
  });
  return {
    updates,
    life,
    registration,
    applyUpdate,
    newVersionFound: () => needRefresh?.(),
    registrationReady: () => registered?.(registration),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('app updates (service worker)', () => {
  test('nothing is pending until the service worker finds a new version', () => {
    const env = setup();
    env.updates.start();
    expect(env.updates.getState().needRefresh).toBe(false);
    env.newVersionFound();
    expect(env.updates.getState().needRefresh).toBe(true);
  });

  test('start() registers once', () => {
    const registerSpy = vi.fn(() => async () => undefined);
    const updates = createAppUpdates({
      host: { register: registerSpy },
      lifecycle: createFakeLifecycle().lifecycle,
      isBusy: () => false,
    });
    updates.start();
    updates.start();
    expect(registerSpy).toHaveBeenCalledTimes(1);
  });

  test('apply() activates the waiting version and reloads, once', async () => {
    const env = setup();
    env.updates.start();
    env.newVersionFound();
    await Promise.all([env.updates.apply(), env.updates.apply()]);
    expect(env.applyUpdate).toHaveBeenCalledTimes(1);
    expect(env.applyUpdate).toHaveBeenCalledWith(true);
  });

  test('checks for a new version every hour, so a Home Screen app that never closes finds it', async () => {
    const env = setup();
    env.updates.start();
    env.registrationReady();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(env.registration.update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(env.registration.update).toHaveBeenCalledTimes(3);
  });

  test('checks when the app comes back to the front', () => {
    const env = setup();
    env.updates.start();
    env.registrationReady();
    env.life.show();
    expect(env.registration.update).toHaveBeenCalledTimes(1);
  });

  test('a failed check (offline) is not an error', async () => {
    const env = setup();
    env.registration.update.mockRejectedValue(new Error('offline'));
    env.updates.start();
    env.registrationReady();
    env.life.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(env.updates.getState().needRefresh).toBe(false);
  });

  describe('stop()', () => {
    test('clears the hourly check and the lifecycle subscription', async () => {
      const env = setup();
      env.updates.start();
      env.registrationReady();
      expect(env.life.listenerCount()).toBe(1);
      env.updates.stop();
      expect(env.life.listenerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
      expect(env.registration.update).not.toHaveBeenCalled();
      // Nothing is applied after teardown either.
      env.newVersionFound();
      env.life.hide();
      expect(env.applyUpdate).not.toHaveBeenCalled();
    });

    test('is harmless before start() and when called twice', () => {
      const env = setup();
      env.updates.stop();
      env.updates.start();
      env.updates.stop();
      env.updates.stop();
      expect(env.life.listenerCount()).toBe(0);
    });

    test('start() works again after a stop() and checks again', async () => {
      const env = setup();
      env.updates.start();
      env.registrationReady();
      env.updates.stop();
      env.updates.start();
      env.registrationReady();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(env.registration.update).toHaveBeenCalledTimes(1);
      expect(env.life.listenerCount()).toBe(1);
    });
  });

  describe('applying on its own', () => {
    test('when the app goes to the background and nothing is in progress', () => {
      const env = setup();
      env.updates.start();
      env.newVersionFound();
      env.life.hide();
      expect(env.applyUpdate).toHaveBeenCalledWith(true);
    });

    test('never while something is in progress (an order being rung up)', () => {
      let busy = true;
      const env = setup({ busy: () => busy });
      env.updates.start();
      env.newVersionFound();
      env.life.hide();
      expect(env.applyUpdate).not.toHaveBeenCalled();
      expect(env.updates.getState().needRefresh).toBe(true);
      busy = false;
      env.life.hide();
      expect(env.applyUpdate).toHaveBeenCalledTimes(1);
    });

    test('not when no update is waiting', () => {
      const env = setup();
      env.updates.start();
      env.life.hide();
      expect(env.applyUpdate).not.toHaveBeenCalled();
    });
  });
});
