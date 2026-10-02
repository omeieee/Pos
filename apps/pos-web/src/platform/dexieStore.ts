/**
 * The IndexedDB implementation of `LocalStore`, on Dexie. Only `localStore.ts` imports this file
 * (lazily): no feature may. Schema version 1 is the stub the offline slice builds on; a later
 * change adds `this.version(2)` and never edits version 1.
 */
import Dexie, { type EntityTable } from 'dexie';
import type { LocalStore, OutboxEntry } from './localStore.ts';

interface KvRow {
  key: string;
  value: unknown;
}

class SdsDatabase extends Dexie {
  kv!: EntityTable<KvRow, 'key'>;
  outbox!: EntityTable<OutboxEntry, 'id'>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      kv: 'key',
      outbox: 'id, createdAt',
    });
  }
}

export async function createDexieLocalStore(name: string): Promise<LocalStore> {
  const db = new SdsDatabase(name);
  // Opens now, so an unavailable IndexedDB fails here (and the caller falls back) and not on first use.
  await db.open();
  return {
    persistent: true,
    kv: {
      get: async <T>(key: string) => (await db.kv.get(key))?.value as T | undefined,
      set: async (key, value) => void (await db.kv.put({ key, value })),
      remove: async (key) => void (await db.kv.delete(key)),
    },
    outbox: {
      put: async (entry) => void (await db.outbox.put(entry)),
      list: async () => {
        const all = await db.outbox.orderBy('createdAt').toArray();
        // Same `createdAt`: the id breaks the tie, as in the memory store.
        return all.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      },
      remove: async (id) => void (await db.outbox.delete(id)),
      count: async () => db.outbox.count(),
    },
  };
}
