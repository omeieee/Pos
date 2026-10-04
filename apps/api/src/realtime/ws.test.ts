/**
 * `WS /v1/ws` on the real app and an in-memory Postgres (PGlite): who may connect and how, what
 * each role receives, the limits, and the shutdown. Heartbeat and session re-checks are in
 * ws-session.test.ts (they need a fast beat); `GET /v1/sync` is in sync.test.ts.
 *
 * Not proven here: real TCP and TLS (the sockets are Fastify's in-memory `injectWS`), a real
 * browser or Safari, Caddy's WebSocket proxying, and real-Postgres commit ordering.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { peekSession } from '../auth/service.ts';
import { signQrLink } from '../payments/qr.ts';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';
import {
  connect,
  expectClosed,
  type Frame,
  freshIp,
  ofType,
  pause,
  type WsClient,
} from './test-helpers.ts';

let h: Harness;
let owner: OwnerFixture;
let device: { id: string; token: string };
const staff = {} as Record<'cashier' | 'manager' | 'kitchen', { id: string; pin: string }>;
const used: WsClient[] = [];
const tokensUsed: string[] = [];

// Test identifiers only, not a real PromptPay ID.
const PHONE = '0899994321';

beforeAll(async () => {
  h = await createHarness({
    realtime: {
      // maxTotal is high: a socket the test closes stays in the hub until its in-memory stream
      // ends (real TCP closes cleanly: ws-tcp.test.ts proves the slot is freed).
      hub: { authTimeoutMs: 300, maxPerIp: 3, maxPerSession: 2, maxTotal: 500 },
      connectsPerMinute: 1000,
    },
  });
  owner = await h.newOwner();
  device = await h.newDevice();
  for (const role of ['cashier', 'manager', 'kitchen'] as const) {
    staff[role] = await h.newStaff(role, '4821');
  }
}, 60_000);
beforeEach(() => {
  // A business day per test (10:00 Bangkok): sessions made in a test are fresh, TOTP steps are new.
  dayNo += 1;
  h.clock.set(business(dayNo));
});
afterEach(async () => {
  for (const c of used.splice(0)) if (!c.isClosed()) c.raw.close();
  await pause(20);
});
afterAll(async () => {
  await h.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  token: string | undefined,
  body?: unknown,
) {
  return h.app.inject({
    method,
    url,
    headers: token ? bearer(token) : {},
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}

async function open(options: { ip?: string } = {}): Promise<WsClient> {
  const c = await connect(h.app, options);
  used.push(c);
  return c;
}

type Who = 'cashier' | 'manager' | 'kitchen' | 'owner';
interface Authed {
  client: WsClient;
  token: string;
}

async function sessionFor(who: Who): Promise<string> {
  const token =
    who === 'owner'
      ? await h.ownerSession(owner)
      : await h.pinSession(device.token, staff[who].id, staff[who].pin);
  tokensUsed.push(token);
  return token;
}

/** A signed-in socket: opens, sends the auth message the way the staff app will, waits for ready. */
async function authed(who: Who, over: { ip?: string } = {}): Promise<Authed> {
  const token = await sessionFor(who);
  const client = await open(over);
  client.send({
    type: 'auth',
    sessionToken: token,
    ...(who === 'owner' ? {} : { deviceToken: device.token }),
  });
  await client.next(ofType('ready'));
  return { client, token };
}

const allRoles: Who[] = ['kitchen', 'cashier', 'manager', 'owner'];
async function everyone(): Promise<Record<Who, Authed>> {
  const entries = await Promise.all(allRoles.map(async (r) => [r, await authed(r)] as const));
  return Object.fromEntries(entries) as Record<Who, Authed>;
}

// The heartbeat ping can land at any moment on a slow machine; it is not a business frame.
const typesOf = (c: WsClient) => c.frames.map((f) => f.type).filter((type) => type !== 'ping');
const business = (n: number) => new Date(Date.UTC(2028, 0, n, 3, 0, 0)).toISOString();

