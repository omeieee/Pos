import { SYNC_SAFETY_REVS, type SyncResponse, WS_CLOSE } from '@sds/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { createFakeLifecycle, createFakeSockets } from '../test-support/fake-realtime.ts';
import { alertFrame, itemFrame, orderFrame, settingsFrame, uuid } from '../test-support/frames.ts';
import { type ConnectionDeps, createConnection } from './connection.ts';
import { createEntityStore } from './entity-store.ts';

const TOKENS = {
  sessionToken: 'sds_ses_FAKEFAKEFAKEFAKEFAKEFAKE0001',
  deviceToken: 'sds_dev_FAKEFAKEFAKEFAKEFAKEFAKE0002',
};

const page = (over: Partial<SyncResponse> = {}): SyncResponse => ({
  changes: [],
  nextSince: 0,
  hasMore: false,
  serverRev: 0,
  ...over,
});

function setup(overrides: Partial<ConnectionDeps> = {}) {
  const entities = createEntityStore();
  const sockets = createFakeSockets();
  const life = createFakeLifecycle();
  const fetchSync = vi.fn<ConnectionDeps['fetchSync']>(async () => page());
  const onAuthLost = vi.fn();
  const connection = createConnection({
    entities,
    fetchSync,
    credentials: () => TOKENS,
    createSocket: sockets.factory,
    lifecycle: life.lifecycle,
    url: 'wss://api.example.test/v1/ws',
    onAuthLost,
    random: () => 1,
    ...overrides,
  });
  return { entities, sockets, life, fetchSync, onAuthLost, connection };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

/** Opens the socket, answers the auth message with `ready`, and lets the catch-up finish. */
async function bringOnline(env: ReturnType<typeof setup>, serverRev = 0) {
  env.connection.start();
  env.sockets.last().open();
  env.sockets.last().receive({ type: 'ready', serverRev, heartbeatSeconds: 25 });
  await flush();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('connecting', () => {
  test('the first message is auth with the session and device tokens, and the status is connecting', () => {
    const env = setup();
    env.connection.start();
    expect(env.connection.getState().status).toBe('connecting');
    expect(env.sockets.last().url).toBe('wss://api.example.test/v1/ws');
    env.sockets.last().open();
    expect(env.sockets.last().sent).toEqual([{ type: 'auth', ...TOKENS }]);
  });

  test('an owner session sends no device token field', () => {
    const env = setup({
      credentials: () => ({ sessionToken: TOKENS.sessionToken, deviceToken: null }),
    });
    env.connection.start();
    env.sockets.last().open();
    expect(env.sockets.last().sent).toEqual([{ type: 'auth', sessionToken: TOKENS.sessionToken }]);
  });

  test('without a session it does not connect at all', () => {
    const env = setup({ credentials: () => null });
    env.connection.start();
    expect(env.sockets.sockets).toHaveLength(0);
    expect(env.connection.getState().status).toBe('idle');
  });

  test('no ready within the deadline: the socket is dropped and a reconnect is scheduled', async () => {
    const env = setup();
    env.connection.start();
    env.sockets.last().open();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(env.sockets.last().closedByClient).not.toBeNull();
    expect(env.connection.getState().status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.sockets.sockets).toHaveLength(2);
  });
});

describe('catch-up', () => {
  test('after ready it syncs from 0 on a fresh device and goes online when the pages are in', async () => {
    const env = setup();
    env.fetchSync.mockResolvedValueOnce(
      page({ changes: [orderFrame(uuid(1), 5)], nextSince: 5, hasMore: false, serverRev: 5 }),
    );
    await bringOnline(env, 5);
    expect(env.fetchSync).toHaveBeenCalledWith({ since: 0, limit: 500 });
    expect(env.entities.getState().orders.has(uuid(1))).toBe(true);
    expect(env.connection.getState()).toMatchObject({ status: 'online', synced: true });
  });

  test('rewinds by the safety margin once, then follows nextSince page by page', async () => {
    const env = setup();
    env.entities.apply(orderFrame(uuid(1), 1000));
    env.fetchSync
      .mockResolvedValueOnce(page({ nextSince: 900, hasMore: true, serverRev: 1100 }))
      .mockResolvedValueOnce(page({ nextSince: 1100, hasMore: false, serverRev: 1100 }));
    await bringOnline(env, 1100);
    expect(env.fetchSync.mock.calls.map(([q]) => q.since)).toEqual([1000 - SYNC_SAFETY_REVS, 900]);
    // The final nextSince becomes lastRev, so the next catch-up starts from there.
    expect(env.entities.getState().lastRev).toBe(1100);
  });

  test('never rewinds below 0', async () => {
    const env = setup();
    env.entities.apply(orderFrame(uuid(1), 50));
    await bringOnline(env, 50);
    expect(env.fetchSync.mock.calls[0]?.[0].since).toBe(0);
  });

  test('live frames that arrive during the catch-up are held and applied after it', async () => {
    const env = setup();
    let release!: (value: SyncResponse) => void;
    env.fetchSync.mockReturnValueOnce(new Promise<SyncResponse>((resolve) => (release = resolve)));
    env.connection.start();
    env.sockets.last().open();
    env.sockets.last().receive({ type: 'ready', serverRev: 9, heartbeatSeconds: 25 });
    await flush();
    // A newer live frame, and an older one that the page will carry.
    env.sockets.last().receive(orderFrame(uuid(1), 9, { status: 'preparing' }));
    await flush();
    expect(env.entities.getState().orders.size).toBe(0);
    expect(env.connection.getState().status).not.toBe('online');
    release(
      page({
        changes: [orderFrame(uuid(1), 7, { status: 'new' }), orderFrame(uuid(2), 8)],
        nextSince: 8,
        serverRev: 9,
      }),
    );
    await flush();
    expect(env.entities.getState().orders.get(uuid(1))?.status).toBe('preparing');
    expect(env.entities.getState().orders.has(uuid(2))).toBe(true);
    expect(env.connection.getState().status).toBe('online');
  });

  test('once online, live frames apply at once', async () => {
    const env = setup();
    await bringOnline(env);
    env.sockets.last().receive(itemFrame(uuid(3), 12));
    expect(env.entities.getState().items.has(uuid(3))).toBe(true);
  });

  test('a server rev below ours means a restored database: the store is reset and synced from 0', async () => {
    const env = setup();
    env.entities.apply(orderFrame(uuid(1), 800));
    await bringOnline(env, 40);
    expect(env.entities.getState().orders.size).toBe(0);
    expect(env.fetchSync.mock.calls[0]?.[0].since).toBe(0);
  });

  test('a PromptPay settings frame marks the stored ID stale', async () => {
    const env = setup();
    await bringOnline(env);
    env.sockets.last().receive(settingsFrame('promptpay', 20, 2));
    expect(env.entities.getState().promptpayRev).toBe(20);
  });

  test('alert.new_order reaches the alert hook and is not stored', async () => {
    const env = setup();
    const heard = vi.fn();
    env.entities.onAlert(heard);
    await bringOnline(env);
    env.sockets.last().receive(alertFrame(uuid(9)));
    expect(heard).toHaveBeenCalledTimes(1);
  });

  test('a failed sync drops the socket and retries; it is not online meanwhile', async () => {
    const env = setup();
    env.fetchSync.mockRejectedValueOnce(new ApiClientError('NETWORK'));
    await bringOnline(env);
    expect(env.connection.getState().status).toBe('reconnecting');
    expect(env.sockets.sockets[0]?.closedByClient).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.sockets.sockets).toHaveLength(2);
  });

  test('a page that does not move forward ends the catch-up instead of looping forever', async () => {
    const env = setup();
    env.fetchSync.mockResolvedValue(page({ nextSince: 0, hasMore: true }));
    await bringOnline(env);
    expect(env.fetchSync.mock.calls.length).toBeLessThan(5);
    expect(env.connection.getState().status).toBe('reconnecting');
  });

  test('frames that do not match the protocol are ignored', async () => {
    const env = setup();
    await bringOnline(env);
    env.sockets.last().receiveRaw('not json');
    env.sockets.last().receive({ type: 'order.upserted', id: 'x', rev: 1, data: {} });
    expect(env.entities.getState().orders.size).toBe(0);
    expect(env.connection.getState().status).toBe('online');
  });
});

describe('heartbeat', () => {
  test('answers a ping with a pong', async () => {
    const env = setup();
    await bringOnline(env);
    env.sockets.last().receive({ type: 'ping', serverRev: 3 });
    expect(env.sockets.last().sent.at(-1)).toEqual({ type: 'pong' });
  });

  test('a ping does not move lastRev', async () => {
    const env = setup();
    await bringOnline(env);
    env.sockets.last().receive({ type: 'ping', serverRev: 999 });
    expect(env.entities.getState().lastRev).toBe(0);
  });

  test('nothing heard for 50 seconds means the socket is dead: reconnect', async () => {
    const env = setup();
    await bringOnline(env);
    await vi.advanceTimersByTimeAsync(49_000);
    expect(env.connection.getState().status).toBe('online');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(env.sockets.sockets[0]?.closedByClient).not.toBeNull();
    expect(env.connection.getState().status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.sockets.sockets).toHaveLength(2);
  });

  test('every ping keeps it alive', async () => {
    const env = setup();
    await bringOnline(env);
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      env.sockets.last().receive({ type: 'ping', serverRev: 0 });
    }
    expect(env.connection.getState().status).toBe('online');
    expect(env.sockets.sockets).toHaveLength(1);
  });
});

