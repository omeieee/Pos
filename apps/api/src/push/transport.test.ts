import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { newBrowser, TEST_VAPID } from '../test-support/fake-push.ts';
import { buildPushRequest, createFetchTransport } from './webpush.ts';

/** The real transport against a loopback server: the allow-list lives in `buildPushRequest`, not here. */
let server: Server;
let base: string;
const seen: { url: string; headers: IncomingMessage['headers']; body: Buffer }[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks) });
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/elsewhere' }).end();
      } else if (request.url === '/slow') {
        // Never answers: the caller's signal has to end the wait.
      } else if (request.url === '/gone') {
        response.writeHead(410).end('gone');
      } else {
        response.writeHead(201).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const request = (path: string) => {
  const built = buildPushRequest(newBrowser(), '{"title":"t"}', TEST_VAPID, {
    now: new Date('2026-10-22T00:00:00Z'),
    ttlSeconds: 120,
  });
  return { ...built, endpoint: `${base}${path}` };
};

describe('createFetchTransport', () => {
  test('posts the encrypted body and the headers, and returns the status', async () => {
    const sent = request('/ok');
    const result = await createFetchTransport()(sent, AbortSignal.timeout(2000));
    expect(result).toEqual({ status: 201 });
    const got = seen.find((s) => s.url === '/ok');
    expect(got?.headers).toMatchObject({
      authorization: sent.headers.authorization,
      ttl: '120',
      urgency: 'high',
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      'content-length': String(sent.body.length),
    });
    expect(got?.body.equals(Buffer.from(sent.body))).toBe(true);
  });

  test('returns an error status as a status, not an exception', async () => {
    expect(await createFetchTransport()(request('/gone'), AbortSignal.timeout(2000))).toEqual({
      status: 410,
    });
  });

  test('does not follow a redirect (it would walk past the host allow-list)', async () => {
    await expect(
      createFetchTransport()(request('/redirect'), AbortSignal.timeout(2000)),
    ).rejects.toThrow();
    expect(seen.some((s) => s.url === '/elsewhere')).toBe(false);
  });

  test('an aborted signal ends the wait', async () => {
    const started = Date.now();
    await expect(
      createFetchTransport()(request('/slow'), AbortSignal.timeout(100)),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