let menu: Awaited<ReturnType<Harness['newMenu']>>;
let dayNo = 0;
async function placeOrder(token: string): Promise<{ id: string; orderNo: string }> {
  menu ??= await h.newMenu();
  const res = await call('POST', '/v1/orders', token, {
    clientRequestId: crypto.randomUUID(),
    channel: 'storefront',
    fulfillment: 'entrance_delivery',
    deliveryBuilding: 'B1',
    recipientName: 'Test Recipient',
    items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin, menu.egg] }],
  });
  if (res.statusCode !== 201) throw new Error(`order failed: ${res.statusCode} ${res.body}`);
  return res.json() as { id: string; orderNo: string };
}

// ---------- Connecting and authenticating ----------

describe('the auth message', () => {
  test('a PIN session with its device token gets ready, with the revision and the heartbeat', async () => {
    const { client } = await authed('cashier');
    const ready = client.frames.find(ofType('ready'));
    expect(ready).toMatchObject({ type: 'ready', heartbeatSeconds: 25 });
    expect(typeof ready?.serverRev).toBe('number');
    // Nothing else came before it.
    expect(client.frames[0]?.type).toBe('ready');
  });

  test('an owner session needs no device token (it is not bound to one)', async () => {
    const { client } = await authed('owner');
    expect(client.frames.find(ofType('ready'))).toBeDefined();
  });

  test('ready names the newest rev the server has handed out', async () => {
    const before = await h.client.query<{ v: string }>(
      "select last_value::text as v from pg_sequences where sequencename = 'rev_seq'",
    );
    const { client } = await authed('manager');
    const ready = client.frames.find(ofType('ready'));
    expect(ready?.serverRev).toBeGreaterThanOrEqual(Number(before.rows[0]?.v));
  });

  test('no auth message within the deadline closes 4408', async () => {
    const c = await open();
    expect(await expectClosed(c)).toMatchObject({ code: 4408, reason: 'auth_timeout' });
  });

  test('a slow session check is not the client at fault: the deadline is for the message, not the verdict', async () => {
    // A loaded server: the check takes 400 ms, the deadline for the message is 100 ms.
    const slow = await createHarness({
      realtime: {
        hub: {
          authTimeoutMs: 100,
          checkSession: async (ctx, token, deviceToken) => {
            await pause(400);
            return peekSession(ctx, token, deviceToken);
          },
        },
      },
    });
    try {
      const person = await slow.newStaff('cashier', '4821');
      const dev = await slow.newDevice();
      const token = await slow.pinSession(dev.token, person.id, person.pin);
      const c = await connect(slow.app);
      c.send({ type: 'auth', sessionToken: token, deviceToken: dev.token });
      await c.next(ofType('ready'), 5000);
      expect(c.isClosed()).toBe(false);
      // The deadline still applies to a client that says nothing.
      const silent = await connect(slow.app);
      expect(await expectClosed(silent)).toMatchObject({ code: 4408 });
      c.raw.close();
    } finally {
      await slow.close();
    }
  });

  test('an unknown, malformed or foreign token closes 4401', async () => {
    for (const sessionToken of ['x'.repeat(30), 'sds_ses_NotARealTokenNotARealToken1']) {
      const c = await open();
      c.send({ type: 'auth', sessionToken, deviceToken: device.token });
      expect(await expectClosed(c)).toMatchObject({ code: 4401 });
    }
  });

  test('a PIN session without its device token, or with another device, closes 4403', async () => {
    const token = await sessionFor('cashier');
    const missing = await open();
    missing.send({ type: 'auth', sessionToken: token });
    expect(await expectClosed(missing)).toMatchObject({ code: 4403, reason: 'device_mismatch' });

    const other = await h.newDevice();
    const wrong = await open();
    wrong.send({ type: 'auth', sessionToken: token, deviceToken: other.token });
    expect(await expectClosed(wrong)).toMatchObject({ code: 4403 });
  });

  test('a session that was logged out, or whose device was revoked, closes 4401', async () => {
    const out = await sessionFor('cashier');
    await call('POST', '/v1/auth/logout', out);
    const a = await open();
    a.send({ type: 'auth', sessionToken: out, deviceToken: device.token });
    expect(await expectClosed(a)).toMatchObject({ code: 4401 });

    const spare = await h.newDevice();
    const token = await h.pinSession(spare.token, staff.cashier.id, staff.cashier.pin);
    await h.revokeDevice(spare.id);
    const b = await open();
    b.send({ type: 'auth', sessionToken: token, deviceToken: spare.token });
    expect(await expectClosed(b)).toMatchObject({ code: 4401 });
  });

  test('a session past its idle limit or its end closes 4401', async () => {
    const token = await sessionFor('cashier');
    h.clock.advanceSeconds(2 * 60 * 60 + 1); // the PIN idle limit is two hours
    const c = await open();
    c.send({ type: 'auth', sessionToken: token, deviceToken: device.token });
    expect(await expectClosed(c)).toMatchObject({ code: 4401 });
  });
});