describe('closing', () => {
  test.each([
    [WS_CLOSE.UNAUTHENTICATED, 'unauthenticated'],
    [WS_CLOSE.FORBIDDEN, 'forbidden'],
  ] as const)('close %i means sign in again: no reconnect', async (code, kind) => {
    const env = setup();
    await bringOnline(env);
    env.sockets.last().serverClose(code);
    expect(env.onAuthLost).toHaveBeenCalledWith(kind);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(env.sockets.sockets).toHaveLength(1);
    expect(env.connection.getState().status).toBe('idle');
  });

  test('4401 during the handshake is also a sign-in problem', () => {
    const env = setup();
    env.connection.start();
    env.sockets.last().open();
    env.sockets.last().serverClose(WS_CLOSE.UNAUTHENTICATED);
    expect(env.onAuthLost).toHaveBeenCalledWith('unauthenticated');
  });

  test.each([
    WS_CLOSE.GOING_AWAY,
    WS_CLOSE.INTERNAL,
    WS_CLOSE.AUTH_TIMEOUT,
    WS_CLOSE.TOO_MANY,
    1006,
  ])('close %i reconnects with backoff', async (code) => {
    const env = setup();
    await bringOnline(env);
    env.sockets.last().serverClose(code);
    expect(env.onAuthLost).not.toHaveBeenCalled();
    expect(env.connection.getState().status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.sockets.sockets).toHaveLength(2);
  });

  test('the wait grows with every failed attempt, is jittered and is capped', async () => {
    const env = setup({ random: () => 0 });
    env.connection.start();
    const waits: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = env.sockets.sockets.length;
      env.sockets.last().serverClose(1006);
      let waited = 0;
      while (env.sockets.sockets.length === before && waited < 40_000) {
        await vi.advanceTimersByTimeAsync(250);
        waited += 250;
      }
      waits.push(waited);
    }
    // random() = 0 gives the lower half of each window: 0.5s, 1s, 2s, 4s, 8s, 15s, 15s, 15s.
    expect(waits[0]).toBeLessThanOrEqual(750);
    expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
    expect(waits[3]).toBeGreaterThan(waits[1] ?? 0);
    expect(Math.max(...waits)).toBeLessThanOrEqual(15_250);
    expect(waits.at(-1)).toBe(waits.at(-2));
  });

  test('a good connection resets the backoff', async () => {
    const env = setup();
    env.connection.start();
    env.sockets.last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    env.sockets.last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    env.sockets.last().open();
    env.sockets.last().receive({ type: 'ready', serverRev: 0, heartbeatSeconds: 25 });
    await flush();
    env.sockets.last().serverClose(1006);
    const before = env.sockets.sockets.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.sockets.sockets.length).toBe(before + 1);
  });

  test('events from an old socket are ignored after a reconnect', async () => {
    const env = setup();
    await bringOnline(env);
    const old = env.sockets.last();
    old.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    old.receive(orderFrame(uuid(7), 90));
    old.serverClose(WS_CLOSE.UNAUTHENTICATED);
    expect(env.entities.getState().orders.size).toBe(0);
    expect(env.onAuthLost).not.toHaveBeenCalled();
  });
});

