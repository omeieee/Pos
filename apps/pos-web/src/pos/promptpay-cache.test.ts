import type { Permission } from '@sds/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { createStore } from '../lib/store.ts';
import { createMemoryLocalStore, type LocalStore } from '../platform/localStore.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import { createFakeLifecycle } from '../test-support/fake-realtime.ts';
import { settingsFrame, uuid } from '../test-support/frames.ts';
import {
  OFFLINE_QR_MAX_AGE_MS,
  PROMPTPAY_CACHE_KEY,
  PROMPTPAY_CACHE_SCHEMA,
  type SavedPromptpay,
} from './offline-promptpay-model.ts';
import { createPromptpayCache } from './promptpay-cache.ts';

const ME = uuid(1);
const OTHER = uuid(2);
const DEVICE = uuid(3);
/** A made-up number in the right shape: never a real account. */
const ID = '0812345678';
const NEW_ID = '0899990000';

const answer = (idValue: string, rev: number) => ({
  value: { idType: 'phone' as const, idValue },
  version: 1,
  rev,
  updatedAt: '2030-10-15T05:00:00.000Z',
});

/** A persistent store that remembers every value written, so a test can search them. */
function recordingStore() {
  const base: LocalStore = { ...createMemoryLocalStore(), persistent: true };
  const written: string[] = [];
  const store: LocalStore = {
    ...base,
    kv: {
      ...base.kv,
      set: async (key, value) => {
        written.push(`${key}=${JSON.stringify(value)}`);
        return base.kv.set(key, value);
      },
    },
    outbox: {
      ...base.outbox,
      put: async (entry) => {
        written.push(`outbox=${JSON.stringify(entry)}`);
        return base.outbox.put(entry);
      },
    },
  };
  return { store, written };
}

const saved = (over: Partial<SavedPromptpay> = {}): SavedPromptpay => ({
  v: PROMPTPAY_CACHE_SCHEMA,
  staffId: ME,
  savedAt: Date.now() - 1000,
  rev: 20,
  stale: false,
  target: { idType: 'phone', idValue: ID },
  ...over,
});

type Phase = 'booting' | 'unregistered' | 'locked' | 'signedIn';

