/**
 * The WebSocket hub (D-04, 02 §5): server-authoritative fan-out of the in-process event bus to
 * signed-in devices, AFTER commit (services publish only once their transaction has committed).
 *
 * A browser WebSocket cannot send headers, so a socket proves who it is with its FIRST message,
 * `{type:'auth', sessionToken, deviceToken?}`, within a short deadline; the check is the REST
 * guard's own (`peekSession`: a PIN session needs the token of the device it was opened on). No
 * token is ever in a URL or a log. After that the hub:
 * - sends each frame only to sockets whose role may see it (`frames.ts`);
 * - pings every `heartbeatMs` (a protocol ping to find dead sockets, and an app-level `ping` frame
 *   with `serverRev` because browsers cannot see protocol pings) and drops a socket that did not
 *   answer the previous one;
 * - re-checks every session on the same beat, WITHOUT touching it (an open socket never keeps a
 *   session alive), and closes sockets whose session expired, went idle, was revoked, belongs to a
 *   deactivated person or lost its device; a logout, a device revoke, a deactivation and a PIN
 *   change close theirs at once (`session.ended` events);
 * - caps connections (per IP, per session, overall), message size (the ws layer), message rate and
 *   the bytes queued for a slow client (a client that falls behind is dropped and catches up);
 * - closes every socket with 1001 on shutdown.
 */
import { syncRepo as sync } from '@sds/db';
import {
  WS_AUTH_TIMEOUT_MS,
  WS_CLOSE,
  WS_HEARTBEAT_SECONDS,
  type WsAuthMessage,
  wsClientMessageSchema,
} from '@sds/shared';
import type { FastifyBaseLogger } from 'fastify';
import { type AuthContext, type Principal, peekSession } from '../auth/service.ts';
import { ApiError } from '../errors.ts';
import type { AppEvent } from '../events.ts';
import { frameFromEvent, mayReceive } from './frames.ts';

/** What the hub needs of a socket (the `ws` WebSocket has all of it). */
export interface WsLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback?: (error?: Error) => void): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'pong' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

const OPEN = 1;

export interface HubOptions {
  /** Close a socket that has not sent a valid auth message by then (4408). */
  authTimeoutMs: number;
  /**
   * Once a valid auth message is in, the deadline above is met; checking it may take as long as the
   * database does (a slow query on a loaded server is not the client's fault). This bounds it.
   */
  authVerifyMs: number;
  heartbeatMs: number;
  maxPerIp: number;
  maxPerSession: number;
  maxTotal: number;
  /** Drop a socket with more than this queued to send. */
  maxBufferedBytes: number;
  /** At most this many client messages per window; the only message it ever needs to send is `auth`. */
  maxMessagesPerWindow: number;
  messageWindowMs: number;
  /** How long shutdown waits for sockets to close before terminating them. */
  shutdownGraceMs: number;
  /** The session check. Tests slow it down; production uses the REST guard's own rules. */
  checkSession: typeof peekSession;
}

export const DEFAULT_HUB_OPTIONS: HubOptions = {
  authTimeoutMs: WS_AUTH_TIMEOUT_MS,
  authVerifyMs: 10_000,
  heartbeatMs: WS_HEARTBEAT_SECONDS * 1000,
  // A shop's devices share one router address: six devices with a few tabs each fit with room.
  maxPerIp: 20,
  maxPerSession: 5,
  maxTotal: 200,
  maxBufferedBytes: 1024 * 1024,
  maxMessagesPerWindow: 10,
  messageWindowMs: 10_000,
  shutdownGraceMs: 2000,
  checkSession: peekSession,
};

type State = 'pending' | 'authenticating' | 'ready' | 'closed';

/** The state as it is NOW: it can change while an await is pending, which flow analysis cannot see. */
const stateOf = (conn: { state: State }): State => conn.state;

interface Conn {
  id: number;
  socket: WsLike;
  ip: string;
  state: State;
  /** Kept in memory for the life of the socket, for the periodic re-check. Never logged. */
  tokens: { session: string; device: string | undefined } | null;
  principal: Principal | null;
  /** Cleared when a ping goes out, set again by the pong. */
  alive: boolean;
  authTimer: NodeJS.Timeout | undefined;
  windowStart: number;
  windowCount: number;
}

export interface Hub {
  /** Takes over a freshly upgraded socket. */
  accept(socket: WsLike, ip: string): void;
  /** Closes every socket with 1001 and waits (bounded) for them to go. */
  shutdown(): Promise<void>;
  /** Open sockets, signed in or not. */
  size(): number;
  /** One heartbeat now (tests drive it by hand). */
  tick(): Promise<void>;
}

