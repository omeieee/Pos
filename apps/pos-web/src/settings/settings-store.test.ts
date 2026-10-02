import { DEFAULT_SHOP_SETTINGS } from '@sds/shared';
import { describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { createSettingsStore, type SettingsDeps } from './settings-store.ts';

const NOW = '2026-10-03T03:00:00.000Z';
const answer = <V>(value: V, version: number) => ({
  value,
  version,
  rev: version * 10,
  updatedAt: NOW,
});

function env(options: { shop?: Partial<ApiClient['settings']['shop']>; online?: boolean } = {}) {
  const shop = {
    read: vi.fn(options.shop?.read ?? (async () => answer(DEFAULT_SHOP_SETTINGS, 0))),
    save: vi.fn(options.shop?.save ?? (async () => answer(DEFAULT_SHOP_SETTINGS, 1))),
  };
  const unused = { read: vi.fn(), save: vi.fn() };
  const online = options.online ?? true;
  const store = createSettingsStore({
    api: {
      settings: {
        shop,
        openingHours: unused,
        numbering: unused,
        payments: unused,
        deliveryList: unused,
      } as unknown as ApiClient['settings'],
    },
    lifecycle: { isOnline: () => online },
    auth: { runSensitive: async (call) => ({ ok: true as const, value: await call() }) },
  });
  return { store, shop };
}

describe('load', () => {
  test('reads a resource once and keeps its value and version', async () => {
    const { store, shop } = env();
    expect(store.getState().slots.shop.status).toBe('idle');
    await Promise.all([store.load('shop'), store.load('shop')]);
    expect(shop.read).toHaveBeenCalledTimes(1);
    expect(store.getState().slots.shop).toMatchObject({
      status: 'ready',
      loaded: { value: DEFAULT_SHOP_SETTINGS, version: 0 },
    });
  });

  test('a failed first read is an error with the code; a later failed read keeps what is shown', async () => {
    let fail = true;
    const { store } = env({
      shop: {
        read: async () => {
          if (fail) throw new ApiClientError('NETWORK');
          return answer(DEFAULT_SHOP_SETTINGS, 2);
        },
      },
    });
    await store.load('shop');
    expect(store.getState().slots.shop).toMatchObject({ status: 'error', loaded: null });
    expect(store.getState().slots.shop.error?.code).toBe('NETWORK');
    fail = false;
    await store.load('shop');
    expect(store.getState().slots.shop.status).toBe('ready');
    fail = true;
    await store.load('shop');
    expect(store.getState().slots.shop).toMatchObject({ status: 'ready' });
    expect(store.getState().slots.shop.loaded?.version).toBe(2);
  });
});

describe('save', () => {
  test('sends the body it was given, then holds the answer', async () => {
    const { store, shop } = env({
      shop: { save: async () => answer({ ...DEFAULT_SHOP_SETTINGS, phone: '0812345678' }, 3) },
    });
    const outcome = await store.save('shop', { expectedVersion: 2, phone: '0812345678' });
    expect(outcome).toMatchObject({ ok: true });
    expect(shop.save).toHaveBeenCalledTimes(1);
    expect(store.getState().slots.shop.loaded).toMatchObject({
      version: 3,
      value: { phone: '0812345678' },
    });
    expect(store.getState().pending).toEqual([]);
  });

  test('offline: nothing is sent and nothing is queued', async () => {
    const { store, shop } = env({ online: false });
    expect(await store.save('shop', { expectedVersion: 1, phone: null })).toEqual({
      ok: false,
      reason: 'offline',
    });
    expect(shop.save).not.toHaveBeenCalled();
  });

  test('a second tap while one is on its way sends nothing', async () => {
    let release: () => void = () => undefined;
    const { store, shop } = env({
      shop: {
        save: () =>
          new Promise((resolve) => {
            release = () => resolve(answer(DEFAULT_SHOP_SETTINGS, 1));
          }),
      },
    });
    const first = store.save('shop', { expectedVersion: 0, phone: null });
    const second = await store.save('shop', { expectedVersion: 0, phone: null });
    expect(second).toEqual({ ok: false, reason: 'busy' });
    release();
    await first;
    expect(shop.save).toHaveBeenCalledTimes(1);
  });

  test('VERSION_CONFLICT reads the setting again and says so; no retry by itself', async () => {
    const { store, shop } = env({
      shop: {
        save: async () => {
          throw new ApiClientError('VERSION_CONFLICT', { status: 409, currentVersion: 5 });
        },
        read: async () => answer({ ...DEFAULT_SHOP_SETTINGS, nameTh: 'ชื่อใหม่จากเครื่องอื่น' }, 5),
      },
    });
    const outcome = await store.save('shop', { expectedVersion: 4, phone: null });
    expect(outcome).toMatchObject({ ok: false, reason: 'error', refreshed: true });
    expect(shop.save).toHaveBeenCalledTimes(1);
    expect(store.getState().slots.shop.loaded).toMatchObject({
      version: 5,
      value: { nameTh: 'ชื่อใหม่จากเครื่องอื่น' },
    });
  });

  test('any other refusal is reported as it is, without a re-read', async () => {
    const { store, shop } = env({
      shop: {
        save: async () => {
          throw new ApiClientError('VALIDATION_ERROR', { status: 400 });
        },
      },
    });
    const outcome = await store.save('shop', { expectedVersion: 1, phone: null });
    expect(outcome).toMatchObject({ ok: false, reason: 'error', refreshed: false });
    expect(shop.read).not.toHaveBeenCalled();
  });

  test('an answer that arrives after sign-out changes nothing', async () => {
    let release: () => void = () => undefined;
    const { store } = env({
      shop: {
        save: () =>
          new Promise((resolve) => {
            release = () => resolve(answer(DEFAULT_SHOP_SETTINGS, 9));
          }),
      },
    });
    const pending = store.save('shop', { expectedVersion: 0, phone: null });
    store.reset();
    release();
    expect(await pending).toEqual({ ok: false, reason: 'stale' });
    expect(store.getState().slots.shop).toMatchObject({ status: 'idle', loaded: null });
  });
});

describe('the PromptPay ID (sensitive: a step-up comes first)', () => {
  const masked = { idType: 'phone' as const, idMasked: '******1234' };
  const input = { expectedVersion: 2, idType: 'phone' as const, idValue: '0899990000' };

  function promptpayEnv(runSensitive: SettingsDeps['auth']['runSensitive']) {
    const promptpay = {
      read: vi.fn(async () => answer(masked, 2)),
      save: vi.fn(async () => answer({ idType: 'phone' as const, idMasked: '******0000' }, 3)),
    };
    const unused = { read: vi.fn(), save: vi.fn() };
    const store = createSettingsStore({
      api: {
        settings: {
          shop: unused,
          openingHours: unused,
          numbering: unused,
          payments: unused,
          deliveryList: unused,
          promptpayMasked: promptpay,
        } as unknown as ApiClient['settings'],
      },
      lifecycle: { isOnline: () => true },
      auth: { runSensitive },
    });
    return { store, promptpay };
  }

  test('the change runs inside the step-up, and the saved value held is masked', async () => {
    let asked = 0;
    const { store, promptpay } = promptpayEnv(async (call) => {
      asked += 1;
      return { ok: true as const, value: await call() };
    });
    const outcome = await store.save('promptpay', input);
    expect(asked).toBe(1);
    expect(outcome).toMatchObject({ ok: true });
    expect(promptpay.save).toHaveBeenCalledWith(input);
    expect(store.getState().slots.promptpay.loaded).toEqual({
      value: { idType: 'phone', idMasked: '******0000' },
      version: 3,
    });
    // Nothing the store holds contains the ID that was typed.
    expect(JSON.stringify(store.getState())).not.toContain('0899990000');
  });

  test('a step-up the person closes is "cancelled": nothing is sent and no error is shown', async () => {
    const { store, promptpay } = promptpayEnv(async () => ({ ok: false as const, error: null }));
    expect(await store.save('promptpay', input)).toEqual({ ok: false, reason: 'cancelled' });
    expect(promptpay.save).not.toHaveBeenCalled();
    expect(store.getState().pending).toEqual([]);
  });

  test('a refusal the server gives is reported with its code', async () => {
    const { store } = promptpayEnv(async () => ({
      ok: false as const,
      error: new ApiClientError('FORBIDDEN', { status: 403 }),
    }));
    expect(await store.save('promptpay', input)).toMatchObject({
      ok: false,
      reason: 'error',
      refreshed: false,
    });
  });
});
