/** Test doubles: a real TCP "printer" and a real HTTP "API" on localhost. No mocks of our own code. */

import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { SAMPLE_TICKET } from '@sds/escpos';
import type { ClaimedPrintJob } from '@sds/shared';

export interface FakePrinter {
  port: number;
  /** One entry per connection: the bytes it sent. */
  received: Uint8Array[];
  close(): Promise<void>;
}

export async function startFakePrinter(
  options: { reply?: number[]; neverRead?: boolean; keepOpen?: boolean } = {},
): Promise<FakePrinter> {
  const received: Uint8Array[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server: TcpServer = createTcpServer(
    { allowHalfOpen: options.keepOpen ?? false, pauseOnConnect: options.neverRead ?? false },
    (socket) => {
      sockets.add(socket);
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        // A printer that answers status questions (DLE EOT) when asked.
        if (options.reply && chunk.length === 9 && chunk[0] === 0x10) {
          socket.write(Buffer.from(options.reply));
        }
      });
      socket.on('close', () => {
        sockets.delete(socket);
        if (chunks.length > 0) received.push(new Uint8Array(Buffer.concat(chunks)));
      });
      socket.on('error', () => {});
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A port nothing listens on. */
export async function closedPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface FakeApi {
  baseUrl: string;
  token: string;
  /** Jobs the next claims return, in order. */
  queue: ClaimedPrintJob[];
  claims: number;
  acks: Array<{ jobId: string; body: Record<string, unknown> }>;
  /** Queue of HTTP statuses to answer the next calls with instead of the normal answer. */
  failNext: number[];
  /** Like failNext, but only for ack calls. */
  failAcks: number[];
  /** Headers and bodies of every call, for checks on what is sent. */
  calls: Array<{ path: string; token: string | undefined; body: unknown }>;
  close(): Promise<void>;
}

export function makeJob(overrides: Partial<ClaimedPrintJob> = {}): ClaimedPrintJob {
  return {
    id: randomUUID(),
    kind: 'kitchen',
    seq: 0,
    attempt: 1,
    leaseToken: randomUUID(),
    leaseUntil: new Date(Date.now() + 30_000).toISOString(),
    ticket: SAMPLE_TICKET,
    ...overrides,
  };
}

export async function startFakeApi(): Promise<FakeApi> {
  const api: FakeApi = {
    baseUrl: '',
    token: 'test-device-token-0123456789',
    queue: [],
    claims: 0,
    acks: [],
    failNext: [],
    failAcks: [],
    calls: [],
    close: () => Promise.resolve(),
  };
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '';
      const text = Buffer.concat(chunks).toString('utf8');
      const body: unknown = text === '' ? null : JSON.parse(text);
      const token = request.headers['x-device-token'];
      api.calls.push({ path, token: typeof token === 'string' ? token : undefined, body });
      const reply = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (token !== api.token)
        return reply(401, { code: 'UNAUTHENTICATED', message: 'no', details: {} });
      const forced = api.failNext.shift();
      if (forced) return reply(forced, { code: 'X', message: 'x', details: {} });
      if (path === '/v1/print/claim') {
        api.claims += 1;
        return reply(200, { job: api.queue.shift() ?? null });
      }
      const ack = /^\/v1\/print\/jobs\/([^/]+)\/ack$/.exec(path);
      if (ack?.[1]) {
        const forcedAck = api.failAcks.shift();
        if (forcedAck) return reply(forcedAck, { code: 'X', message: 'x', details: {} });
        api.acks.push({ jobId: ack[1], body: body as Record<string, unknown> });
        return reply(200, { id: ack[1] });
      }
      return reply(404, { code: 'NOT_FOUND', message: 'no', details: {} });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  api.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return api;
}