describe('bad messages close 4400 and are never echoed', () => {
  const secret = 'sds_ses_THIS-MUST-NOT-APPEAR-ANYWHERE-1234';

  test.each([
    ['not JSON', 'hello there'],
    ['a JSON array', '[1,2,3]'],
    ['an unknown type', JSON.stringify({ type: 'subscribe', sessionToken: secret })],
    ['an extra field', JSON.stringify({ type: 'auth', sessionToken: secret, admin: true })],
    ['a short token', JSON.stringify({ type: 'auth', sessionToken: 'abc' })],
    ['a pong before auth', JSON.stringify({ type: 'pong' })],
    ['a very long token', JSON.stringify({ type: 'auth', sessionToken: 'a'.repeat(300) })],
  ])('%s', async (_name, text) => {
    const c = await open();
    c.send(text);
    expect(await expectClosed(c)).toMatchObject({ code: 4400, reason: 'bad_message' });
    expect(c.frames).toEqual([]);
  });

  test('a binary frame', async () => {
    const c = await open();
    c.raw.send(Buffer.from([1, 2, 3]), { binary: true });
    expect(await expectClosed(c)).toMatchObject({ code: 4400 });
  });

  test('a second auth message on an open socket', async () => {
    const { client, token } = await authed('cashier');
    client.send({ type: 'auth', sessionToken: token, deviceToken: device.token });
    expect(await expectClosed(client)).toMatchObject({ code: 4400 });
  });

  test('a message over the size cap closes 1009', async () => {
    const c = await open();
    c.send(JSON.stringify({ type: 'auth', sessionToken: 'a'.repeat(5000) }));
    expect(await expectClosed(c)).toMatchObject({ code: 1009 });
  });

  test('more messages than the window allows closes 4429', async () => {
    const { client } = await authed('cashier');
    for (let i = 0; i < 12; i += 1) client.send({ type: 'pong' });
    expect(await expectClosed(client)).toMatchObject({ code: 4429, reason: 'too_many_messages' });
  });

  test('a pong after ready is accepted and answered with nothing', async () => {
    const { client } = await authed('cashier');
    client.send({ type: 'pong' });
    await pause(50);
    expect(client.isClosed()).toBe(false);
    expect(typesOf(client)).toEqual(['ready']);
  });

  test('nothing from a refused message reaches the logs', () => {
    expect(h.logs()).not.toContain(secret);
  });
});

