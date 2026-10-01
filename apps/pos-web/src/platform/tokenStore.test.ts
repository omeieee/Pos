import { describe, expect, test } from 'vitest';
import { FAKE_DEVICE_TOKEN, IDS, sessionBody } from '../test-support/fixtures.ts';
import {
  createMemoryTokenStore,
  createTokenStore,
  DEVICE_KEY,
  memoryKeyValue,
  SESSION_KEY,
  storageKeyValue,
} from './tokenStore.ts';

const device = {
  deviceToken: FAKE_DEVICE_TOKEN,
  device: { id: IDS.device, name: 'iPad ตัวอย่าง', kind: 'ipad' as const },
};

/** A Storage that fails like Safari with site data blocked. */
const brokenStorage = (): Storage =>
  new Proxy({} as Storage, {
    get() {
      throw new DOMException('blocked', 'SecurityError');
    },
  });

describe('token store', () => {
  test('keeps the device registration and the session apart', async () => {
    const store = createMemoryTokenStore();
    expect(await store.loadDevice()).toBeNull();
    expect(await store.loadSession()).toBeNull();

    await store.saveDevice(device);
    await store.saveSession(sessionBody('cashier'));
    expect(await store.loadDevice()).toEqual(device);
    expect((await store.loadSession())?.staff.role).toBe('cashier');

    await store.clearSession();
    expect(await store.loadSession()).toBeNull();
    expect(await store.loadDevice()).toEqual(device);

    await store.clearDevice();
    expect(await store.loadDevice()).toBeNull();
  });

  test('puts the device in the durable area and the session in the tab area', async () => {
    const durable = memoryKeyValue();
    const tab = memoryKeyValue();
    const store = createTokenStore({ durable, tab });
    await store.saveDevice(device);
    await store.saveSession(sessionBody('cashier'));
    expect(durable.get(DEVICE_KEY)).not.toBeNull();
    expect(durable.get(SESSION_KEY)).toBeNull();
    expect(tab.get(SESSION_KEY)).not.toBeNull();
    expect(tab.get(DEVICE_KEY)).toBeNull();
  });

  test('treats corrupted or wrongly shaped stored values as nothing stored', async () => {
    const durable = memoryKeyValue();
    const tab = memoryKeyValue();
    const store = createTokenStore({ durable, tab });
    durable.set(DEVICE_KEY, '{not json');
    tab.set(SESSION_KEY, JSON.stringify({ sessionToken: 42 }));
    expect(await store.loadDevice()).toBeNull();
    expect(await store.loadSession()).toBeNull();
    // ...and the bad values are gone, not retried on every start.
    expect(durable.get(DEVICE_KEY)).toBeNull();
    expect(tab.get(SESSION_KEY)).toBeNull();
  });
});

describe('storageKeyValue', () => {
  test('never throws when site data is blocked: the value lives in memory', () => {
    const kv = storageKeyValue(() => brokenStorage());
    expect(() => kv.set('k', 'v')).not.toThrow();
    expect(kv.get('k')).toBe('v');
    expect(() => kv.remove('k')).not.toThrow();
    expect(kv.get('k')).toBeNull();
  });

  test('falls back to memory when the area is missing', () => {
    const kv = storageKeyValue(() => undefined);
    kv.set('k', 'v');
    expect(kv.get('k')).toBe('v');
  });

  test('writes through to the real storage when it works', () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    } as unknown as Storage;
    const kv = storageKeyValue(() => storage);
    kv.set('k', 'v');
    expect(backing.get('k')).toBe('v');
    kv.remove('k');
    expect(backing.has('k')).toBe(false);
  });
});
