import type { OrderDto, PushPayload } from '@sds/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { SecurityAlertEvent } from '../events.ts';
import {
  createFakePush,
  type FakeBrowser,
  newBrowser,
  TEST_VAPID,
} from '../test-support/fake-push.ts';
import { createHarness, type Harness, type Menu } from '../test-support/harness.ts';

const MAX_FAILURES = 3;
const fake = createFakePush(2);

let h: Harness;
let plain: Harness;
let menu: Menu;
let till: { id: string; token: string };
let phoneA: { id: string; token: string };
let phoneB: { id: string; token: string };
const staff = {} as Record<'cashier' | 'kitchen' | 'manager', string>;

beforeAll(async () => {
  h = await createHarness({
    push: {
      vapid: TEST_VAPID,
      transport: fake.transport,
      timeoutMs: 80,
      maxFailures: MAX_FAILURES,
    },
  });
  plain = await createHarness();
  menu = await h.newMenu();
  till = await h.newDevice('ipad');
  phoneA = await h.newDevice('iphone');
  phoneB = await h.newDevice('iphone');
  const cashier = await h.newStaff('cashier', '4821');
  staff.cashier = await h.pinSession(till.token, cashier.id, cashier.pin);
  const kitchen = await h.newStaff('kitchen', '4821');
  staff.kitchen = await h.pinSession(phoneA.token, kitchen.id, kitchen.pin);
  const manager = await h.newStaff('manager', '4821');
  staff.manager = await h.pinSession(phoneB.token, manager.id, manager.pin);
}, 90_000);
afterAll(async () => {
  await h.close();
  await plain.close();
});
beforeEach(async () => {
  await h.client.query('delete from push_subscriptions');
  fake.reset();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const body = (browser: FakeBrowser) => ({
  endpoint: browser.endpoint,
  keys: { p256dh: browser.p256dh, auth: browser.auth },
});
const put = (token: string, payload: unknown, harness = h) =>
  harness.app.inject({
    method: 'PUT',
    url: '/v1/push/subscription',
    headers: bearer(token),
    payload: payload as object,
  });
const call = (method: 'GET' | 'DELETE', url: string, token?: string, harness = h) =>
  harness.app.inject({ method, url, headers: token ? bearer(token) : {} });
const rows = async () =>
  (
    await h.client.query<{ device_id: string; failure_count: number }>(
      'select device_id, failure_count from push_subscriptions',
    )
  ).rows;

async function subscribe(token: string, browser = newBrowser()) {
  const res = await put(token, body(browser));
  expect(res.statusCode).toBe(200);
  return browser;
}

// Personal data that must never be on the wire.
const PERSONAL = {
  name: 'สมชาย ใจดีมาก',
  phone: '0812345678',
  // A building the shop delivers to (orders refuse an unknown one).
  building: 'B1',
  note: 'โทร 0899999999 ห้อง 1204',
  itemNote: 'ไม่ใส่ผัก ส่งห้อง 999',
};

async function placeOrder(token = staff.cashier): Promise<OrderDto> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: bearer(token),
    payload: {
      clientRequestId: crypto.randomUUID(),
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: PERSONAL.building,
      recipientName: PERSONAL.name,
      deliveryNote: PERSONAL.note,
      items: [
        {
          menuItemId: menu.noodles,
          qty: 2,
          modifierOptionIds: [menu.thin],
          note: PERSONAL.itemNote,
        },
        { menuItemId: menu.water, qty: 1 },
      ],
    },
  });
  if (res.statusCode !== 201) throw new Error(`place failed: ${res.statusCode} ${res.body}`);
  await h.settle();
  return res.json() as OrderDto;
}

// ---------- config and subscription routes ----------

describe('GET /v1/push/config', () => {
  test('says enabled with the public key when VAPID is set up', async () => {
    const res = await call('GET', '/v1/push/config', staff.kitchen);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, publicKey: TEST_VAPID.publicKey });
    expect(res.body).not.toContain(TEST_VAPID.privateKey);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('answers 200 with enabled false and no key when VAPID is not set up', async () => {
    const device = await plain.newDevice('iphone');
    const member = await plain.newStaff('cashier', '4821');
    const token = await plain.pinSession(device.token, member.id, '4821');
    const res = await call('GET', '/v1/push/config', token, plain);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, publicKey: null });
  });
});