describe('only /v1/ws speaks WebSocket', () => {
  test('an upgrade to any other route is refused, and a signed QR link in its URL is never logged', async () => {
    // The plugin would otherwise upgrade it, say "closed incoming websocket connection for path
    // ..." at info level, and print the URL: the 5-minute credential of the QR picture.
    const id = crypto.randomUUID();
    const exp = Math.floor(h.clock.now().getTime() / 1000) + 300;
    const sig = signQrLink(h.keys.qrUrlKey, id, exp);
    const upgrade = (path: string) =>
      h.app.injectWS(path, { socket: { remoteAddress: freshIp() } } as never);
    await expect(upgrade(`/v1/payments/${id}/qr.png?exp=${exp}&sig=${sig}`)).rejects.toThrow(/404/);
    await expect(upgrade('/v1/orders')).rejects.toThrow(/404/);
    expect(h.logs()).not.toContain(sig);
    expect(h.logs()).not.toContain('closed incoming websocket connection');
  });

  test('a plain GET to the socket address says the address speaks WebSocket (426)', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/ws' });
    expect(res.statusCode).toBe(426);
    expect(res.json()).toMatchObject({ code: 'UPGRADE_REQUIRED', details: {} });
  });
});

describe('limits', () => {
  test('per address: a fourth socket from one address is refused with 4429, before it can say anything', async () => {
    const ip = freshIp();
    for (let i = 0; i < 3; i += 1) await open({ ip });
    const refused = await open({ ip });
    expect(await expectClosed(refused)).toMatchObject({
      code: 4429,
      reason: 'too_many_connections',
    });
    // Another address is not affected.
    const elsewhere = await open();
    elsewhere.send({ type: 'pong' });
    expect(await expectClosed(elsewhere)).toMatchObject({ code: 4400 });
  });

  test('per session: a third socket on one session is refused with 4429', async () => {
    const token = await sessionFor('cashier');
    const msg = { type: 'auth', sessionToken: token, deviceToken: device.token };
    const sockets: WsClient[] = [];
    for (let i = 0; i < 2; i += 1) {
      const c = await open();
      c.send(msg);
      await c.next(ofType('ready'));
      sockets.push(c);
    }
    const third = await open();
    third.send(msg);
    expect(await expectClosed(third)).toMatchObject({ code: 4429, reason: 'too_many_sockets' });
    expect(sockets.every((c) => !c.isClosed())).toBe(true);
  });

  test('upgrade requests are rate limited per address before the upgrade, as a plain 429', async () => {
    const limited = await createHarness({ realtime: { connectsPerMinute: 3 } });
    try {
      const ip = freshIp();
      for (let i = 0; i < 3; i += 1) {
        const c = await connect(limited.app, { ip });
        c.raw.close();
      }
      await expect(connect(limited.app, { ip })).rejects.toThrow(/429/);
      // Another address is untouched.
      const other = await connect(limited.app, { ip: freshIp() });
      other.raw.close();
    } finally {
      await limited.close();
    }
  });

  test('overall: the cap on all sockets refuses the next one', async () => {
    const small = await createHarness({
      realtime: { hub: { maxTotal: 3, maxPerIp: 50, shutdownGraceMs: 200 } },
    });
    try {
      const crowd: WsClient[] = [];
      for (let i = 0; i < 3; i += 1) crowd.push(await connect(small.app));
      const extra = await connect(small.app);
      expect(await expectClosed(extra)).toMatchObject({
        code: 4429,
        reason: 'too_many_connections',
      });
      for (const c of crowd) c.raw.close();
      await Promise.all(crowd.map((c) => c.closed));
    } finally {
      await small.close();
    }
  });
});

// ---------- What arrives, and to whom ----------

