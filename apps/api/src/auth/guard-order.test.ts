/**
 * The guard runs at onRequest, before Fastify reads the body (QA): someone who is not signed in
 * costs us no JSON parsing, and cannot tell a bad body from a missing session.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness } from '../test-support/harness.ts';

let h: Harness;
let device: { id: string; token: string };
beforeAll(async () => {
  h = await createHarness();
  device = await h.newDevice();
}, 60_000);
afterAll(async () => {
  await h.close();
});

const GUARDED_POSTS = ['/v1/orders', '/v1/auth/device', '/v1/auth/step-up', '/v1/auth/logout'];

function post(url: string, body: string, headers: Record<string, string> = {}) {
  return h.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
    remoteAddress: h.nextIp(),
  });
}

describe('not signed in', () => {
  test.each(GUARDED_POSTS)('%s answers 401 to a body that is not even JSON', async (url) => {
    const res = await post(url, '{ this is not json');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  test.each(GUARDED_POSTS)('%s answers 401 to a body over the size limit, unread', async (url) => {
    const res = await post(url, JSON.stringify({ filler: 'x'.repeat(2 * 1024 * 1024) }));
    expect(res.statusCode).toBe(401);
  });

  test('a bad body and a good body get the same answer', async () => {
    const bad = await post('/v1/orders', '{');
    const good = await post('/v1/orders', JSON.stringify({ items: [] }));
    expect(bad.body).toBe(good.body);
  });
});

describe('signed in', () => {
  test('a role without the permission is told so before its body is looked at', async () => {
    const kitchen = await h.newStaff('kitchen', '4821');
    const token = await h.pinSession(device.token, kitchen.id, '4821');
    const res = await post('/v1/orders', '{ this is not json', {
      authorization: `Bearer ${token}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  test('with the permission, a broken body is a plain 400', async () => {
    const cashier = await h.newStaff('cashier', '4821');
    const token = await h.pinSession(device.token, cashier.id, '4821');
    const res = await post('/v1/orders', '{ this is not json', {
      authorization: `Bearer ${token}`,
    });
    expect(res.statusCode).toBe(400);
  });
});