describe('without VAPID the subscription routes answer 503 PUSH_NOT_CONFIGURED', () => {
  test('GET, PUT and DELETE', async () => {
    const device = await plain.newDevice('iphone');
    const member = await plain.newStaff('cashier', '4821');
    const token = await plain.pinSession(device.token, member.id, '4821');
    const responses = [
      await call('GET', '/v1/push/subscription', token, plain),
      await put(token, body(newBrowser()), plain),
      await call('DELETE', '/v1/push/subscription', token, plain),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'PUSH_NOT_CONFIGURED' });
    }
  });
});

describe('permissions', () => {
  test('every route needs a signed-in session', async () => {
    const browser = newBrowser();
    const results = [
      await call('GET', '/v1/push/config'),
      await call('GET', '/v1/push/subscription'),
      await put('', body(browser)),
      await call('DELETE', '/v1/push/subscription'),
    ];
    for (const res of results) expect(res.statusCode).toBe(401);
    expect(await rows()).toEqual([]);
  });

  test.each(['cashier', 'kitchen', 'manager'] as const)(
    'a %s may subscribe the device they are on',
    async (role) => {
      const res = await put(staff[role], body(newBrowser()));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ subscribed: true });
    },
  );

  test('the owner may too, on a registered device', async () => {
    const owner = await h.newOwner();
    const device = await h.newDevice('laptop');
    const token = await h.ownerSession(owner, device.token);
    const res = await put(token, body(newBrowser()));
    expect(res.statusCode).toBe(200);
    expect(await rows()).toEqual([{ device_id: device.id, failure_count: 0 }]);
  });

  test('a session with no device behind it cannot subscribe (403 DEVICE_REQUIRED)', async () => {
    const owner = await h.newOwner();
    const token = await h.ownerSession(owner);
    const res = await put(token, body(newBrowser()));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'DEVICE_REQUIRED' });
    expect((await call('GET', '/v1/push/config', token)).statusCode).toBe(200);
    expect(await rows()).toEqual([]);
  });

  test('a revoked device can no longer use the routes', async () => {
    const device = await h.newDevice('iphone');
    const member = await h.newStaff('cashier', '4821');
    const token = await h.pinSession(device.token, member.id, '4821');
    await subscribe(token);
    await h.revokeDevice(device.id);
    expect((await call('GET', '/v1/push/subscription', token)).statusCode).toBe(401);
  });

  test('the device comes from the session, not the body', async () => {
    const res = await put(staff.kitchen, { ...body(newBrowser()), deviceId: phoneB.id });
    expect(res.statusCode).toBe(200);
    expect(await rows()).toEqual([{ device_id: phoneA.id, failure_count: 0 }]);
  });
});