describe('fan-out after commit', () => {
  test('an order placed over REST arrives as order.upserted then alert.new_order on every role', async () => {
    const all = await everyone();
    const order = await placeOrder(all.cashier.token);
    for (const who of allRoles) {
      const c = all[who].client;
      const upserted = await c.next((f) => f.type === 'order.upserted' && f.id === order.id);
      const alert = await c.next((f) => f.type === 'alert.new_order' && f.id === order.id);
      // A till order is accepted on the spot (03 §2), so it is already being prepared.
      expect(upserted).toMatchObject({
        id: order.id,
        data: { orderNo: order.orderNo, status: 'preparing' },
      });
      expect(typeof upserted.rev).toBe('number');
      expect(alert).toMatchObject({ data: { orderNo: order.orderNo, channel: 'storefront' } });
      expect('rev' in alert, 'the alert is not a stored row').toBe(false);
      expect(c.frames.indexOf(upserted)).toBeLessThan(c.frames.indexOf(alert));
    }
  });

  test('a refused write sends nothing at all', async () => {
    const all = await everyone();
    const before = all.cashier.client.frames.length;
    const res = await call('POST', '/v1/orders', all.cashier.token, {
      clientRequestId: crypto.randomUUID(),
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B1',
      recipientName: 'Test Recipient',
      items: [{ menuItemId: crypto.randomUUID(), qty: 1, modifierOptionIds: [] }],
    });
    expect(res.statusCode).toBe(422);
    await pause(80);
    expect(all.cashier.client.frames.length).toBe(before);
  });

  test('each frame carries {type, id, rev, data} and revs only go up for one entity', async () => {
    const all = await everyone();
    const order = await placeOrder(all.cashier.token);
    const mover = await call('POST', `/v1/orders/${order.id}/transition`, all.kitchen.token, {
      to: 'ready',
    });
    expect(mover.statusCode).toBe(200);
    const c = all.owner.client;
    await c.next(
      (f) => f.type === 'order.upserted' && (f.data as { status: string }).status === 'preparing',
    );
    const revs = c
      .seen((f) => f.type === 'order.upserted' && f.id === order.id)
      .map((f) => f.rev as number);
    expect(revs.length).toBeGreaterThanOrEqual(2);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
  });

  test('payments reach the till, the manager and the owner, never the kitchen', async () => {
    const all = await everyone();
    const order = await placeOrder(all.cashier.token);
    const res = await call('POST', `/v1/orders/${order.id}/payments`, all.cashier.token, {
      clientRequestId: crypto.randomUUID(),
      method: 'cash',
      tendered: 10000,
    });
    expect(res.statusCode).toBe(201);
    for (const who of ['cashier', 'manager', 'owner'] as const) {
      const frame = await all[who].client.next(ofType('payment.upserted'));
      expect(frame).toMatchObject({
        data: { orderId: order.id, method: 'cash', status: 'confirmed' },
      });
    }
    // The kitchen got the order frames (paymentStatus changed) but no payment frame.
    await all.kitchen.client.next((f) => f.type === 'order.upserted' && f.id === order.id);
    await pause(80);
    expect(typesOf(all.kitchen.client)).not.toContain('payment.upserted');
  });

  test('menu changes reach every role (the kitchen toggles หมด)', async () => {
    const all = await everyone();
    menu ??= await h.newMenu();
    const res = await call(
      'PATCH',
      `/v1/menu/items/${menu.water}/availability`,
      all.kitchen.token,
      {
        isAvailable: false,
      },
    );
    expect(res.statusCode).toBe(200);
    for (const who of allRoles) {
      const frame = await all[who].client.next(ofType('menu.upserted'));
      expect(frame).toMatchObject({ kind: 'item', id: menu.water, data: { isAvailable: false } });
    }
    await call('PATCH', `/v1/menu/items/${menu.water}/availability`, all.kitchen.token, {
      isAvailable: true,
    });
  });

  test('menu frames never carry an estimated cost', async () => {
    const all = await everyone();
    menu ??= await h.newMenu();
    await call('PATCH', `/v1/menu/items/${menu.noodles}/availability`, all.manager.token, {
      isAvailable: false,
    });
    await call('PATCH', `/v1/menu/items/${menu.noodles}/availability`, all.manager.token, {
      isAvailable: true,
    });
    await all.owner.client.next(ofType('menu.upserted'));
    for (const who of allRoles) {
      expect(JSON.stringify(all[who].client.frames)).not.toMatch(/cost/i);
    }
  });

  test('settings go to roles with settings.view; the PromptPay ID is masked everywhere, and never reaches the kitchen', async () => {
    const all = await everyone();
    h.clock.advanceSeconds(90);
    const stepped = await h.steppedUpOwner(owner);
    const current = await h.client.query<{ version: number }>(
      "select version from settings where key = 'promptpay'",
    );
    const res = await call('PATCH', '/v1/settings/promptpay', stepped, {
      expectedVersion: current.rows[0]?.version ?? 0,
      idType: 'phone',
      idValue: PHONE,
    });
    expect(res.statusCode).toBe(200);
    for (const who of ['cashier', 'manager', 'owner'] as const) {
      const frame = await all[who].client.next(
        (f) => f.type === 'settings.updated' && f.id === 'promptpay',
      );
      expect(frame.data).toEqual({ idType: 'phone', idMasked: '******4321' });
    }
    await pause(80);
    expect(typesOf(all.kitchen.client)).not.toContain('settings.updated');
    for (const who of allRoles) {
      expect(JSON.stringify(all[who].client.frames), who).not.toContain(PHONE);
    }
  });

  test('a manager changing payment methods reaches the till but not the kitchen', async () => {
    const all = await everyone();
    const current = await h.client.query<{ version: number }>(
      "select version from settings where key = 'payment_methods'",
    );
    const res = await call('PATCH', '/v1/settings/payments', all.manager.token, {
      expectedVersion: current.rows[0]?.version ?? 0,
      other: true,
    });
    expect(res.statusCode).toBe(200);
    const frame = await all.cashier.client.next(
      (f) => f.type === 'settings.updated' && f.id === 'payment_methods',
    );
    expect(frame).toMatchObject({ version: expect.any(Number), data: { other: true } });
    await pause(80);
    expect(typesOf(all.kitchen.client)).not.toContain('settings.updated');
  });

  test('customer frames reach customer.view only, and are cut down to the DTO', async () => {
    const all = await everyone();
    const id = crypto.randomUUID();
    h.bus.publish({
      type: 'customer.upserted',
      id,
      rev: 99,
      data: {
        id,
        displayName: 'คุณสมชาย',
        nickname: null,
        roomNo: '1204',
        firstSeenAt: '2026-10-02T03:00:00.000Z',
        lastOrderAt: null,
        orderCount: 2,
        totalSpentSatang: 12000,
        anonymized: false,
        version: 1,
        rev: 99,
        // Not on the DTO: must not travel.
        phone: '0811110002',
        lineUserId: 'U-SENTINEL-line-user',
        note: 'NOTE-SENTINEL',
      },
    });
    for (const who of ['cashier', 'manager', 'owner'] as const) {
      const frame = await all[who].client.next(ofType('customer.upserted'));
      expect(Object.keys(frame.data as object).sort()).toEqual(
        [
          'anonymized',
          'displayName',
          'firstSeenAt',
          'id',
          'lastOrderAt',
          'nickname',
          'orderCount',
          'rev',
          'roomNo',
          'totalSpentSatang',
          'version',
        ].sort(),
      );
      expect(JSON.stringify(frame)).not.toMatch(/0811110002|SENTINEL/);
    }
    await pause(80);
    expect(typesOf(all.kitchen.client)).not.toContain('customer.upserted');
  });

  test('an event whose data does not fit its frame is dropped, with only its type in the log', async () => {
    const all = await everyone();
    h.bus.publish({
      type: 'customer.upserted',
      id: crypto.randomUUID(),
      rev: 100,
      data: { displayName: 'LOG-SENTINEL-NAME', phone: 'LOG-SENTINEL-PHONE' },
    });
    // A settings key nobody listed is dropped too (default deny).
    h.bus.publish({
      type: 'settings.updated',
      key: 'line_channel_secret',
      rev: 101,
      version: 1,
      data: { secret: 'LOG-SENTINEL-SECRET' },
    });
    await pause(100);
    for (const who of allRoles) {
      expect(typesOf(all[who].client)).toEqual(['ready']);
    }
    const logs = h.logs();
    expect(logs).toContain('does not fit the frame schema');
    expect(logs).not.toContain('LOG-SENTINEL');
  });

  test('events that are not for devices reach nobody: security alerts, other sessions ending', async () => {
    const all = await everyone();
    h.bus.publish({
      type: 'alert.security',
      kind: 'device.registered',
      severity: 'warn',
      at: '2026-10-02T03:00:00.000Z',
      staffId: null,
      deviceId: null,
    });
    h.bus.publish({ type: 'session.ended', sessionId: crypto.randomUUID(), reason: 'logout' });
    await pause(80);
    for (const who of allRoles) {
      expect(typesOf(all[who].client)).toEqual(['ready']);
      expect(all[who].client.isClosed()).toBe(false);
    }
  });

  test('a socket that has not authenticated yet receives nothing', async () => {
    const lurker = await open();
    const all = await everyone();
    await placeOrder(all.cashier.token);
    await all.owner.client.next(ofType('order.upserted'));
    expect(lurker.frames).toEqual([]);
  });
});

