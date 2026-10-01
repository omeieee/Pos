/**
 * Token storage seam (02 §12.2). Features never touch localStorage directly: the P10 shells
 * swap this for the iOS Keychain or the Electron safe-storage API, which is why every method
 * is async even though the web versions are not.
 *
 * What is kept, and where:
 * - the device registration (token + name) is long-lived and survives a reload: durable area.
 *   Safari deletes it after 7 days without use unless the app is on the Home Screen (02 §12.1).
 * - a staff PIN session survives an accidental reload or an iOS page discard but not closing
 *   the tab: tab area. It is bound to the device token on the server.
 * - the owner's password session is never stored, so it is not part of this interface.
 *
 * Stored JSON is validated with the shared response schemas on the way back, so a corrupted
 * or hand-edited value counts as "nothing stored". Nothing here logs or returns a token in an
 * error.
 */
import {
  type RegisterDeviceResponse,
  registerDeviceResponseSchema,
  type SessionResponse,
  sessionResponseSchema,
} from '@sds/shared';

export interface TokenStore {
  loadDevice(): Promise<RegisterDeviceResponse | null>;
  saveDevice(device: RegisterDeviceResponse): Promise<void>;
  clearDevice(): Promise<void>;
  loadSession(): Promise<SessionResponse | null>;
  saveSession(session: SessionResponse): Promise<void>;
  clearSession(): Promise<void>;
}

/** The little we need from a Storage; lets tests and the fallback share one shape. */
export interface KeyValue {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const DEVICE_KEY = 'sds.device.v1';
export const SESSION_KEY = 'sds.session.v1';

export function memoryKeyValue(): KeyValue {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
    remove: (key) => void map.delete(key),
  };
}

/**
 * A browser Storage that never throws. Reading `localStorage` can raise SecurityError when site
 * data is blocked, and `setItem` can fail on a full quota or an old private-mode Safari; in
 * those cases the value lives in memory for this page load instead.
 */
export function storageKeyValue(area: () => Storage | undefined): KeyValue {
  const fallback = memoryKeyValue();
  return {
    get(key) {
      try {
        const stored = area()?.getItem(key);
        if (stored !== null && stored !== undefined) return stored;
      } catch {
        // fall through to memory
      }
      return fallback.get(key);
    },
    set(key, value) {
      try {
        const storage = area();
        if (storage) {
          storage.setItem(key, value);
          fallback.remove(key);
          return;
        }
      } catch {
        // fall through to memory
      }
      fallback.set(key, value);
    },
    remove(key) {
      try {
        area()?.removeItem(key);
      } catch {
        // nothing to remove from
      }
      fallback.remove(key);
    },
  };
}

function readJson<T>(
  kv: KeyValue,
  key: string,
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false } },
): T | null {
  const raw = kv.get(key);
  if (raw === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // not JSON
  }
  kv.remove(key);
  return null;
}

export function createTokenStore(areas: { durable: KeyValue; tab: KeyValue }): TokenStore {
  return {
    loadDevice: async () => readJson(areas.durable, DEVICE_KEY, registerDeviceResponseSchema),
    saveDevice: async (device) => areas.durable.set(DEVICE_KEY, JSON.stringify(device)),
    clearDevice: async () => areas.durable.remove(DEVICE_KEY),
    loadSession: async () => readJson(areas.tab, SESSION_KEY, sessionResponseSchema),
    saveSession: async (session) => areas.tab.set(SESSION_KEY, JSON.stringify(session)),
    clearSession: async () => areas.tab.remove(SESSION_KEY),
  };
}

export function createWebTokenStore(): TokenStore {
  return createTokenStore({
    durable: storageKeyValue(() => globalThis.localStorage),
    tab: storageKeyValue(() => globalThis.sessionStorage),
  });
}

export function createMemoryTokenStore(): TokenStore {
  return createTokenStore({ durable: memoryKeyValue(), tab: memoryKeyValue() });
}