describe('network and the page', () => {
  test('offline: status offline, no attempts; back online: reconnects at once', async () => {
    const env = setup();
    await bringOnline(env);
    env.life.goOffline();
    expect(env.connection.getState().status).toBe('offline');
    env.sockets.last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(env.sockets.sockets).toHaveLength(1);
    env.life.goOnline();
    expect(env.sockets.sockets).toHaveLength(2);
    expect(env.connection.getState().status).toBe('reconnecting');
  });

  test('starting while offline waits for the network', () => {
    const env = setup();
    env.life.goOffline();
    env.connection.start();
    expect(env.sockets.sockets).toHaveLength(0);
    expect(env.connection.getState().status).toBe('offline');
    env.life.goOnline();
    expect(env.sockets.sockets).toHaveLength(1);
  });

  test('coming back to the page while waiting to reconnect tries at once', async () => {
    const env = setup();
    await bringOnline(env);
    env.sockets.last().serverClose(1006);
    env.life.show();
    expect(env.sockets.sockets).toHaveLength(2);
  });

  test('coming back to the page after a long sleep (no frames for over 50 s) reconnects', async () => {
    const env = setup();
    await bringOnline(env);
    env.life.hide();
    vi.setSystemTime(Date.now() + 120_000);
    env.life.show();
    expect(env.sockets.sockets[0]?.closedByClient).not.toBeNull();
    expect(env.sockets.sockets).toHaveLength(2);
  });

  test('coming back to a healthy connection does nothing', async () => {
    const env = setup();
    await bringOnline(env);
    await vi.advanceTimersByTimeAsync(10_000);
    env.life.show();
    expect(env.sockets.sockets).toHaveLength(1);
  });
});

