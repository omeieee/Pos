/**
 * The realtime connection (D-04, 02 §5): `WS /v1/ws` for pushes, `GET /v1/sync` for catching up.
 *
 * One attempt goes: open, send `auth` as the FIRST message (a browser socket cannot send headers),
 * wait for `ready`, then catch up while HOLDING any live frames, then apply what was held and go
 * live. The catch-up starts at `lastRev - SYNC_SAFETY_REVS` once (not per page) and follows each
 * page's `nextSince`; applying a frame twice is harmless because the store only takes newer revs.
 * If `ready.serverRev` is below our `lastRev` the database was restored from a backup: the store
 * is reset and the sync starts from 0.
 *
 * Staying alive:
 * - the server pings every 25 s with `{type:'ping'}`; we answer `{type:'pong'}`. Nothing heard for
 *   50 s (a Safari tab that slept, a dead Wi-Fi) means the socket is dead: drop it and retry. The
 *   same check runs when the page comes back to the front, because a suspended page gets no timers.
 * - close 4401/4403 mean "sign in again": no reconnect, `onAuthLost` takes over. Any other close
 *   retries with exponential backoff (1 s doubling to 30 s, each wait jittered to 50-100%), reset
 *   by a successful catch-up. Offline devices wait for the `online` event instead of polling.
 * - the socket never extends a session. An iPad that only listens gets 4401 when the session
 *   idles out, and the person lands on the sign-in screen.
 *
 * Every callback belongs to one attempt (`generation`); late events of an old socket do nothing.
 * Browser pieces (WebSocket, online and visibility events) come in through the platform seam.
 */
import {
  type RealtimeFrame,
  SYNC_MAX_LIMIT,
  SYNC_SAFETY_REVS,
  type SyncResponse,
  WS_CLOSE,
  WS_HEARTBEAT_SECONDS,
  wsServerMessageSchema,
} from '@sds/shared';
import { isApiClientError } from '../api/errors.ts';
import { createStore, type ReadableStore } from '../lib/store.ts';
import type { Lifecycle } from '../platform/lifecycle.ts';
import type { SocketFactory, SocketHandle } from '../platform/socket.ts';
import type { EntityStore } from './entity-store.ts';

export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface ConnectionState {
  status: ConnectionStatus;
  /** True once a catch-up has finished since `start()`: the entity store holds the server's rows. */
  synced: boolean;
}

export interface Credentials {
  sessionToken: string;
  deviceToken: string | null;
}

export interface ConnectionDeps {
  entities: EntityStore;
  fetchSync: (query: { since: number; limit: number }) => Promise<SyncResponse>;
  credentials: () => Credentials | null;
  createSocket: SocketFactory;
  lifecycle: Lifecycle;
  url: string;
  /** The server ended the session (4401) or the device binding (4403). */
  onAuthLost: (kind: 'unauthenticated' | 'forbidden') => void;
  /** 0..1, for the jitter; tests fix it. */
  random?: () => number;
}

export interface Connection extends ReadableStore<ConnectionState> {
  start(): void;
  stop(): void;
}

/** The server pings every 25 s: twice that is silence. */
const DEAD_AFTER_MS = WS_HEARTBEAT_SECONDS * 2 * 1000;
/** From opening the socket to the `ready` answer. */
const READY_DEADLINE_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** More live frames than this while catching up means the catch-up is not keeping up: start over. */
const MAX_HELD_FRAMES = 10_000;

type Phase = 'auth' | 'catchup' | 'live';

