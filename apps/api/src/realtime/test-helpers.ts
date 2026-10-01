/**
 * Test clients for `WS /v1/ws`.
 * - `connect`: Fastify's `injectWS` runs the real upgrade, hub and `ws` protocol over in-memory
 *   streams (no port). Fast, and it can pose as any client address.
 * - `connectTcp`: a real client over loopback TCP, built on Node's own WebSocket (the browser's
 *   API: it cannot set headers either). The server must be listening.
 * Both return a `WsClient` with a message log and promises, so a test can say "wait for the order
 * frame" or "expect close 4401".
 */
import type { FastifyInstance } from 'fastify';

/** What the tests use of a client socket. */
export interface RawSocket {
  send(data: string | Buffer, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  pause(): void;
  resume(): void;
  readyState: number;
}

export interface Frame {
  type: string;
  [key: string]: unknown;
}

export interface ClosedWith {
  code: number;
  reason: string;
}

export interface WsClient {
  raw: RawSocket;
  /** Every JSON message received, in order. */
  frames: Frame[];
  /** `performance.now()` when each frame arrived (same index as `frames`). */
  times: number[];
  /** Resolves when the socket closes. */
  closed: Promise<ClosedWith>;
  isClosed(): boolean;
  send(message: unknown): void;
  /** The first frame matching (already received or yet to come), or a rejection after `timeoutMs`. */
  next(match: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
  /** Frames received so far that match. */
  seen(match: (frame: Frame) => boolean): Frame[];
}

/** The part both connectors share: the log, the waiters and the close promise. */
function makeClient(getRaw: () => RawSocket) {
  const frames: Frame[] = [];
  const times: number[] = [];
  const waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  let closedNow = false;
  let resolveClosed: (c: ClosedWith) => void = () => {};
  const closed = new Promise<ClosedWith>((resolve) => {
    resolveClosed = resolve;
  });

  const client: WsClient = {
    get raw() {
      return getRaw();
    },
    frames,
    times,
    closed,
    isClosed: () => closedNow,
    send: (message) =>
      getRaw().send(typeof message === 'string' ? message : JSON.stringify(message)),
    next(match, timeoutMs = 3000) {
      const already = frames.find(match);
      if (already) return Promise.resolve(already);
      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no matching frame within ${timeoutMs} ms`)),
          timeoutMs,
        );
        waiters.push({
          match,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      });
    },
    seen: (match) => frames.filter(match),
  };
  return {
    client,
    onMessage(text: string) {
      const frame = JSON.parse(text) as Frame;
      frames.push(frame);
      times.push(performance.now());
      for (const waiter of [...waiters]) {
        if (waiter.match(frame)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    },
    onClose(code: number, reason: string) {
      closedNow = true;
      resolveClosed({ code, reason });
    },
  };
}

let nextAddress = 0;
/** A fresh client address per connection, so one test's sockets do not count against another's cap. */
export const freshIp = () => {
  nextAddress += 1;
  return `10.77.${Math.floor(nextAddress / 250)}.${nextAddress % 250}`;
};

interface InjectedSocket extends RawSocket {
  on(event: 'message', listener: (data: Buffer) => void): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
}

export async function connect(
  app: FastifyInstance,
  options: { ip?: string } = {},
): Promise<WsClient> {
  let socket: InjectedSocket | undefined;
  const made = makeClient(() => {
    if (!socket) throw new Error('the socket is not open yet');
    return socket;
  });
  socket = (await app.injectWS(
    '/v1/ws',
    { socket: { remoteAddress: options.ip ?? freshIp() } } as never,
    {
      // Attached at creation, so nothing the server sends right away can be missed.
      onInit: (s: InjectedSocket) => {
        // injectWS builds its client without `autoPong`, so it would never answer a protocol ping
        // the way every real client does. Browsers and Node's WebSocket always do.
        (s as unknown as { _autoPong: boolean })._autoPong = true;
        s.on('message', (data) => made.onMessage(data.toString('utf8')));
        s.on('close', (code, reason) => made.onClose(code, reason.toString('utf8')));
      },
    } as never,
  )) as unknown as InjectedSocket;
  return made.client;
}

/** A real client over loopback TCP. The server must be listening (`app.listen({ port: 0 })`). */
export async function connectTcp(port: number, path = '/v1/ws'): Promise<WsClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const raw: RawSocket = {
    send: (data) => ws.send(data as string),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.close(),
    pause: () => {},
    resume: () => {},
    get readyState() {
      return ws.readyState;
    },
  };
  const made = makeClient(() => raw);
  ws.addEventListener('message', (event) => made.onMessage(String(event.data)));
  ws.addEventListener('close', (event) => made.onClose(event.code, event.reason));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('the WebSocket did not open')), {
      once: true,
    });
  });
  return made.client;
}

export const ofType = (type: string) => (f: Frame) => f.type === type;

/** Resolves after `ms` (to prove that something did NOT arrive). */
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function expectClosed(client: WsClient, timeoutMs = 3000): Promise<ClosedWith> {
  return Promise.race([
    client.closed,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`socket did not close within ${timeoutMs} ms`)), timeoutMs),
    ),
  ]);
}

/** Polls until `check` is true (or throws after `timeoutMs`). */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(15);
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}