describe('stop', () => {
  test('closes the socket, stops reconnecting and listening, and reports idle', async () => {
    const env = setup();
    await bringOnline(env);
    env.connection.stop();
    expect(env.sockets.last().closedByClient).not.toBeNull();
    expect(env.connection.getState().status).toBe('idle');
    expect(env.life.listenerCount()).toBe(0);
    env.sockets.last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(env.sockets.sockets).toHaveLength(1);
  });

  test('start after stop connects again and is not doubled by a second start', async () => {
    const env = setup();
    await bringOnline(env);
    env.connection.stop();
    env.connection.start();
    env.connection.start();
    expect(env.sockets.sockets).toHaveLength(2);
  });

  test('a catch-up that finishes after stop does not apply anything', async () => {
    const env = setup();
    let release!: (value: SyncResponse) => void;
    env.fetchSync.mockReturnValueOnce(new Promise<SyncResponse>((resolve) => (release = resolve)));
    env.connection.start();
    env.sockets.last().open();
    env.sockets.last().receive({ type: 'ready', serverRev: 5, heartbeatSeconds: 25 });
    await flush();
    env.connection.stop();
    release(page({ changes: [orderFrame(uuid(1), 5)], nextSince: 5, serverRev: 5 }));
    await flush();
    expect(env.entities.getState().orders.size).toBe(0);
    expect(env.connection.getState().status).toBe('idle');
  });
});