export function createConnection(deps: ConnectionDeps): Connection {
  const random = deps.random ?? Math.random;
  const state = createStore<ConnectionState>({ status: 'idle', synced: false });

  let started = false;
  let generation = 0;
  let socket: SocketHandle | null = null;
  let phase: Phase = 'auth';
  let held: RealtimeFrame[] = [];
  let attempts = 0;
  /** True once a connection has been lost or has failed since `start()`: the next one "re-connects". */
  let hadTrouble = false;
  let lastHeardAt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeLifecycle: (() => void) | null = null;

  const setStatus = (status: ConnectionStatus) => {
    if (state.getState().status !== status) state.setState({ status });
  };

  function clearTimers() {
    clearTimeout(retryTimer);
    clearTimeout(deadTimer);
    clearTimeout(readyTimer);
    retryTimer = undefined;
    deadTimer = undefined;
    readyTimer = undefined;
  }

  /** Ends the current attempt: later callbacks of its socket are ignored. */
  function dropSocket() {
    generation += 1;
    clearTimeout(deadTimer);
    clearTimeout(readyTimer);
    deadTimer = undefined;
    readyTimer = undefined;
    held = [];
    const old = socket;
    socket = null;
    try {
      old?.close();
    } catch {
      // already closed
    }
  }

  function armDeadTimer() {
    clearTimeout(deadTimer);
    deadTimer = setTimeout(() => {
      if (!started) return;
      dropSocket();
      scheduleReconnect();
    }, DEAD_AFTER_MS);
  }

  function backoffDelay(): number {
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempts);
    attempts += 1;
    return Math.round(ceiling * (0.5 + 0.5 * random()));
  }

  function scheduleReconnect() {
    if (!started) return;
    hadTrouble = true;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    if (!deps.lifecycle.isOnline()) {
      setStatus('offline');
      return; // the `online` event restarts it
    }
    setStatus('reconnecting');
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, backoffDelay());
  }

  function authLost(kind: 'unauthenticated' | 'forbidden') {
    stopInternal();
    deps.onAuthLost(kind);
  }

  function failAttempt() {
    dropSocket();
    scheduleReconnect();
  }

  function onFrame(frame: RealtimeFrame) {
    if (phase === 'live') {
      deps.entities.apply(frame);
      return;
    }
    held.push(frame);
    if (held.length > MAX_HELD_FRAMES) failAttempt();
  }

  async function catchUp(attempt: number) {
    let since = Math.max(0, deps.entities.getState().lastRev - SYNC_SAFETY_REVS);
    let last = since;
    try {
      for (;;) {
        const result = await deps.fetchSync({ since, limit: SYNC_MAX_LIMIT });
        if (attempt !== generation) return;
        deps.entities.applyMany(result.changes);
        last = result.nextSince;
        if (!result.hasMore) break;
        // A page that goes nowhere would loop forever.
        if (result.nextSince <= since) throw new Error('sync does not advance');
        since = result.nextSince;
      }
    } catch (error) {
      if (attempt !== generation) return;
      if (isApiClientError(error) && error.code === 'UNAUTHENTICATED')
        return authLost('unauthenticated');
      if (isApiClientError(error) && error.code === 'DEVICE_MISMATCH') return authLost('forbidden');
      return failAttempt();
    }
    deps.entities.advance(last);
    const frames = held;
    held = [];
    phase = 'live';
    deps.entities.applyMany(frames);
    attempts = 0;
    state.setState({ status: 'online', synced: true });
  }

  function onMessage(attempt: number, text: string) {
    if (attempt !== generation) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = wsServerMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    lastHeardAt = Date.now();
    const message = parsed.data;
    if (phase !== 'auth') armDeadTimer();

    if (message.type === 'ready') {
      if (phase !== 'auth') return;
      clearTimeout(readyTimer);
      readyTimer = undefined;
      phase = 'catchup';
      armDeadTimer();
      if (message.serverRev < deps.entities.getState().lastRev) deps.entities.reset();
      void catchUp(attempt);
      return;
    }
    if (message.type === 'ping') {
      // Never `serverRev`: it can include revisions that are not committed yet.
      socket?.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (phase === 'auth') return; // a frame before `ready` is not expected: ignore
    onFrame(message);
  }

  function connect() {
    if (!started) return;
    const credentials = deps.credentials();
    if (!credentials) {
      setStatus('idle');
      return;
    }
    if (!deps.lifecycle.isOnline()) {
      hadTrouble = true;
      setStatus('offline');
      return;
    }
    dropSocket();
    const attempt = generation;
    phase = 'auth';
    held = [];
    setStatus(hadTrouble ? 'reconnecting' : 'connecting');
    readyTimer = setTimeout(() => {
      if (attempt === generation) failAttempt();
    }, READY_DEADLINE_MS);
    socket = deps.createSocket(deps.url, {
      open() {
        if (attempt !== generation) return;
        socket?.send(
          JSON.stringify({
            type: 'auth',
            sessionToken: credentials.sessionToken,
            ...(credentials.deviceToken ? { deviceToken: credentials.deviceToken } : {}),
          }),
        );
      },
      message: (text) => onMessage(attempt, text),
      close(code) {
        if (attempt !== generation) return;
        if (code === WS_CLOSE.UNAUTHENTICATED) return authLost('unauthenticated');
        if (code === WS_CLOSE.FORBIDDEN) return authLost('forbidden');
        dropSocket();
        scheduleReconnect();
      },
    });
  }

  /** Tries now instead of waiting out the backoff. */
  function reconnectNow() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    attempts = 0;
    connect();
  }

  const silentFor = () => Date.now() - lastHeardAt;

  function onVisible() {
    if (!started) return;
    if (retryTimer !== undefined) return reconnectNow();
    if (socket && phase === 'live' && silentFor() > DEAD_AFTER_MS) {
      hadTrouble = true;
      reconnectNow();
    }
  }

  function onOnline() {
    if (!started) return;
    if (socket && phase === 'live' && silentFor() <= DEAD_AFTER_MS) {
      setStatus('online');
      return;
    }
    if (socket && phase !== 'live') return; // an attempt is already running
    reconnectNow();
  }

  function onOffline() {
    if (!started) return;
    hadTrouble = true;
    setStatus('offline');
  }

  function stopInternal() {
    started = false;
    clearTimers();
    dropSocket();
    unsubscribeLifecycle?.();
    unsubscribeLifecycle = null;
    state.setState({ status: 'idle', synced: false });
  }

  return {
    getState: state.getState,
    subscribe: state.subscribe,
    start() {
      if (started) return;
      started = true;
      hadTrouble = false;
      attempts = 0;
      state.setState({ synced: false });
      unsubscribeLifecycle = deps.lifecycle.subscribe({
        online: onOnline,
        offline: onOffline,
        visible: onVisible,
      });
      connect();
    },
    stop() {
      if (started) stopInternal();
    },
  };
}