// ---------- Sessions that end on purpose ----------

describe('sessions that end on purpose close their sockets at once', () => {
  test('logout (well before the next 25-second beat)', async () => {
    const { client, token } = await authed('cashier');
    const other = await authed('manager');
    const res = await call('POST', '/v1/auth/logout', token);
    expect(res.statusCode).toBe(204);
    expect(await expectClosed(client, 1500)).toMatchObject({ code: 4401, reason: 'session_ended' });
    expect(other.client.isClosed()).toBe(false);
  });

  test('a logout that lands while the socket is still authenticating: it never becomes ready', async () => {
    // The session check reads the session (valid), then takes 300 ms to answer: the logout commits
    // and is announced in that gap, when the socket has no principal for the event to match.
    const slow = await createHarness({
      realtime: {
        hub: {
          checkSession: async (ctx, token, deviceToken) => {
            const principal = await peekSession(ctx, token, deviceToken);
            await pause(300);
            return principal;
          },
        },
      },
    });
    try {
      const person = await slow.newStaff('cashier', '4821');
      const dev = await slow.newDevice();
      const token = await slow.pinSession(dev.token, person.id, person.pin);
      const c = await connect(slow.app);
      c.send({ type: 'auth', sessionToken: token, deviceToken: dev.token });
      await pause(100);
      const res = await slow.app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: { authorization: `Bearer ${token}` },
        remoteAddress: slow.nextIp(),
      });
      expect(res.statusCode).toBe(204);
      expect(await expectClosed(c, 3000)).toMatchObject({ code: 4401 });
      expect(c.frames.filter(ofType('ready'))).toEqual([]);
    } finally {
      await slow.close();
    }
  });

  test('revoking a device closes the sockets of sessions opened on it', async () => {
    const spare = await h.newDevice();
    const token = await h.pinSession(spare.token, staff.cashier.id, staff.cashier.pin);
    const client = await open();
    client.send({ type: 'auth', sessionToken: token, deviceToken: spare.token });
    await client.next(ofType('ready'));
    const bystander = await authed('manager');

    h.clock.advanceSeconds(90);
    const admin = await h.steppedUpOwner(owner);
    const res = await call('POST', `/v1/devices/${spare.id}/revoke`, admin);
    expect(res.statusCode).toBe(200);
    expect(await expectClosed(client, 1500)).toMatchObject({ code: 4401 });
    expect(bystander.client.isClosed()).toBe(false);
  });

  test('deactivating a person, and setting a new PIN, close their sockets', async () => {
    const victim = await h.newStaff('cashier', '4821');
    const sign = async () => {
      const token = await h.pinSession(device.token, victim.id, victim.pin);
      const c = await open();
      c.send({ type: 'auth', sessionToken: token, deviceToken: device.token });
      await c.next(ofType('ready'));
      return c;
    };
    h.clock.advanceSeconds(90);
    const admin = await h.steppedUpOwner(owner);

    const first = await sign();
    const deactivated = await call('PATCH', `/v1/staff/${victim.id}`, admin, {
      expectedVersion: 1,
      active: false,
    });
    expect(deactivated.statusCode).toBe(200);
    expect(await expectClosed(first, 1500)).toMatchObject({ code: 4401 });

    await call('PATCH', `/v1/staff/${victim.id}`, admin, {
      expectedVersion: (deactivated.json() as { version: number }).version,
      active: true,
    });
    const second = await sign();
    const pin = await call('POST', `/v1/staff/${victim.id}/pin`, admin, { pin: '9087' });
    expect(pin.statusCode).toBe(200);
    expect(await expectClosed(second, 1500)).toMatchObject({ code: 4401 });
  });
});

