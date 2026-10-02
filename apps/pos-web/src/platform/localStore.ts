/**
 * Local storage seam for data that must survive a reload and, later, a lost connection (D-05
 * item 3, 02 §8). Features talk to `LocalStore` and never import Dexie or IndexedDB, so the P10
 * shells can swap the implementation (SQLite in Capacitor, a file in Electron).
 *
 * Two areas:
 * - `kv`: small JSON values by key (a remembered choice, a cached setting).
 * - `outbox`: actions that still have to reach the server, each keyed by its idempotency key
 *   (`id`), oldest first. The offline outbox (`pos/outbox-store.ts`) writes and replays it; this
 *   seam only stores rows and never looks inside `payload`.
 *
 * `openLocalStore` loads Dexie only when it is called, so the first screen does not pay for it,
 * and falls back to a memory store when IndexedDB is unavailable (Safari private mode, blocked
 * site data); `persistent` tells the caller which one it got. Safari deletes site data after 7
 * days without use unless the app is on the Home Screen (02 §12.1).
 */

/** An action waiting to reach the server. `payload` is plain JSON. */
export interface OutboxEntry {
  /** The idempotency key (`clientRequestId`), unique. */
  id: string;
  /** What to replay, e.g. `order.create`, `payment.confirm`. */
  kind: string;
  payload: unknown;
  /** Epoch milliseconds; the replay order. */
  createdAt: number;
  attempts: number;
  /** An error CODE only (never a message, a body or a name). */
  lastError?: string;
  /**
   * Whose entry it is. It is replayed, and its contents shown, only to this person on this
   * device. Not indexed: the queue is capped and small, so it is filtered in memory.
   */
  staffId?: string;
  deviceId?: string;
  /** `queued` waits to be sent; `attention` was refused and waits for a person. */
  state?: 'queued' | 'attention';
}

export interface LocalStore {
  /** False when this is the in-memory fallback: nothing survives a reload. */
  readonly persistent: boolean;
  kv: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };
  outbox: {
    /** Adds or replaces the entry with the same `id`. */
    put(entry: OutboxEntry): Promise<void>;
    /** Oldest first (`createdAt`, then `id`). */
    list(): Promise<OutboxEntry[]>;
    remove(id: string): Promise<void>;
    count(): Promise<number>;
  };
}

const byAge = (a: OutboxEntry, b: OutboxEntry) =>
  a.createdAt - b.createdAt || a.id.localeCompare(b.id);

export function createMemoryLocalStore(): LocalStore {
  const values = new Map<string, unknown>();
  const entries = new Map<string, OutboxEntry>();
  return {
    persistent: false,
    kv: {
      get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
      set: async (key, value) => void values.set(key, structuredClone(value)),
      remove: async (key) => void values.delete(key),
    },
    outbox: {
      put: async (entry) => void entries.set(entry.id, structuredClone(entry)),
      list: async () => [...entries.values()].map((e) => structuredClone(e)).sort(byAge),
      remove: async (id) => void entries.delete(id),
      count: async () => entries.size,
    },
  };
}

export interface OpenOptions {
  name?: string;
  /** Tests inject a failing opener; production uses Dexie. */
  open?: (name: string) => Promise<LocalStore>;
}

export async function openLocalStore(options: OpenOptions = {}): Promise<LocalStore> {
  const name = options.name ?? 'sds-pos';
  try {
    if (options.open) return await options.open(name);
    const { createDexieLocalStore } = await import('./dexieStore.ts');
    return await createDexieLocalStore(name);
  } catch {
    return createMemoryLocalStore();
  }
}
