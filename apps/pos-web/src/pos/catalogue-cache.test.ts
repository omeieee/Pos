import type { RealtimeFrame } from '@sds/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createStore } from '../lib/store.ts';
import { createMemoryLocalStore, type LocalStore } from '../platform/localStore.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import {
  categoryFrame,
  deliveryFrame,
  govCopayFrame,
  groupFrame,
  itemFrame,
  optionFrame,
  orderFrame,
  paymentFrame,
  settingsFrame,
  uuid,
} from '../test-support/frames.ts';
import {
  CATALOGUE_KEY,
  CATALOGUE_SCHEMA,
  CATALOGUE_SETTING_KEYS,
  createCatalogueCache,
} from './catalogue-cache.ts';

const ME = uuid(1);
const OTHER = uuid(2);
const DEBOUNCE = 1000;

const persistentStore = (): LocalStore => ({ ...createMemoryLocalStore(), persistent: true });

const menuFrames = (): RealtimeFrame[] => [
  categoryFrame(uuid(10), 30),
  itemFrame(uuid(11), 31),
  groupFrame(uuid(12), 32),
  optionFrame(uuid(13), uuid(12), 33),
  deliveryFrame(34),
];

function setup(
  options: {
    store?: LocalStore;
    staff?: string | null;
    entities?: ReturnType<typeof createEntityStore>;
    now?: () => number;
  } = {},
) {
  const store = options.store ?? persistentStore();
  const entities = options.entities ?? createEntityStore();
  const auth = createStore<{
    phase: 'booting' | 'unregistered' | 'locked' | 'signedIn';
    session: { staff: { id: string } } | null;
  }>({
    phase: options.staff === null ? 'locked' : 'signedIn',
    session: options.staff === null ? null : { staff: { id: options.staff ?? ME } },
  });
  const connection = createStore({ synced: false });
  const life = createFakeLifecycle();
  const cache = createCatalogueCache({
    entities,
    auth,
    connection,
    localStore: async () => store,
    lifecycle: life.lifecycle,
    now: options.now ?? (() => Date.now()),
    debounceMs: DEBOUNCE,
  });
  const unbind = cache.bind();
  const signInAs = (staff: string | null) =>
    auth.setState(
      staff === null
        ? { phase: 'locked', session: null }
        : { phase: 'signedIn', session: { staff: { id: staff } } },
    );
  return { store, entities, auth, connection, cache, unbind, signInAs, life };
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(0);
};
const saved = (store: LocalStore) => store.kv.get<Record<string, unknown>>(CATALOGUE_KEY);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('saving the menu and settings', () => {
  test('writes after a change, once for a burst, never at once', async () => {
    const { store, entities } = setup();
    await settle();
    entities.applyMany(menuFrames());
    await settle();
    expect(await saved(store)).toBeUndefined();
    entities.apply(itemFrame(uuid(11), 40, { nameTh: 'ชามใหม่' }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 10);
    expect(await saved(store)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    const blob = await saved(store);
    expect(blob).toMatchObject({ v: CATALOGUE_SCHEMA, staffId: ME });
    expect(typeof blob?.savedAt).toBe('number');
    expect(JSON.stringify(blob)).toContain('ชามใหม่');
  });

  test('keeps only the catalogue: no orders, payments, customers, PromptPay or co-pay', async () => {
    const { store, entities } = setup();
    await settle();
    entities.applyMany([
      ...menuFrames(),
      orderFrame(uuid(20), 50),
      paymentFrame(uuid(21), uuid(20), 51),
      settingsFrame('promptpay', 52, 1),
      govCopayFrame(53),
      settingsFrame('shop', 54, 1),
    ]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    const text = JSON.stringify(await saved(store));
    expect(text).not.toContain('idMasked');
    expect(text).not.toContain('order.upserted');
    expect(text).not.toContain('payment.upserted');
    expect(text).not.toContain('gov_copay');
    expect(text).not.toContain('promptpay');
    expect(text).not.toContain('Token');
    expect(text).toContain('delivery');
    for (const key of CATALOGUE_SETTING_KEYS) expect(key).not.toBe('promptpay');
  });

  test('going to the background writes a pending change at once', async () => {
    const { store, entities, life } = setup();
    await settle();
    entities.applyMany(menuFrames());
    life.hide();
    await settle();
    expect(await saved(store)).toBeDefined();
  });

  test('a setting that was never saved (version 0, read over REST) is kept and read back', async () => {
    const first = setup();
    await settle();
    first.entities.applyMany([...menuFrames().slice(0, 4), { ...deliveryFrame(0), version: 0 }]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    first.unbind();
    const again = setup({ store: first.store });
    await settle();
    expect(again.entities.getState().settings.has('delivery')).toBe(true);
    expect(again.entities.getState().items.size).toBe(1);
  });

  test('an empty store never overwrites a good copy (a reset on sign-out is not a change)', async () => {
    const { store, entities, signInAs } = setup();
    await settle();
    entities.applyMany(menuFrames());
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    const before = await saved(store);
    entities.reset();
    signInAs(null);
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 3);
    expect(await saved(store)).toEqual(before);
  });

  test('a pending write is dropped when the person signs out', async () => {
    const { store, entities, signInAs } = setup();
    await settle();
    entities.applyMany(menuFrames());
    signInAs(null);
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 3);
    expect(await saved(store)).toBeUndefined();
  });

  test('a device that cannot keep data writes nothing and nothing breaks', async () => {
    const memory = createMemoryLocalStore();
    const { entities } = setup({ store: memory });
    await settle();
    entities.applyMany(menuFrames());
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    expect(await memory.kv.get(CATALOGUE_KEY)).toBeUndefined();
  });

  test('a failed write is swallowed', async () => {
    const store = persistentStore();
    store.kv.set = async () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    const { entities } = setup({ store });
    await settle();
    entities.applyMany(menuFrames());
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    expect(entities.getState().items.size).toBe(1);
  });
});

describe('reading it at start-up', () => {
  async function savedBy(staff: string) {
    const first = setup({ staff });
    await settle();
    first.entities.applyMany(menuFrames());
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    first.unbind();
    return first.store;
  }

  test('the same person after a reload gets the menu and settings back before any network', async () => {
    const store = await savedBy(ME);
    const again = setup({ store });
    await settle();
    const state = again.entities.getState();
    expect(state.items.has(uuid(11))).toBe(true);
    expect(state.categories.has(uuid(10))).toBe(true);
    expect(state.groups.has(uuid(12))).toBe(true);
    expect(state.options.has(uuid(13))).toBe(true);
    expect(state.settings.has('delivery')).toBe(true);
    expect(state.lastRev).toBe(0);
    expect(again.cache.getState().fromCache).toBe(true);
    expect(typeof again.cache.getState().savedAt).toBe('number');
  });

  test('reading it again does not rewrite it, so the saved-at time stays the time of the data', async () => {
    let clock = 1_000_000;
    const first = setup({ now: () => clock });
    await settle();
    first.entities.applyMany(menuFrames());
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    first.unbind();
    clock = 9_000_000;
    const again = setup({ store: first.store, now: () => clock });
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 3);
    expect((await saved(first.store))?.savedAt).toBe(1_000_000);
    expect(again.cache.getState().savedAt).toBe(1_000_000);
  });

  test('a different person signing in clears it and does not get it', async () => {
    const store = await savedBy(ME);
    const other = setup({ store, staff: OTHER });
    await settle();
    expect(other.entities.getState().items.size).toBe(0);
    expect(other.cache.getState().fromCache).toBe(false);
    expect(await saved(store)).toBeUndefined();
  });

  test('signing out and back in as the same person keeps it; as another person clears it', async () => {
    const store = await savedBy(ME);
    const env = setup({ store });
    await settle();
    env.signInAs(null);
    env.entities.reset();
    env.signInAs(ME);
    await settle();
    expect(env.entities.getState().items.has(uuid(11))).toBe(true);
    env.signInAs(null);
    env.entities.reset();
    env.signInAs(OTHER);
    await settle();
    expect(env.entities.getState().items.size).toBe(0);
    expect(await saved(store)).toBeUndefined();
  });

  test('a copy of another schema version is dropped, not read', async () => {
    const store = await savedBy(ME);
    const blob = await saved(store);
    await store.kv.set(CATALOGUE_KEY, { ...blob, v: CATALOGUE_SCHEMA + 1 });
    const again = setup({ store });
    await settle();
    expect(again.entities.getState().items.size).toBe(0);
    expect(await saved(store)).toBeUndefined();
  });

  test('a damaged copy is dropped, not read', async () => {
    const store = persistentStore();
    await store.kv.set(CATALOGUE_KEY, { v: CATALOGUE_SCHEMA, staffId: ME, frames: 'nope' });
    const again = setup({ store });
    await settle();
    expect(again.entities.getState().items.size).toBe(0);
    expect(await saved(store)).toBeUndefined();
  });

  test('a PromptPay frame smuggled into the copy is ignored, the rest is kept', async () => {
    const store = await savedBy(ME);
    const blob = (await saved(store)) as { frames: unknown[] };
    await store.kv.set(CATALOGUE_KEY, {
      ...blob,
      frames: [...blob.frames, settingsFrame('promptpay', 99, 1)],
    });
    const again = setup({ store });
    await settle();
    expect(again.entities.getState().settings.has('promptpay')).toBe(false);
    expect(again.entities.getState().items.has(uuid(11))).toBe(true);
  });

  test('a copy that holds anything but menu and settings frames is dropped whole', async () => {
    const store = await savedBy(ME);
    const blob = (await saved(store)) as { frames: unknown[] };
    await store.kv.set(CATALOGUE_KEY, {
      ...blob,
      frames: [...blob.frames, orderFrame(uuid(20), 98)],
    });
    const again = setup({ store });
    await settle();
    expect(again.entities.getState().orders.size).toBe(0);
    expect(again.entities.getState().items.size).toBe(0);
    expect(await saved(store)).toBeUndefined();
  });

  test('a newer row from the server beats the saved copy', async () => {
    const store = await savedBy(ME);
    const entities = createEntityStore();
    entities.apply(itemFrame(uuid(11), 900, { nameTh: 'สดจากเซิร์ฟเวอร์' }));
    setup({ store, entities });
    await settle();
    expect(entities.getState().items.get(uuid(11))?.nameTh).toBe('สดจากเซิร์ฟเวอร์');
  });

  test('says it is from the saved copy until the server has answered', async () => {
    const store = await savedBy(ME);
    const again = setup({ store });
    await settle();
    expect(again.cache.getState().fromCache).toBe(true);
    again.connection.setState({ synced: true });
    expect(again.cache.getState().fromCache).toBe(false);
  });
});