// ---------- Everything every role received, scanned ----------

describe('what a device could ever have been sent', () => {
  test('no frame to any role holds a PromptPay ID, a hash, a token, a QR payload or a cost', async () => {
    const all = await everyone();
    const order = await placeOrder(all.cashier.token);
    // PromptPay payment: the QR payload is never stored, the masked target is all there is.
    await call('POST', `/v1/orders/${order.id}/payments`, all.cashier.token, {
      clientRequestId: crypto.randomUUID(),
      method: 'promptpay',
    });
    await call('POST', `/v1/orders/${order.id}/cancel`, all.manager.token, { reason: 'ลูกค้ายกเลิก' });
    await all.owner.client.next(ofType('payment.upserted'));

    const staffRows = await h.client.query<{ pin_hash: string }>('select pin_hash from staff');
    const deviceRows = await h.client.query<{ token_hash: string }>(
      'select token_hash from devices',
    );
    const orderRows = await h.client.query<{ request_hash: string }>(
      'select request_hash from orders where request_hash is not null',
    );
    const secrets = [
      PHONE,
      ...staffRows.rows.map((r) => r.pin_hash).filter(Boolean),
      ...deviceRows.rows.map((r) => r.token_hash),
      ...orderRows.rows.map((r) => r.request_hash),
      ...tokensUsed,
      device.token,
    ];
    for (const who of allRoles) {
      const text = JSON.stringify(all[who].client.frames);
      for (const secret of secrets)
        expect(text, `${who} must not see a secret`).not.toContain(secret);
      expect(text, who).not.toMatch(
        /cost|pinHash|pin_hash|tokenHash|token_hash|requestHash|request_hash|qrPayload|qr_payload|idValue|lineUserId|line_user_id|failedPin|lockedUntil|stepUp|slip/i,
      );
    }
  });

  test('the logs hold none of the tokens that were sent in auth messages', () => {
    const logs = h.logs();
    for (const token of tokensUsed) expect(logs).not.toContain(token);
    expect(logs).not.toContain(device.token);
    expect(logs).not.toContain(PHONE);
  });
});

// ---------- Shutdown ----------

describe('shutdown', () => {
  test('closing the app closes every open socket with 1001 and does not hang', async () => {
    const mine = await createHarness({ realtime: { hub: { shutdownGraceMs: 500 } } });
    try {
      const o = await mine.newOwner();
      const token = await mine.ownerSession(o);
      const sockets: WsClient[] = [];
      for (let i = 0; i < 3; i += 1) {
        const c = await connect(mine.app);
        c.send({ type: 'auth', sessionToken: token });
        await c.next(ofType('ready'));
        sockets.push(c);
      }
      const pending = await connect(mine.app); // not authenticated yet
      const started = Date.now();
      await mine.app.close();
      const closes = await Promise.all([...sockets, pending].map((c) => expectClosed(c, 3000)));
      for (const close of closes)
        expect(close).toMatchObject({ code: 1001, reason: 'server_shutdown' });
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await mine.client.close();
    }
  });
});

// A helper kept at the end so the tests above read first.
export type { Frame };