export function createHub(
  ctx: AuthContext,
  overrides: Partial<HubOptions>,
  log: FastifyBaseLogger,
): Hub {
  const options: HubOptions = { ...DEFAULT_HUB_OPTIONS, ...overrides };
  const conns = new Set<Conn>();
  const perIp = new Map<string, number>();
  let nextId = 0;
  let closing = false;
  let drained: (() => void) | undefined;

  function shut(conn: Conn, code: number, reason: string): void {
    if (conn.state === 'closed') return;
    conn.state = 'closed';
    clearTimeout(conn.authTimer);
    conn.tokens = null;
    try {
      conn.socket.close(code, reason);
    } catch {
      conn.socket.terminate();
    }
    log.debug({ conn: conn.id, code, reason }, 'websocket closed by server');
  }

  function forget(conn: Conn): void {
    if (!conns.delete(conn)) return;
    conn.state = 'closed';
    clearTimeout(conn.authTimer);
    conn.tokens = null;
    const left = (perIp.get(conn.ip) ?? 1) - 1;
    if (left <= 0) perIp.delete(conn.ip);
    else perIp.set(conn.ip, left);
    if (conns.size === 0) drained?.();
  }

  function send(conn: Conn, text: string): void {
    const { socket } = conn;
    if (conn.state !== 'ready' || socket.readyState !== OPEN) return;
    if (socket.bufferedAmount > options.maxBufferedBytes) {
      // A client that cannot keep up misses frames; it reconnects and catches up with /v1/sync.
      log.warn({ conn: conn.id }, 'websocket dropped: client too slow');
      conn.state = 'closed';
      socket.terminate();
      return;
    }
    socket.send(text, (error) => {
      if (error) socket.terminate();
    });
  }

  // ---------- Messages from a client ----------

  async function authenticate(conn: Conn, message: WsAuthMessage): Promise<void> {
    conn.state = 'authenticating';
    // The client met its deadline by sending a valid message; only the database can be slow now.
    clearTimeout(conn.authTimer);
    conn.authTimer = setTimeout(
      () => shut(conn, WS_CLOSE.INTERNAL, 'auth_timeout'),
      options.authVerifyMs,
    );
    let principal: Principal | null;
    let serverRev: number;
    try {
      principal = await options.checkSession(ctx, message.sessionToken, message.deviceToken);
      if (stateOf(conn) === 'closed') return;
      if (!principal) {
        shut(conn, WS_CLOSE.UNAUTHENTICATED, 'unauthenticated');
        return;
      }
      const sessionId = principal.sessionId;
      let same = 0;
      for (const other of conns) {
        if (other.state === 'ready' && other.principal?.sessionId === sessionId) same += 1;
      }
      if (same >= options.maxPerSession) {
        shut(conn, WS_CLOSE.TOO_MANY, 'too_many_sockets');
        return;
      }
      serverRev = await sync.currentRev(ctx.db);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'DEVICE_MISMATCH') {
        shut(conn, WS_CLOSE.FORBIDDEN, 'device_mismatch');
        return;
      }
      log.error({ err: error }, 'websocket auth failed');
      shut(conn, WS_CLOSE.INTERNAL, 'internal_error');
      return;
    }
    // The socket may have closed while we waited for the database.
    if (stateOf(conn) !== 'authenticating') return;
    clearTimeout(conn.authTimer);
    conn.principal = principal;
    conn.tokens = { session: message.sessionToken, device: message.deviceToken };
    conn.state = 'ready';
    send(
      conn,
      JSON.stringify({
        type: 'ready',
        serverRev,
        heartbeatSeconds: Math.max(1, Math.round(options.heartbeatMs / 1000)),
      }),
    );
  }

  function onMessage(conn: Conn, data: unknown, isBinary: boolean): void {
    if (conn.state === 'closed') return;
    const now = Date.now();
    if (now - conn.windowStart > options.messageWindowMs) {
      conn.windowStart = now;
      conn.windowCount = 0;
    }
    conn.windowCount += 1;
    if (conn.windowCount > options.maxMessagesPerWindow) {
      shut(conn, WS_CLOSE.TOO_MANY, 'too_many_messages');
      return;
    }
    if (isBinary || !(data instanceof Buffer)) {
      shut(conn, WS_CLOSE.BAD_MESSAGE, 'bad_message');
      return;
    }

    // Nothing from the message is ever logged or echoed back: it may hold a token.
    let message: ReturnType<typeof wsClientMessageSchema.parse>;
    try {
      message = wsClientMessageSchema.parse(JSON.parse(data.toString('utf8')));
    } catch {
      shut(conn, WS_CLOSE.BAD_MESSAGE, 'bad_message');
      return;
    }
    if (message.type === 'auth') {
      if (conn.state !== 'pending') {
        shut(conn, WS_CLOSE.BAD_MESSAGE, 'bad_message');
        return;
      }
      void authenticate(conn, message);
      return;
    }
    // A pong is the client's answer to an app-level ping; it counts as being alive.
    if (conn.state !== 'ready') {
      shut(conn, WS_CLOSE.BAD_MESSAGE, 'bad_message');
      return;
    }
    conn.alive = true;
  }

  function accept(socket: WsLike, ip: string): void {
    if (closing) {
      socket.close(WS_CLOSE.GOING_AWAY, 'server_shutdown');
      return;
    }
    if (conns.size >= options.maxTotal || (perIp.get(ip) ?? 0) >= options.maxPerIp) {
      socket.close(WS_CLOSE.TOO_MANY, 'too_many_connections');
      return;
    }
    nextId += 1;
    const conn: Conn = {
      id: nextId,
      socket,
      ip,
      state: 'pending',
      tokens: null,
      principal: null,
      alive: true,
      authTimer: undefined,
      windowStart: Date.now(),
      windowCount: 0,
    };
    conns.add(conn);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);

    // Listeners go on before anything else runs: the client's auth message may already be queued.
    socket.on('message', (data, isBinary) => onMessage(conn, data, isBinary));
    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('close', () => forget(conn));
    socket.on('error', () => socket.terminate());
    conn.authTimer = setTimeout(
      () => shut(conn, WS_CLOSE.AUTH_TIMEOUT, 'auth_timeout'),
      options.authTimeoutMs,
    );
    log.debug({ conn: conn.id }, 'websocket opened');
  }

  // ---------- Fan-out ----------

  function onEvent(event: AppEvent): void {
    if (event.type === 'session.ended') {
      for (const conn of conns) {
        const p = conn.principal;
        if (!p || conn.state !== 'ready') continue;
        const match =
          (event.sessionId !== undefined && p.sessionId === event.sessionId) ||
          (event.staffId !== undefined && p.staffId === event.staffId) ||
          (event.deviceId !== undefined && p.deviceId === event.deviceId);
        if (match) shut(conn, WS_CLOSE.UNAUTHENTICATED, 'session_ended');
      }
      return;
    }
    const built = frameFromEvent(event);
    if (built.kind === 'ignored') return;
    if (built.kind === 'invalid') {
      // The type only: the data of a frame is never logged.
      log.error({ frame: built.type }, 'event dropped: its data does not fit the frame schema');
      return;
    }
    const text = JSON.stringify(built.frame);
    for (const conn of conns) {
      if (
        conn.state === 'ready' &&
        conn.principal &&
        mayReceive(conn.principal.role, built.frame)
      ) {
        send(conn, text);
      }
    }
  }
  const unsubscribe = ctx.events.subscribe(onEvent);

  // ---------- Heartbeat and re-check ----------

  let ticking = false;
  async function tick(): Promise<void> {
    if (ticking || closing) return;
    ticking = true;
    try {
      let serverRev = 0;
      try {
        serverRev = await sync.currentRev(ctx.db);
      } catch (error) {
        log.warn({ err: error }, 'websocket heartbeat could not read the revision');
      }
      for (const conn of [...conns]) {
        if (conn.state === 'closed') continue;
        if (!conn.alive) {
          conn.state = 'closed';
          conn.socket.terminate();
          continue;
        }
        conn.alive = false;
        try {
          conn.socket.ping();
        } catch {
          conn.socket.terminate();
          continue;
        }
        if (conn.state !== 'ready' || !conn.tokens) continue;
        try {
          const principal = await options.checkSession(
            ctx,
            conn.tokens.session,
            conn.tokens.device,
          );
          if (stateOf(conn) !== 'ready') continue;
          if (!principal) {
            shut(conn, WS_CLOSE.UNAUTHENTICATED, 'session_ended');
            continue;
          }
          conn.principal = principal; // a changed role applies from the next frame
        } catch (error) {
          if (error instanceof ApiError && error.code === 'DEVICE_MISMATCH') {
            shut(conn, WS_CLOSE.FORBIDDEN, 'device_mismatch');
            continue;
          }
          // The database is unreachable: keep the socket, try again at the next beat.
          log.warn({ err: error }, 'websocket session re-check failed');
        }
        send(conn, JSON.stringify({ type: 'ping', serverRev }));
      }
    } finally {
      ticking = false;
    }
  }
  const timer = setInterval(() => void tick(), options.heartbeatMs);
  timer.unref();

  async function shutdown(): Promise<void> {
    closing = true;
    unsubscribe();
    clearInterval(timer);
    if (conns.size === 0) return;
    const gone = new Promise<void>((resolve) => {
      drained = resolve;
    });
    for (const conn of conns) shut(conn, WS_CLOSE.GOING_AWAY, 'server_shutdown');
    const giveUp = setTimeout(() => {
      for (const conn of conns) conn.socket.terminate();
    }, options.shutdownGraceMs);
    giveUp.unref();
    // Terminated sockets still need their 'close' event to leave the set.
    const backstop = new Promise<void>((resolve) =>
      setTimeout(resolve, options.shutdownGraceMs + 1000).unref(),
    );
    await Promise.race([gone, backstop]);
    clearTimeout(giveUp);
  }

  return { accept, shutdown, size: () => conns.size, tick };
}