function setup(
  options: {
    store?: LocalStore;
    staff?: string | null;
    permissions?: readonly Permission[];
    fetch?: () => Promise<
      ReturnType<typeof answer> | { value: null; version: 0; rev: 0; updatedAt: null }
    >;
    online?: boolean;
    /** Already on the device before the app starts. */
    record?: SavedPromptpay;
  } = {},
) {
  const store = options.store ?? { ...createMemoryLocalStore(), persistent: true };
  if (options.record) void store.kv.set(PROMPTPAY_CACHE_KEY, options.record);
  const entities = createEntityStore();
  const life = createFakeLifecycle({ online: options.online ?? true });
  const permissions: readonly Permission[] = options.permissions ?? [
    'settings.view',
    'payment.record',
  ];
  const sessionFor = (staff: string) => ({ staff: { id: staff }, permissions });
  const auth = createStore<{
    phase: Phase;
    session: ReturnType<typeof sessionFor> | null;
    device: { id: string } | null;
  }>({
    phase: options.staff === null ? 'locked' : 'signedIn',
    session: options.staff === null ? null : sessionFor(options.staff ?? ME),
    device: { id: DEVICE },
  });
  const connection = createStore<{
    status: 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';
  }>({ status: options.online === false ? 'offline' : 'online' });
  const fetchId = vi.fn(options.fetch ?? (async () => answer(ID, 20)));
  const cache = createPromptpayCache({
    api: { settings: { promptpay: fetchId as never } },
    entities,
    auth,
    connection,
    lifecycle: life.lifecycle,
    localStore: async () => store,
    now: () => Date.now(),
  });
  const unbind = cache.bind();
  return {
    cache,
    store,
    entities,
    auth,
    connection,
    life,
    fetchId,
    unbind,
    signInAs: (staff: string | null) =>
      auth.setState(
        staff === null
          ? { phase: 'locked', session: null }
          : { phase: 'signedIn', session: sessionFor(staff) },
      ),
    setPhase: (phase: Phase, device: { id: string } | null = { id: DEVICE }) =>
      auth.setState({ phase, device, ...(phase === 'signedIn' ? {} : { session: null }) }),
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(0);
};
const stored = (store: LocalStore) => store.kv.get<SavedPromptpay>(PROMPTPAY_CACHE_KEY);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2030-10-15T05:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('saving the ID', () => {
  test('is fetched at sign-in and kept in its own record: staff, time, rev, ID and type', async () => {
    const { cache, store, fetchId } = setup();
    await settle();
    expect(fetchId).toHaveBeenCalledTimes(1);
    expect(await stored(store)).toEqual({
      v: PROMPTPAY_CACHE_SCHEMA,
      staffId: ME,
      savedAt: Date.now(),
      rev: 20,
      stale: false,
      target: { idType: 'phone', idValue: ID },
    });
    expect(cache.getState()).toMatchObject({ phase: 'ready', last4: '5678', savedAt: Date.now() });
  });

  test('is not fetched, and not usable, for a role that may not view settings', async () => {
    const { cache, fetchId } = setup({ permissions: ['payment.record'] });
    await settle();
    expect(fetchId).not.toHaveBeenCalled();
    expect(cache.qr(7500)).toEqual({ ok: false, reason: 'none' });
  });

  test('a signed-out device does not fetch', async () => {
    const { fetchId } = setup({ staff: null });
    await settle();
    expect(fetchId).not.toHaveBeenCalled();
  });

  test('the reactive state never holds the ID, only the last four digits', async () => {
    const { cache } = setup();
    await settle();
    expect(JSON.stringify(cache.getState())).not.toContain(ID);
  });

  test('a server with no ID set removes the saved one', async () => {
    const { store, cache } = setup({
      record: saved(),
      fetch: async () => ({ value: null, version: 0, rev: 0, updatedAt: null }),
    });
    await settle();
    expect(await stored(store)).toBeUndefined();
    expect(cache.qr(7500)).toEqual({ ok: false, reason: 'none' });
  });

  test('a 403 removes it (the role lost the right)', async () => {
    const { store, cache } = setup({
      record: saved(),
      fetch: async () => {
        throw new ApiClientError('FORBIDDEN', { status: 403 });
      },
    });
    await settle();
    expect(await stored(store)).toBeUndefined();
    expect(cache.qr(7500)).toEqual({ ok: false, reason: 'none' });
  });

  test('any other failure keeps what is saved, as it is', async () => {
    const { store, cache } = setup({
      record: saved(),
      fetch: async () => {
        throw new ApiClientError('NETWORK');
      },
    });
    await settle();
    expect(await stored(store)).toEqual(saved());
    expect(cache.qr(7500).ok).toBe(true);
  });
});

describe('when it is fetched again', () => {
  test('on reconnect, which also renews the saved-at time', async () => {
    const { connection, fetchId, store } = setup();
    await settle();
    vi.setSystemTime(Date.now() + 3 * 3600_000);
    connection.setState({ status: 'offline' });
    connection.setState({ status: 'online' });
    await settle();
    expect(fetchId).toHaveBeenCalledTimes(2);
    expect((await stored(store))?.savedAt).toBe(Date.now());
  });

  test('on the device coming back online', async () => {
    const { life, fetchId } = setup();
    await settle();
    life.goOffline();
    life.goOnline();
    await settle();
    expect(fetchId).toHaveBeenCalledTimes(2);
  });

  test('a change notice with a newer rev marks it stale at once, then fetches the new ID', async () => {
    let calls = 0;
    const { entities, cache, fetchId, store } = setup({
      fetch: async () => {
        calls += 1;
        return calls === 1 ? answer(ID, 20) : answer(NEW_ID, 31);
      },
    });
    await settle();
    expect(cache.qr(7500).ok).toBe(true);
    // Hold the second fetch open to look at the state in between.
    let release: (v: ReturnType<typeof answer>) => void = () => undefined;
    fetchId.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    entities.apply(settingsFrame('promptpay', 31, 2));
    await settle();
    expect(cache.getState().phase).toBe('stale');
    expect(cache.qr(7500)).toEqual({ ok: false, reason: 'stale' });
    expect((await stored(store))?.stale).toBe(true);
    release(answer(NEW_ID, 31));
    await settle();
    expect(cache.getState()).toMatchObject({ phase: 'ready', last4: '0000' });
    expect(cache.qr(7500)).toMatchObject({ ok: true, last4: '0000' });
    expect((await stored(store))?.stale).toBe(false);
  });

  test('a failed fetch after a change notice leaves it stale: the QR stays refused', async () => {
    let calls = 0;
    const { entities, cache, store } = setup({
      fetch: async () => {
        calls += 1;
        if (calls === 1) return answer(ID, 20);
        throw new ApiClientError('NETWORK');
      },
    });
    await settle();
    entities.apply(settingsFrame('promptpay', 31, 2));
    await settle();
    expect(cache.qr(7500)).toEqual({ ok: false, reason: 'stale' });
    expect((await stored(store))?.stale).toBe(true);
  });

  test('a notice that is not newer than the saved rev (a catch-up replay) changes nothing', async () => {
    const { entities, cache, fetchId } = setup();
    await settle();
    entities.apply(settingsFrame('promptpay', 20, 1));
    await settle();
    expect(fetchId).toHaveBeenCalledTimes(1);
    expect(cache.qr(7500).ok).toBe(true);
  });

  test('a fetch that returns an older rev than a notice that arrived meanwhile is fetched again', async () => {
    let calls = 0;
    const { entities, cache, fetchId } = setup({
      fetch: async () => {
        calls += 1;
        return calls === 1 ? answer(ID, 20) : calls === 2 ? answer(ID, 25) : answer(NEW_ID, 31);
      },
    });
    entities.apply(settingsFrame('promptpay', 31, 2));
    await settle();
    expect(fetchId.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(cache.getState()).toMatchObject({ phase: 'ready', last4: '0000' });
  });
});

describe('the saved ID at sign-in and sign-out', () => {
  test('offline, the same person keeps using the saved ID with no fetch', async () => {
    const { cache, fetchId } = setup({ online: false, record: saved() });
    await settle();
    expect(fetchId).not.toHaveBeenCalled();
    expect(cache.qr(7500)).toMatchObject({ ok: true, last4: '5678' });
  });

  test('a record of ANOTHER person is removed when someone else signs in', async () => {
    const { store, cache } = setup({ online: false, staff: OTHER, record: saved({ staffId: ME }) });
    await settle();
    expect(await stored(store)).toBeUndefined();
    expect(cache.qr(7500)).toEqual({ ok: false, reason: 'none' });
  });

  test('switching the signed-in person on a running app clears it and saves the new person’s', async () => {
    const { signInAs, store, fetchId } = setup();
    await settle();
    signInAs(null);
    signInAs(OTHER);
    await settle();
    expect(fetchId).toHaveBeenCalledTimes(2);
    expect((await stored(store))?.staffId).toBe(OTHER);
  });

  test('offline, a different person signing in leaves NOTHING to draw from', async () => {
    const { store, signInAs, cache } = setup({ online: false, record: saved() });
    await settle();
    expect(cache.qr(7500).ok).toBe(true);
    signInAs(null);
    signInAs(OTHER);
    await settle();
    expect(await stored(store)).toBeUndefined();
    expect(cache.qr(7500)).toEqual({ ok: false, reason: 'none' });
  });

  test('signing out keeps the record for the same person, but nobody can draw from it meanwhile', async () => {
    const { signInAs, store, cache } = setup();
    await settle();
    signInAs(null);
    await settle();
    expect(cache.qr(7500)).toEqual({ ok: false, reason: 'none' });
    expect(await stored(store)).toBeDefined();
  });

  test('the device being removed (no device any more) clears it', async () => {
    const { setPhase, store, cache } = setup();
    await settle();
    setPhase('unregistered', null);
    await settle();
    expect(await stored(store)).toBeUndefined();
    expect(cache.qr(7500)).toEqual({ ok: false, reason: 'none' });
  });

  test('a record of another schema or a damaged one is removed, not read', async () => {
    const { store, cache } = setup({
      online: false,
      record: { ...saved(), v: PROMPTPAY_CACHE_SCHEMA + 1 },
    });
    await settle();
    expect(await stored(store)).toBeUndefined();
    expect(cache.qr(7500)).toEqual({ ok: false, reason: 'none' });
  });

  test('an explicit clear removes it from the device and from memory', async () => {
    const { cache, store } = setup();
    await settle();
    await cache.clear();
    expect(await stored(store)).toBeUndefined();
    expect(cache.qr(7500)).toEqual({ ok: false, reason: 'none' });
    expect(cache.getState().phase).toBe('none');
  });
});

describe('what the QR needs', () => {
  test('is refused after 24 hours without a reconnect, even though the record is still there', async () => {
    const { cache } = setup({ online: false, record: saved({ savedAt: Date.now() }) });
    await settle();
    expect(cache.qr(7500).ok).toBe(true);
    vi.setSystemTime(Date.now() + OFFLINE_QR_MAX_AGE_MS + 1);
    expect(cache.qr(7500)).toEqual({ ok: false, reason: 'tooOld' });
  });

  test('idStatus says ok, none, stale, tooOld or forbidden, whatever the amount', async () => {
    const forbidden = setup({ permissions: ['payment.record'] });
    await settle();
    expect(forbidden.cache.idStatus()).toBe('forbidden');

    const { cache, entities } = setup({ online: false, record: saved() });
    await settle();
    expect(cache.idStatus()).toBe('ok');
    vi.setSystemTime(Date.now() + OFFLINE_QR_MAX_AGE_MS + 1);
    expect(cache.idStatus()).toBe('tooOld');
    vi.setSystemTime(Date.now() - OFFLINE_QR_MAX_AGE_MS - 1);
    entities.apply(settingsFrame('promptpay', 99, 3));
    await settle();
    expect(cache.idStatus()).toBe('stale');

    const empty = setup({
      online: false,
    });
    await settle();
    expect(empty.cache.idStatus()).toBe('none');
  });

  test('is refused for a zero amount', async () => {
    const { cache } = setup();
    await settle();
    expect(cache.qr(0)).toEqual({ ok: false, reason: 'badAmount' });
    expect(cache.qr(null)).toEqual({ ok: false, reason: 'badAmount' });
  });
});

describe('where the ID goes, and where it never goes', () => {
  test('only into the one record: no other kv key, never the outbox, never the console', async () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map((m) =>
      vi.spyOn(console, m as 'log').mockImplementation(() => undefined),
    );
    const { store, written } = recordingStore();
    const { entities, signInAs } = setup({ store });
    await settle();
    entities.apply(settingsFrame('promptpay', 31, 2));
    await settle();
    signInAs(null);
    signInAs(OTHER);
    await settle();
    const withId = written.filter((w) => w.includes(ID) || w.includes(NEW_ID));
    expect(withId.length).toBeGreaterThan(0);
    for (const row of withId) expect(row.startsWith(`${PROMPTPAY_CACHE_KEY}=`)).toBe(true);
    expect(written.some((w) => w.startsWith('outbox='))).toBe(false);
    for (const spy of logs) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(ID);
    }
  });
});