describe('subscribe, unsubscribe and status', () => {
  test('a device is off until it subscribes; subscribing twice keeps one row; unsubscribing is repeatable', async () => {
    const read = async () => (await call('GET', '/v1/push/subscription', staff.kitchen)).json();
    expect(await read()).toEqual({ subscribed: false });
    const first = await put(staff.kitchen, body(newBrowser()));
    expect(first.json()).toEqual({ subscribed: true });
    expect(await read()).toEqual({ subscribed: true });
    const newer = newBrowser();
    expect((await put(staff.kitchen, body(newer))).statusCode).toBe(200);
    expect((await put(staff.kitchen, body(newer))).statusCode).toBe(200);
    expect(await rows()).toHaveLength(1);
    const stored = await h.client.query<{ endpoint: string }>(
      'select endpoint from push_subscriptions',
    );
    expect(stored.rows[0]?.endpoint).toBe(newer.endpoint);

    const off = await call('DELETE', '/v1/push/subscription', staff.kitchen);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ subscribed: false });
    expect(await read()).toEqual({ subscribed: false });
    expect((await call('DELETE', '/v1/push/subscription', staff.kitchen)).json()).toEqual({
      subscribed: false,
    });
  });

  test('each device has its own switch', async () => {
    await subscribe(staff.kitchen);
    expect((await call('GET', '/v1/push/subscription', staff.manager)).json()).toEqual({
      subscribed: false,
    });
    await subscribe(staff.manager);
    await call('DELETE', '/v1/push/subscription', staff.kitchen);
    expect(await rows()).toEqual([{ device_id: phoneB.id, failure_count: 0 }]);
  });

  test('accepts what PushSubscription.toJSON() sends, including expirationTime', async () => {
    const res = await put(staff.kitchen, { ...body(newBrowser()), expirationTime: null });
    expect(res.statusCode).toBe(200);
  });

  test.each([
    [
      'an endpoint outside the allow-list',
      (b: FakeBrowser) => ({ ...body(b), endpoint: 'https://example.com/push/abc' }),
    ],
    [
      'an http endpoint',
      (b: FakeBrowser) => ({ ...body(b), endpoint: b.endpoint.replace('https', 'http') }),
    ],
    [
      'an internal address',
      (b: FakeBrowser) => ({ ...body(b), endpoint: 'https://169.254.169.254/latest' }),
    ],
    [
      'a key that is not a curve point',
      (b: FakeBrowser) => ({
        endpoint: b.endpoint,
        keys: { p256dh: `B${'A'.repeat(86)}`, auth: b.auth },
      }),
    ],
    [
      'a short auth secret',
      (b: FakeBrowser) => ({ endpoint: b.endpoint, keys: { p256dh: b.p256dh, auth: 'abc' } }),
    ],
    ['no keys', (b: FakeBrowser) => ({ endpoint: b.endpoint })],
  ])('refuses %s with 400 and stores nothing', async (_name, make) => {
    const res = await put(staff.kitchen, make(newBrowser()));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await rows()).toEqual([]);
  });

  test('neither the endpoint nor the keys appear in a response or a log line', async () => {
    const browser = newBrowser();
    const res = await put(staff.kitchen, body(browser));
    const bad = await put(staff.kitchen, {
      ...body(browser),
      endpoint: 'https://example.com/leak-check',
    });
    const status = await call('GET', '/v1/push/subscription', staff.kitchen);
    const out = [res.body, bad.body, status.body, h.logs()].join('\n');
    for (const secret of [browser.endpoint, browser.p256dh, browser.auth, 'leak-check']) {
      expect(out).not.toContain(secret);
    }
    expect(h.logs()).not.toContain(TEST_VAPID.privateKey);
  });
});

// ---------- sending ----------

