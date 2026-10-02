import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'vitest';
import { createDexieLocalStore } from './dexieStore.ts';
import {
  createMemoryLocalStore,
  type LocalStore,
  type OutboxEntry,
  openLocalStore,
} from './localStore.ts';

const entry = (id: string, createdAt: number, over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id,
  kind: 'order.create',
  payload: { note: 'ตัวอย่าง' },
  createdAt,
  attempts: 0,
  ...over,
});

let counter = 0;
const factories: [string, () => Promise<LocalStore>][] = [
  ['memory', async () => createMemoryLocalStore()],
  ['Dexie (IndexedDB)', async () => createDexieLocalStore(`test-db-${++counter}`)],
];

describe.each(factories)('the local store: %s', (_name, make) => {
  test('keeps and returns a value, and forgets it on remove', async () => {
    const store = await make();
    expect(await store.kv.get('missing')).toBeUndefined();
    await store.kv.set('last-used', { a: [1, 2] });
    expect(await store.kv.get('last-used')).toEqual({ a: [1, 2] });
    await store.kv.remove('last-used');
    expect(await store.kv.get('last-used')).toBeUndefined();
  });

  test('a value is replaced, not merged', async () => {
    const store = await make();
    await store.kv.set('k', { a: 1, b: 2 });
    await store.kv.set('k', { a: 3 });
    expect(await store.kv.get('k')).toEqual({ a: 3 });
  });

  test('the outbox lists entries oldest first and counts them', async () => {
    const store = await make();
    await store.outbox.put(entry('b', 20));
    await store.outbox.put(entry('a', 10));
    await store.outbox.put(entry('c', 20));
    expect((await store.outbox.list()).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(await store.outbox.count()).toBe(3);
  });

  test('putting an entry with the same id (the idempotency key) replaces it', async () => {
    const store = await make();
    await store.outbox.put(entry('a', 10));
    await store.outbox.put(entry('a', 10, { attempts: 2, lastError: 'NETWORK' }));
    const [only] = await store.outbox.list();
    expect(await store.outbox.count()).toBe(1);
    expect(only).toMatchObject({ id: 'a', attempts: 2, lastError: 'NETWORK' });
  });

  test('removing an entry leaves the others', async () => {
    const store = await make();
    await store.outbox.put(entry('a', 10));
    await store.outbox.put(entry('b', 11));
    await store.outbox.remove('a');
    expect((await store.outbox.list()).map((e) => e.id)).toEqual(['b']);
  });
});

describe('opening the store', () => {
  afterEach(() => {
    // each test installs its own IndexedDB
  });

  test('uses IndexedDB when it works and says so', async () => {
    const store = await openLocalStore({ name: 'open-ok' });
    expect(store.persistent).toBe(true);
    await store.kv.set('x', 1);
    expect(await store.kv.get('x')).toBe(1);
  });

  test('falls back to memory when IndexedDB cannot be opened (private mode, blocked storage)', async () => {
    const store = await openLocalStore({
      name: 'open-fail',
      open: async () => {
        throw new Error('SecurityError');
      },
    });
    expect(store.persistent).toBe(false);
    await store.outbox.put(entry('a', 1));
    expect(await store.outbox.count()).toBe(1);
  });
});