describe('a new order alerts subscribed devices', () => {
  test('sends one encrypted alert to every other subscribed device, not the one the order was typed on', async () => {
    const onTill = await subscribe(staff.cashier);
    const a = await subscribe(staff.kitchen);
    const b = await subscribe(staff.manager);
    const order = await placeOrder();

    expect(fake.sentTo(onTill.endpoint)).toHaveLength(0);
    for (const browser of [a, b]) {
      const sent = fake.sentTo(browser.endpoint);
      expect(sent).toHaveLength(1);
      const request = sent[0];
      expect(request?.headers).toMatchObject({
        'content-encoding': 'aes128gcm',
        ttl: '120',
        urgency: 'high',
      });
      expect(request?.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
      expect(request?.headers.authorization).toContain(`k=${TEST_VAPID.publicKey}`);
      const payload = browser.decrypt(request as NonNullable<typeof request>) as PushPayload;
      expect(payload).toEqual({
        title: `ออเดอร์ใหม่ #${order.orderNo} (หน้าร้าน)`,
        body: '3 รายการ',
        url: `/#/orders/${order.id}`,
        tag: `order-${order.id}`,
      });
    }
    expect(fake.requests).toHaveLength(2);
  });

  test('the alert carries no personal data, in the plaintext or anywhere in the request', async () => {
    const browser = await subscribe(staff.kitchen);
    await placeOrder();
    const request = fake.sentTo(browser.endpoint)[0];
    expect(request).toBeDefined();
    const plaintext = JSON.stringify(browser.decrypt(request as NonNullable<typeof request>));
    const everything = `${plaintext}\n${JSON.stringify(request?.headers)}\n${request?.endpoint}`;
    for (const secret of [
      PERSONAL.name,
      'สมชาย',
      PERSONAL.phone,
      '0899999999',
      '1204',
      'ผัก',
      '999',
    ]) {
      expect(everything).not.toContain(secret);
    }
    // The wire form is encrypted: the title is not readable in the body.
    expect(Buffer.from(request?.body ?? []).toString('utf8')).not.toContain('ออเดอร์');
    expect(Object.keys(JSON.parse(plaintext)).sort()).toEqual(['body', 'tag', 'title', 'url']);
  });

  test('devices that did not subscribe get nothing, and an order with nobody subscribed sends nothing', async () => {
    await placeOrder();
    expect(fake.requests).toHaveLength(0);
  });

  test('a revoked device is skipped, and revoking through the API deletes its subscription', async () => {
    const goneDevice = await h.newDevice('iphone');
    const goneStaff = await h.newStaff('cashier', '4821');
    const gone = await subscribe(await h.pinSession(goneDevice.token, goneStaff.id, '4821'));
    const kept = await subscribe(staff.manager);
    // Revoked behind the API's back (a row left over): skipped when sending.
    await h.revokeDevice(goneDevice.id);
    await placeOrder();
    expect(fake.sentTo(gone.endpoint)).toHaveLength(0);
    expect(fake.sentTo(kept.endpoint)).toHaveLength(1);

    const owner = await h.newOwner();
    const ownerToken = await h.steppedUpOwner(owner);
    const victim = await h.newDevice('iphone');
    const member = await h.newStaff('cashier', '4821');
    const victimToken = await h.pinSession(victim.token, member.id, '4821');
    await subscribe(victimToken);
    expect((await rows()).some((r) => r.device_id === victim.id)).toBe(true);
    const revoke = await h.app.inject({
      method: 'POST',
      url: `/v1/devices/${victim.id}/revoke`,
      headers: bearer(ownerToken),
      remoteAddress: h.nextIp(),
    });
    expect(revoke.statusCode).toBe(200);
    expect((await rows()).some((r) => r.device_id === victim.id)).toBe(false);
  });

  test('sends are bounded: never more than the concurrency limit at once', async () => {
    for (let i = 0; i < 12; i += 1) {
      const device = await h.newDevice('iphone');
      const member = await h.newStaff('cashier', '4821');
      await subscribe(await h.pinSession(device.token, member.id, '4821'));
    }
    await placeOrder();
    expect(fake.requests).toHaveLength(12);
    expect(fake.maxInFlight()).toBeGreaterThan(1);
    expect(fake.maxInFlight()).toBeLessThanOrEqual(5);
  });
});

describe('what the push service answers', () => {
  const countOf = async (deviceId: string) =>
    (await rows()).find((r) => r.device_id === deviceId)?.failure_count;

  test.each([404, 410])('%i deletes the subscription', async (status) => {
    const browser = await subscribe(staff.kitchen);
    fake.answer(browser.endpoint, status);
    await placeOrder();
    expect(await rows()).toEqual([]);
  });

  test('2xx keeps it, sets last_success_at and clears earlier failures', async () => {
    const browser = await subscribe(staff.kitchen);
    fake.answer(browser.endpoint, 503);
    await placeOrder();
    expect(await countOf(phoneA.id)).toBe(1);
    fake.answer(browser.endpoint, 201);
    await placeOrder();
    expect(await countOf(phoneA.id)).toBe(0);
    const last = await h.client.query<{ last_success_at: Date | null }>(
      'select last_success_at from push_subscriptions',
    );
    expect(last.rows[0]?.last_success_at).not.toBeNull();
  });

  test.each([429, 500, 503])(
    '%i counts as a failure, and the subscription is dropped at the limit',
    async (status) => {
      const browser = await subscribe(staff.kitchen);
      fake.answer(browser.endpoint, status);
      for (let i = 1; i < MAX_FAILURES; i += 1) {
        await placeOrder();
        expect(await countOf(phoneA.id)).toBe(i);
      }
      await placeOrder();
      expect(await rows()).toEqual([]);
    },
  );

  test.each([400, 401, 403, 413])(
    '%i is our request being refused: logged, never counted',
    async (status) => {
      const browser = await subscribe(staff.kitchen);
      fake.answer(browser.endpoint, status);
      for (let i = 0; i < MAX_FAILURES + 2; i += 1) await placeOrder();
      expect(await countOf(phoneA.id)).toBe(0);
    },
  );

  test('a network error and a timeout count as failures and never break the order', async () => {
    const thrower = await subscribe(staff.kitchen);
    const hanger = await subscribe(staff.manager);
    fake.answer(thrower.endpoint, 'throw');
    fake.answer(hanger.endpoint, 'hang');
    const order = await placeOrder();
    expect(order.orderNo).toBeTruthy();
    expect(await countOf(phoneA.id)).toBe(1);
    expect(await countOf(phoneB.id)).toBe(1);
    const stored = await h.client.query('select id from orders where id = $1', [order.id]);
    expect(stored.rows).toHaveLength(1);
    // The log names the subscription and the error class, never the endpoint.
    expect(h.logs()).not.toContain(thrower.endpoint);
    expect(h.logs()).not.toContain(hanger.endpoint);
  });

  test('one failing device does not stop the others', async () => {
    const bad = await subscribe(staff.kitchen);
    const good = await subscribe(staff.manager);
    fake.answer(bad.endpoint, 'throw');
    await placeOrder();
    expect(fake.sentTo(good.endpoint)).toHaveLength(1);
    expect(await countOf(phoneB.id)).toBe(0);
  });

  test('a stored endpoint that is no longer allowed is removed without a request', async () => {
    await subscribe(staff.kitchen);
    await h.client.query("update push_subscriptions set endpoint = 'https://example.com/old'");
    await placeOrder();
    expect(fake.requests).toHaveLength(0);
    expect(await rows()).toEqual([]);
  });
});

// ---------- security and ops alerts (OPS-02) ----------

describe('security and ops alerts reach owner and manager devices (OPS-02)', () => {
  const alert = (over: Partial<SecurityAlertEvent> = {}): SecurityAlertEvent => ({
    type: 'alert.security',
    kind: 'settings.promptpay_changed',
    severity: 'warn',
    at: '2030-01-01T05:30:00.000Z',
    staffId: null,
    deviceId: null,
    ...over,
  });
  const raise = async (event: SecurityAlertEvent) => {
    h.bus.publish(event);
    await h.settle();
  };
  const decrypted = (browser: FakeBrowser) =>
    fake.sentTo(browser.endpoint).map((request) => browser.decrypt(request) as PushPayload);

  test('a warn alert goes to the manager and the owner, never to the cashier or the kitchen', async () => {
    const onTill = await subscribe(staff.cashier);
    const kitchen = await subscribe(staff.kitchen);
    const manager = await subscribe(staff.manager);
    const owner = await h.newOwner();
    const ownerPhone = await h.newDevice('iphone');
    const ownerBrowser = await subscribe(await h.ownerSession(owner, ownerPhone.token));

    await raise(alert());

    expect(fake.sentTo(onTill.endpoint)).toHaveLength(0);
    expect(fake.sentTo(kitchen.endpoint)).toHaveLength(0);
    for (const browser of [manager, ownerBrowser]) {
      expect(decrypted(browser)).toEqual([
        {
          title: 'แจ้งเตือนระบบ',
          body: 'settings.promptpay_changed',
          url: '/#/settings',
          tag: 'alert-settings.promptpay_changed-2030-01-01T05:30:00.000Z',
        },
      ]);
    }
  });

  test('a critical alert about an order says so and opens that order; ids and the order number only', async () => {
    const manager = await subscribe(staff.manager);
    const orderId = crypto.randomUUID();
    await raise(
      alert({
        kind: 'slip.fraud_blocked',
        severity: 'critical',
        subject: { orderId, paymentId: crypto.randomUUID() },
        orderNo: 'L-042',
        slip2go: { code: '200501' },
      }),
    );
    const [payload] = decrypted(manager);
    expect(payload).toEqual({
      title: 'แจ้งเตือนด่วน',
      body: 'slip.fraud_blocked · ออเดอร์ #L-042',
      url: `/#/orders/${orderId}`,
      tag: 'alert-slip.fraud_blocked-2030-01-01T05:30:00.000Z',
    });
  });

  test('the same kind twice alerts twice (the Sentry "new issue" e-mail would not)', async () => {
    const manager = await subscribe(staff.manager);
    await raise(alert({ at: '2030-01-01T05:30:00.000Z' }));
    await raise(alert({ at: '2030-01-02T05:30:00.000Z' }));
    expect(decrypted(manager)).toHaveLength(2);
  });

  test('an info alert sends nothing', async () => {
    await subscribe(staff.manager);
    await raise(alert({ kind: 'device.registered', severity: 'info' }));
    expect(fake.requests).toHaveLength(0);
  });

  test('a manager who was deactivated gets nothing', async () => {
    const device = await h.newDevice('iphone');
    const member = await h.newStaff('manager', '4821');
    const browser = await subscribe(await h.pinSession(device.token, member.id, '4821'));
    await h.client.query('update staff set active = false where id = $1', [member.id]);
    await raise(alert());
    expect(fake.sentTo(browser.endpoint)).toHaveLength(0);
  });
});
