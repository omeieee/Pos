/**
 * The customer app's API on the real app and an in-memory Postgres (PGlite): the LIFF login, the
 * order, the payment choices, "โอนแล้ว" and the QR, and above all that a customer reaches ONLY
 * their own orders and can never confirm money (CLAUDE.md rules 1, 2, 4). LINE is a fake: the
 * verifier answers from a table of made-up tokens, and nothing here calls LINE.
 */
import { customersRepo, retentionRepo } from '@sds/db';
import { promptpayPayload } from '@sds/promptpay';
import {
  ANONYMIZED_BUILDING,
  ANONYMIZED_RECIPIENT_NAME,
  MAX_OPEN_ORDERS,
  type MyOrder,
  myOrderSchema,
  PRIVACY_NOTICE_VERSION,
  satang,
} from '@sds/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_AUTH_POLICY } from '../auth/policy.ts';
import type { AuthContext } from '../auth/service.ts';
import type { AppEvent } from '../events.ts';
import { LiffUnavailableError, type LiffVerifier } from '../line/liff-verify.ts';
import { createLineRuntime } from '../line/runtime.ts';
import { qrPng } from '../payments/qr.ts';
import { movePayment } from '../payments/service.ts';
import {
  createHarness,
  type Harness,
  type Menu,
  type OwnerFixture,
} from '../test-support/harness.ts';
import { readCustomerToken } from './session.ts';

// Made-up LINE user ids and tokens: not real people, not real tokens.
// A, B and C are new people for every test (see `freshPeople`): the per-customer rate limits are
// real and count in wall-clock minutes, so tests that share a customer would use each other's quota.
let U_A = '';
let U_B = '';
let U_C = '';
const U_D = 'Utest00000000000000000000000000d4';
const TOKENS: Record<string, string> = {};
let peopleNo = 0;
function freshPeople(): void {
  peopleNo += 1;
  const id = (letter: string) => `Utest${String(peopleNo).padStart(23, '0')}${letter}${letter}0000`;
  U_A = id('a');
  U_B = id('b');
  U_C = id('c');
  TOKENS['id-token-a-0000000000000000000000'] = U_A;
  TOKENS['id-token-b-0000000000000000000000'] = U_B;
  TOKENS['id-token-c-0000000000000000000000'] = U_C;
  TOKENS['id-token-d-0000000000000000000000'] = U_D;
}
freshPeople();
const TOKEN_A = 'id-token-a-0000000000000000000000';
const TOKEN_B = 'id-token-b-0000000000000000000000';
const TOKEN_C = 'id-token-c-0000000000000000000000';
const TOKEN_D = 'id-token-d-0000000000000000000000';
const PHONE = '0899994321'; // test PromptPay ID, not real

let h: Harness;
let menu: Menu;
let owner: OwnerFixture;
let lineDown = false;
let ctx: AuthContext;

const verifier: LiffVerifier = {
  async verify(credential) {
    if (lineDown) throw new LiffUnavailableError();
    const token = 'idToken' in credential ? credential.idToken : credential.accessToken;
    const userId = TOKENS[token];
    return userId ? { userId } : null;
  },
};

beforeAll(async () => {
  const runtime = createLineRuntime(
    {
      channelSecret: 'unused-test-secret',
      channelAccessToken: undefined,
      liffId: '1234567890-abcdefgh',
    },
    { liffVerifier: verifier, client: null },
  );
  h = await createHarness({ line: runtime });
  menu = await h.newMenu();
  owner = await h.newOwner();
  ctx = {
    db: h.db,
    keys: h.keys,
    policy: DEFAULT_AUTH_POLICY,
    now: h.clock.now,
    events: h.bus,
  };
}, 60_000);
afterAll(async () => {
  await h.close();
});

/** Every test gets its own day at 15:00 Bangkok, inside the delivery window (13:00 to 23:00). */
let dayNo = 0;
function newDay(hourUtc = 8): void {
  dayNo += 1;
  h.clock.set(new Date(Date.UTC(2028, 0, dayNo, hourUtc, 0, 0)).toISOString());
}

async function setScheme(enabled: boolean) {
  await h.client.query(
    `insert into gov_copay_schemes (code, name_th, gov_share_bp, gov_daily_cap_satang, gov_total_cap_satang,
       active_from, active_to, active_from_minute, active_to_minute, channels, enabled)
     values ('test', 'ไทยช่วยไทย', 6000, 20000, null, '2026-10-01', '2030-12-31', 360, 1380, '{storefront}', $1)
     on conflict (code) do update set enabled = $1`,
    [enabled],
  );
}
async function setPromptpay(id: string | null) {
  await h.client.query("delete from settings where key = 'promptpay'");
  if (id) {
    await h.client.query(
      "insert into settings (key, value, updated_by) values ('promptpay', $1::jsonb, $2)",
      [JSON.stringify({ idType: 'phone', idValue: id }), owner.staffId],
    );
  }
}

beforeEach(async () => {
  freshPeople();
  newDay();
  await setPromptpay(PHONE);
  await setScheme(true);
  await h.client.query(
    "delete from settings where key in ('payment_methods', 'opening_hours', 'line_ordering')",
  );
  // Earlier tests' orders must not fill the per-customer limit of open orders.
  await h.client.query(
    "update orders set status = 'completed' where channel = 'line' and status not in ('completed', 'cancelled')",
  );
});

function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  token: string | undefined,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return h.app.inject({
    method,
    url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}

async function signIn(idToken: string): Promise<string> {
  const res = await call('POST', '/v1/app/session', undefined, { idToken });
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.statusCode}`);
  return res.json().token as string;
}
const acknowledge = (token: string) => call('POST', '/v1/app/privacy-ack', token);

/** A customer who has signed in and acknowledged the notice. */
async function customer(idToken: string): Promise<string> {
  const token = await signIn(idToken);
  expect((await acknowledge(token)).statusCode).toBe(200);
  return token;
}

const body = (over: Record<string, unknown> = {}) => ({
  clientRequestId: crypto.randomUUID(),
  items: [
    { menuItemId: menu.noodles, qty: 2, modifierOptionIds: [menu.thin, menu.egg] },
    { menuItemId: menu.water, qty: 1 },
  ],
  deliveryBuilding: 'B1',
  recipientName: 'ฟ้าทดสอบ',
  deliveryNote: 'ชั้น 3',
  paymentMethod: 'promptpay',
  ...over,
});
// 2 x (50 + 5) + 10 = 120 baht
const TOTAL = 12000;

async function order(token: string, over: Record<string, unknown> = {}) {
  const res = await call('POST', '/v1/app/orders', token, body(over));
  return {
    res,
    json: res.json() as { order: MyOrder; paymentError: string | null; replay: boolean },
  };
}

const eventsOf = (type: AppEvent['type']) => h.events.filter((e) => e.type === type);

describe('a LIFF id that LINE keeps refusing', () => {
  test('repeated refusals log a counter and raise one alert an hour, with no token or id anywhere', async () => {
    const before = h.alerts.filter((a) => a.kind === 'liff.verify_failing').length;
    for (let i = 0; i < 8; i++) {
      const res = await call('POST', '/v1/app/session', undefined, {
        idToken: `refused-token-${i}-00000000000000000000`,
      });
      expect(res.statusCode).toBe(401);
    }
    expect(h.alerts.filter((a) => a.kind === 'liff.verify_failing').length - before).toBe(1);
    const logs = h.logs();
    expect(logs).toContain('LIFF verification refused repeatedly');
    expect(logs).not.toContain('refused-token');
    // A genuine sign-in clears the streak.
    expect(
      (await call('POST', '/v1/app/session', undefined, { idToken: TOKEN_A })).statusCode,
    ).toBe(200);
  });
});

describe('the LIFF login', () => {
  test('a genuine token gives a session for that LINE user and nothing about staff', async () => {
    const res = await call('POST', '/v1/app/session', undefined, { idToken: TOKEN_A });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.token).toMatch(/^sds_cst\./);
    expect(json.privacyAcknowledged).toBe(false);
    expect(json.privacyVersion).toBe(PRIVACY_NOTICE_VERSION);
    // The customer row is made on first use and keyed by the verified user id.
    const rows = await h.client.query('select id from customers where line_user_id = $1', [U_A]);
    expect(rows.rows).toHaveLength(1);
    expect(JSON.stringify(json)).not.toContain(U_A);
    // Signing in again finds the same customer.
    await call('POST', '/v1/app/session', undefined, { accessToken: TOKEN_A });
    expect(
      (await h.client.query('select id from customers where line_user_id = $1', [U_A])).rows,
    ).toHaveLength(1);
  });

  test('a bad token is always the same 401, and a client-sent user id is refused outright', async () => {
    const bad = await call('POST', '/v1/app/session', undefined, { idToken: 'x'.repeat(40) });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('LIFF_TOKEN_INVALID');
    const withUserId = await call('POST', '/v1/app/session', undefined, {
      idToken: TOKEN_A,
      userId: U_B,
    });
    expect(withUserId.statusCode).toBe(400);
    expect((await call('POST', '/v1/app/session', undefined, {})).statusCode).toBe(400);
    // Nothing was made for U_B: its id was never read.
    expect(
      (await h.client.query('select id from customers where line_user_id = $1', [U_B])).rows,
    ).toHaveLength(0);
  });

  test('LINE being down is a 503, not a refusal of the customer', async () => {
    lineDown = true;
    try {
      const res = await call('POST', '/v1/app/session', undefined, { idToken: TOKEN_A });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe('LINE_UNAVAILABLE');
    } finally {
      lineDown = false;
    }
  });

  test('the session endpoint is rate limited per address', async () => {
    const ip = '10.250.250.1';
    let last = 0;
    for (let i = 0; i < 32; i++) {
      last = (
        await h.app.inject({
          method: 'POST',
          url: '/v1/app/session',
          payload: { idToken: 'x'.repeat(40) },
          remoteAddress: ip,
        })
      ).statusCode;
    }
    expect(last).toBe(429);
  });

  test('a signed-in customer is limited per customer (30 writes a minute) even from many addresses', async () => {
    const token = await signIn(TOKEN_D); // its own customer: the other tests must not share the count
    const statuses: number[] = [];
    // Every call comes from a new address, so only the per-customer limit can stop them.
    for (let i = 0; i < 36; i++) statuses.push((await acknowledge(token)).statusCode);
    expect(statuses.slice(0, 25).every((s) => s === 200)).toBe(true);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(4);
    expect(statuses.at(-1)).toBe(429);
  });

  test('the session ends: after an hour, when tampered with, and when the customer is erased', async () => {
    const token = await signIn(TOKEN_A);
    expect((await call('GET', '/v1/app/orders', token)).statusCode).toBe(200);
    const parts = token.split('.');
    const forged = `${parts[0]}.${Buffer.from(
      JSON.stringify({ c: 'f0f0f0f0-0000-4000-8000-000000000001', e: 9999999999 }),
    ).toString('base64url')}.${parts[2]}`;
    expect((await call('GET', '/v1/app/orders', forged)).statusCode).toBe(401);
    expect(readCustomerToken(h.keys.customerSessionKey, token, 0)).not.toBeNull();
    // A token made with another key is no good.
    expect(readCustomerToken(Buffer.alloc(32, 1), token, 0)).toBeNull();

    // Erasure (PDPA) ends it at once, whatever the token still says.
    const customerId = (
      await h.client.query<{ id: string }>('select id from customers where line_user_id = $1', [
        U_A,
      ])
    ).rows[0]?.id as string;
    await customersRepo.anonymizeCustomer(h.db, customerId, h.clock.now());
    expect((await call('GET', '/v1/app/orders', token)).statusCode).toBe(401);

    const fresh = await signIn(TOKEN_B);
    h.clock.advanceSeconds(3601);
    expect((await call('GET', '/v1/app/orders', fresh)).statusCode).toBe(401);
  });

  test('credentials are not interchangeable: staff routes refuse a customer, customer routes refuse staff', async () => {
    const token = await signIn(TOKEN_A);
    expect((await call('GET', '/v1/orders', token)).statusCode).toBe(401);
    expect((await call('GET', '/v1/settings/shop', token)).statusCode).toBe(401);
    const staffToken = await h.ownerSession(owner);
    expect((await call('GET', '/v1/app/orders', staffToken)).statusCode).toBe(401);
    expect((await call('GET', '/v1/app/orders', undefined)).statusCode).toBe(401);
    expect((await call('GET', '/v1/app/orders', 'not-a-token')).statusCode).toBe(401);
  });
});

describe('placing an order', () => {
  test('is refused until the privacy notice is acknowledged, then stores the version', async () => {
    const token = await signIn(TOKEN_B);
    const before = await order(token);
    expect(before.res.statusCode).toBe(403);
    expect(before.json).toMatchObject({ code: 'PRIVACY_NOT_ACKNOWLEDGED' });
    expect((await acknowledge(token)).statusCode).toBe(200);
    const stored = await h.client.query<{
      privacy_ack_version: string | null;
      privacy_ack_at: string | null;
    }>('select privacy_ack_version, privacy_ack_at from customers where line_user_id = $1', [U_B]);
    expect(stored.rows[0]).toMatchObject({ privacy_ack_version: PRIVACY_NOTICE_VERSION });
    expect(stored.rows[0]?.privacy_ack_at).not.toBeNull();
    expect((await order(token)).res.statusCode).toBe(201);
  });

  test('the server prices it, fixes channel and fulfilment, and the kitchen is alerted once', async () => {
    const token = await customer(TOKEN_A);
    const before = eventsOf('alert.new_order').length;
    const { res, json } = await order(token, { paymentMethod: 'cash' });
    expect(res.statusCode).toBe(201);
    myOrderSchema.parse(json.order);
    expect(json.order.totalSatang).toBe(TOTAL);
    expect(json.order.status).toBe('new');
    expect(json.order.deliveryBuilding).toBe('B1');
    expect(json.order.orderNo).toMatch(/^L-\d{3}$/);
    const row = (
      await h.client.query(
        'select channel, fulfillment, customer_id, created_by_staff_id, created_on_device_id from orders where id = $1',
        [json.order.id],
      )
    ).rows[0];
    expect(row).toMatchObject({
      channel: 'line',
      fulfillment: 'entrance_delivery',
      created_by_staff_id: null,
      created_on_device_id: null,
    });
    const alerts = eventsOf('alert.new_order').slice(before);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ channel: 'line', status: 'new', createdOnDeviceId: null });
  });

  test('a client cannot send a price, a total, a channel, a customer or a staff id', async () => {
    const token = await customer(TOKEN_A);
    for (const extra of [
      { totalSatang: 1 },
      { channel: 'storefront' },
      { fulfillment: 'takeaway' },
      { customerId: crypto.randomUUID() },
      { originalStaffId: crypto.randomUUID() },
    ]) {
      const res = await call('POST', '/v1/app/orders', token, body(extra));
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect(
      (await call('POST', '/v1/app/orders', token, body({ paymentMethod: 'platform' }))).statusCode,
    ).toBe(400);
  });

  test('a building outside the owner list, and a closed shop, are refused before anything is saved', async () => {
    let token = await customer(TOKEN_A);
    const unknown = await order(token, { deliveryBuilding: 'Z9' });
    expect(unknown.res.statusCode).toBe(422);
    expect(unknown.json).toMatchObject({ code: 'UNKNOWN_BUILDING' });

    newDay(3); // 10:00 Bangkok: delivery opens at 13:00
    token = await signIn(TOKEN_A); // the old session ended with the day
    const closed = await order(token);
    expect(closed.res.statusCode).toBe(409);
    expect(closed.json).toMatchObject({ code: 'SHOP_CLOSED' });
    const info = await call('GET', '/v1/app/checkout', token);
    expect(info.json().delivery).toMatchObject({ open: false });

    await h.client.query(
      `insert into settings (key, value, updated_by) values ('opening_hours', $1::jsonb, $2)
       on conflict (key) do update set value = $1::jsonb`,
      [
        JSON.stringify({
          storefront: { openMinute: 0, closeMinute: 1440 },
          delivery: { openMinute: 0, closeMinute: 1440 },
          weekly: {},
          overrides: [],
        }),
        owner.staffId,
      ],
    );
    expect((await order(token)).res.statusCode).toBe(201);
  });

  test("the owner's LINE switch: open at any time, off, or by the delivery hours", async () => {
    const setMode = (mode: string) =>
      h.client.query(
        `insert into settings (key, value, updated_by) values ('line_ordering', $1::jsonb, $2)
         on conflict (key) do update set value = $1::jsonb`,
        [JSON.stringify({ mode }), owner.staffId],
      );
    newDay(3); // 10:00 Bangkok: delivery opens at 13:00
    const token = await customer(TOKEN_A);

    await setMode('open');
    expect((await call('GET', '/v1/app/checkout', token)).json().delivery).toEqual({
      open: true,
      window: null,
      mode: 'open',
    });
    expect((await order(token)).res.statusCode).toBe(201); // outside the delivery hours

    await setMode('closed');
    const refused = await order(token);
    expect(refused.res.statusCode).toBe(409);
    expect(refused.json).toMatchObject({ code: 'SHOP_CLOSED', details: { mode: 'closed' } });
    expect((await call('GET', '/v1/app/checkout', token)).json().delivery).toMatchObject({
      open: false,
      mode: 'closed',
    });

    await setMode('scheduled');
    expect((await order(token)).res.statusCode).toBe(409); // 10:00 is before 13:00
  });

  test('an order accepted just before the LINE switch went off still replays', async () => {
    const token = await customer(TOKEN_A);
    const payload = body();
    expect((await call('POST', '/v1/app/orders', token, payload)).statusCode).toBe(201);
    await h.client.query(
      `insert into settings (key, value, updated_by) values ('line_ordering', '{"mode":"closed"}'::jsonb, $1)`,
      [owner.staffId],
    );
    const again = await call('POST', '/v1/app/orders', token, payload);
    expect(again.statusCode).toBe(200);
    expect(again.json().replay).toBe(true);
    expect((await order(token)).res.statusCode).toBe(409); // a new order is refused
  });

  test('PromptPay starts a pending payment for exactly the order total; cash records nothing', async () => {
    const token = await customer(TOKEN_A);
    const pp = await order(token, { paymentMethod: 'promptpay' });
    expect(pp.json.paymentError).toBeNull();
    expect(pp.json.order.payment).toMatchObject({
      method: 'promptpay',
      status: 'pending',
      amountSatang: TOTAL,
    });
    expect(pp.json.order.actions).toMatchObject({ claim: true, showQr: true, changeMethod: true });

    const cash = await order(token, { paymentMethod: 'cash' });
    expect(cash.json.order.payment).toBeNull();
    expect(
      (await h.client.query('select id from payments where order_id = $1', [cash.json.order.id]))
        .rows,
    ).toHaveLength(0);
    expect(cash.json.order.paymentStatus).toBe('unpaid');
  });

  test('ไทยช่วยไทย is always on offer: a pending payment with no QR, with scheme figures only while the scheme runs', async () => {
    const token = await customer(TOKEN_A);
    expect((await call('GET', '/v1/app/checkout', token)).json().methods).toContain('gov_copay');
    const ok = await order(token, { paymentMethod: 'gov_copay' });
    expect(ok.res.statusCode).toBe(201);
    expect(ok.json.order.payment).toMatchObject({ method: 'gov_copay', status: 'pending' });
    expect(ok.json.order.actions.showQr).toBe(false);
    expect(ok.json.order.actions.claim).toBe(false);
    // No QR route answers for it, and no QR is stored.
    const qr = await call('GET', `/v1/app/orders/${ok.json.order.id}/qr`, token);
    expect(qr.statusCode).toBe(409);
    expect(
      (
        await h.client.query<{ qr_payload: string | null }>(
          'select qr_payload from payments where order_id = $1',
          [ok.json.order.id],
        )
      ).rows[0]?.qr_payload,
    ).toBeNull();

    // With the scheme off the option stays: it is a request staff see, with no scheme figures.
    expect(
      (
        await h.client.query<{ scheme_id: string | null }>(
          'select scheme_id from payments where order_id = $1',
          [ok.json.order.id],
        )
      ).rows[0]?.scheme_id,
    ).not.toBeNull();
    await setScheme(false);
    expect((await call('GET', '/v1/app/checkout', token)).json().methods).toContain('gov_copay');
    const request = await order(token, { paymentMethod: 'gov_copay' });
    expect(request.res.statusCode).toBe(201);
    expect(request.json.order.payment).toMatchObject({ method: 'gov_copay', status: 'pending' });
    expect(
      (
        await h.client.query<{ scheme_id: string | null; est_gov_share_satang: string | null }>(
          'select scheme_id, est_gov_share_satang from payments where order_id = $1',
          [request.json.order.id],
        )
      ).rows[0],
    ).toMatchObject({ scheme_id: null, est_gov_share_satang: null });
  });

  test('methods the owner switched off are not on offer', async () => {
    const token = await customer(TOKEN_A);
    await h.client.query(
      `insert into settings (key, value, updated_by) values ('payment_methods', $1::jsonb, $2)`,
      [
        JSON.stringify({ cash: false, promptpay: true, platform: true, other: false }),
        owner.staffId,
      ],
    );
    expect((await call('GET', '/v1/app/checkout', token)).json().methods).toEqual([
      'promptpay',
      'gov_copay',
    ]);
    expect((await order(token, { paymentMethod: 'cash' })).res.statusCode).toBe(422);
    await setPromptpay(null);
    expect((await call('GET', '/v1/app/checkout', token)).json().methods).toEqual(['gov_copay']);
  });

  test('the same request again returns the same order: no second order, alert or payment', async () => {
    const token = await customer(TOKEN_A);
    const payload = body();
    const first = await call('POST', '/v1/app/orders', token, payload);
    const alerts = eventsOf('alert.new_order').length;
    const again = await call('POST', '/v1/app/orders', token, payload);
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json().replay).toBe(true);
    expect(again.json().order.id).toBe(first.json().order.id);
    expect(eventsOf('alert.new_order')).toHaveLength(alerts);
    expect(
      (await h.client.query('select id from payments where order_id = $1', [first.json().order.id]))
        .rows,
    ).toHaveLength(1);
    // Same id, different content: refused.
    const reused = await call('POST', '/v1/app/orders', token, {
      ...payload,
      recipientName: 'คนอื่น',
    });
    expect(reused.statusCode).toBe(409);
  });

  test("another customer cannot reuse or read this customer's request id", async () => {
    const a = await customer(TOKEN_A);
    const b = await customer(TOKEN_B);
    const payload = body();
    const mine = await call('POST', '/v1/app/orders', a, payload);
    const theirs = await call('POST', '/v1/app/orders', b, payload);
    expect(theirs.statusCode).toBe(409);
    expect(JSON.stringify(theirs.json())).not.toContain(mine.json().order.id);
    expect(JSON.stringify(theirs.json())).not.toContain('ฟ้าทดสอบ');
  });

  test('the payment is audited as the customer, never as staff', async () => {
    const token = await customer(TOKEN_A);
    const { json } = await order(token);
    const paymentId = json.order.payment?.id as string;
    const rows = await h.auditRows(paymentId);
    expect(rows.map((r) => [r.action, r.actorType])).toEqual([['payment.create', 'customer']]);
  });

  test('the shop is told about a LINE order with the same events a counter order raises', async () => {
    const token = await customer(TOKEN_A);
    const marker = h.events.length;
    const { json } = await order(token);
    const types = h.events.slice(marker).map((e) => e.type);
    expect(types).toContain('order.upserted');
    expect(types).toContain('payment.upserted');
    expect(types).toContain('alert.new_order');
    const upserted = h.events
      .slice(marker)
      .find((e) => e.type === 'order.upserted' && e.id === json.order.id);
    expect(upserted).toBeDefined();
  });
});

describe('limits on one customer', () => {
  test('a new order is refused while the customer already has 3 open ones; finishing one frees a place', async () => {
    const token = await customer(TOKEN_B);
    const placed: string[] = [];
    for (let i = 0; i < MAX_OPEN_ORDERS; i++) {
      const { res, json } = await order(token, { paymentMethod: 'cash' });
      expect(res.statusCode).toBe(201);
      placed.push(json.order.id);
    }
    const refused = await order(token, { paymentMethod: 'cash' });
    expect(refused.res.statusCode).toBe(409);
    expect(refused.json).toMatchObject({ code: 'TOO_MANY_OPEN_ORDERS' });
    // Nothing was written for the refused one, and no alert was raised.
    const count = await h.client.query(
      "select id from orders where customer_id = (select id from customers where line_user_id = $1) and status not in ('completed','cancelled')",
      [U_B],
    );
    expect(count.rows).toHaveLength(MAX_OPEN_ORDERS);
    // A retry of an order that already exists is not refused.
    const payload = body({ paymentMethod: 'cash' });
    await h.client.query("update orders set status = 'completed' where id = $1", [placed[0]]);
    expect((await call('POST', '/v1/app/orders', token, payload)).statusCode).toBe(201);
    expect((await call('POST', '/v1/app/orders', token, payload)).statusCode).toBe(200);
    // Cancelled and completed orders do not count.
    await h.client.query("update orders set status = 'cancelled' where id = $1", [placed[1]]);
    expect((await order(token, { paymentMethod: 'cash' })).res.statusCode).toBe(201);
  });

  test("one customer's open orders do not block another", async () => {
    const other = await customer(TOKEN_A);
    expect((await order(other, { paymentMethod: 'cash' })).res.statusCode).toBe(201);
  });

  test('an order of more than 50 items in total is refused with 422, 50 is accepted', async () => {
    const token = await customer(TOKEN_B);
    const big = (qty: number) => ({
      paymentMethod: 'cash',
      items: [
        { menuItemId: menu.water, qty: Math.min(qty, 40) },
        { menuItemId: menu.water, qty: Math.max(0, qty - 40) || 1 },
      ],
    });
    const tooMany = await order(token, big(51));
    expect(tooMany.res.statusCode).toBe(422);
    expect(tooMany.json).toMatchObject({ code: 'ORDER_TOO_LARGE' });
    // exactly 50 in total: 40 + 10
    expect((await order(token, big(50))).res.statusCode).toBe(201);
  });
});

describe('only your own orders', () => {
  test('another customer gets a plain 404 on every order route, and the list is only their own', async () => {
    const a = await customer(TOKEN_A);
    const b = await customer(TOKEN_B);
    const mine = (await order(a)).json.order;
    for (const [method, path, payload] of [
      ['GET', `/v1/app/orders/${mine.id}`, undefined],
      ['GET', `/v1/app/orders/${mine.id}/qr`, undefined],
      ['POST', `/v1/app/orders/${mine.id}/claim`, undefined],
      ['POST', `/v1/app/orders/${mine.id}/payment`, { method: 'cash' }],
    ] as const) {
      const res = await call(method, path, b, payload);
      expect(res.statusCode, `${method} ${path}`).toBe(404);
      expect(JSON.stringify(res.json())).not.toContain(mine.orderNo);
    }
    const listB = (await call('GET', '/v1/app/orders', b)).json().orders as MyOrder[];
    expect(listB.every((o) => o.id !== mine.id)).toBe(true);
    const listA = (await call('GET', '/v1/app/orders', a)).json().orders as MyOrder[];
    expect(listA.some((o) => o.id === mine.id)).toBe(true);
    // Nothing changed on the order: still pending.
    expect((await call('GET', `/v1/app/orders/${mine.id}`, a)).json().payment.status).toBe(
      'pending',
    );
  });

  test('the view carries no staff id, no cost and no version counter', async () => {
    const a = await customer(TOKEN_A);
    const { json } = await order(a);
    const text = JSON.stringify(json);
    for (const word of ['Staff', 'cost', 'version', 'rev', 'customerId']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('the PromptPay QR', () => {
  test('is a fresh signed link for the exact total, rebuilt from the current ID each time', async () => {
    const token = await customer(TOKEN_A);
    const { json } = await order(token);
    const first = await call('GET', `/v1/app/orders/${json.order.id}/qr`, token);
    expect(first.statusCode).toBe(200);
    const link = first.json();
    expect(link).toMatchObject({ amountSatang: TOTAL, promptpayId: PHONE });
    const png = await h.app.inject({ method: 'GET', url: link.url, remoteAddress: h.nextIp() });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    const expected = await qrPng(
      promptpayPayload({ idType: 'phone', idValue: PHONE }, satang(TOTAL)),
    );
    expect(Buffer.compare(png.rawPayload, expected)).toBe(0);

    // A later fetch is a new link; and when the owner changes the ID the next picture follows it.
    h.clock.advanceSeconds(120);
    const second = (await call('GET', `/v1/app/orders/${json.order.id}/qr`, token)).json();
    expect(second.url).not.toBe(link.url);
    await setPromptpay('0877775555');
    const changed = await h.app.inject({
      method: 'GET',
      url: second.url,
      remoteAddress: h.nextIp(),
    });
    expect(Buffer.compare(changed.rawPayload, expected)).not.toBe(0);
    expect(
      (await call('GET', `/v1/app/orders/${json.order.id}/qr`, token)).json().promptpayId,
    ).toBe('0877775555');
  });

  test('cash has none, and a cancelled order has none', async () => {
    const token = await customer(TOKEN_A);
    const cash = (await order(token, { paymentMethod: 'cash' })).json.order;
    expect((await call('GET', `/v1/app/orders/${cash.id}/qr`, token)).statusCode).toBe(409);
  });
});

describe('"โอนแล้ว" and the payment choices', () => {
  test('a claim makes the payment claimed, tells the POS in the same request, and staff must still confirm', async () => {
    const token = await customer(TOKEN_A);
    const { json } = await order(token);
    const marker = h.events.length;
    const res = await call('POST', `/v1/app/orders/${json.order.id}/claim`, token);
    expect(res.statusCode).toBe(200);
    expect(res.json().payment.status).toBe('claimed');
    expect(res.json().paymentStatus).toBe('awaiting_confirmation');
    // The same events a staff claim publishes, already out when the answer came back.
    const after = h.events.slice(marker);
    expect(after.some((e) => e.type === 'payment.upserted' && e.data.status === 'claimed')).toBe(
      true,
    );
    expect(
      after.some(
        (e) => e.type === 'order.upserted' && e.data.paymentStatus === 'awaiting_confirmation',
      ),
    ).toBe(true);
    // Nothing confirmed it.
    const row = (
      await h.client.query(
        'select status, confirmed_by_staff_id, confirmed_at from payments where order_id = $1',
        [json.order.id],
      )
    ).rows[0];
    expect(row).toMatchObject({
      status: 'claimed',
      confirmed_by_staff_id: null,
      confirmed_at: null,
    });

    // Claiming again is a harmless 200.
    expect((await call('POST', `/v1/app/orders/${json.order.id}/claim`, token)).statusCode).toBe(
      200,
    );
    expect(res.json().actions.claim).toBe(false);
    // The audit trail says who: the customer, as a claim.
    const audit = await h.auditRows(json.order.payment?.id as string);
    expect(audit.map((r) => r.action)).toEqual(['payment.create']);
  });

  test('a customer can never confirm, cancel a claim, void or refund: the machine refuses', async () => {
    const token = await customer(TOKEN_A);
    const { json } = await order(token);
    await call('POST', `/v1/app/orders/${json.order.id}/claim`, token);
    const customerId = (
      await h.client.query<{ id: string }>('select id from customers where line_user_id = $1', [
        U_A,
      ])
    ).rows[0]?.id as string;
    const paymentId = json.order.payment?.id as string;
    for (const move of ['confirm', 'cancel-claimed', 'void', 'refund'] as const) {
      await expect(
        movePayment(
          ctx,
          { kind: 'customer', customerId },
          paymentId,
          move,
          { reason: 'x' },
          { ip: null },
        ),
        move,
      ).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(
      (await h.client.query('select status from payments where id = $1', [paymentId])).rows[0],
    ).toMatchObject({ status: 'claimed' });
  });

  test('claiming a cash or co-pay order is refused', async () => {
    const token = await customer(TOKEN_A);
    const cash = (await order(token, { paymentMethod: 'cash' })).json.order;
    expect((await call('POST', `/v1/app/orders/${cash.id}/claim`, token)).statusCode).toBe(409);
    const copay = (await order(token, { paymentMethod: 'gov_copay' })).json.order;
    expect((await call('POST', `/v1/app/orders/${copay.id}/claim`, token)).statusCode).toBe(409);
  });

  test('the method can change while nothing is claimed; each change leaves one open payment at most', async () => {
    const token = await customer(TOKEN_A);
    const o = (await order(token, { paymentMethod: 'promptpay' })).json.order;
    const pay = (method: string) =>
      call('POST', `/v1/app/orders/${o.id}/payment`, token, { method });

    const toCopay = await pay('gov_copay');
    expect(toCopay.json().payment).toMatchObject({ method: 'gov_copay', status: 'pending' });
    const same = await pay('gov_copay'); // already the waiting method: nothing changes
    expect(same.statusCode).toBe(200);
    const toCash = await pay('cash');
    expect(toCash.json().payment).toBeNull();
    expect(toCash.json().paymentStatus).toBe('unpaid');
    const back = await pay('promptpay');
    expect(back.json().payment).toMatchObject({ method: 'promptpay', status: 'pending' });

    const open = await h.client.query(
      "select method from payments where order_id = $1 and status in ('pending','claimed')",
      [o.id],
    );
    expect(open.rows).toHaveLength(1);
    // Every drop was a customer move, audited as the customer.
    const all = await h.client.query<{ id: string }>(
      'select id from payments where order_id = $1',
      [o.id],
    );
    const actors = new Set<string>();
    for (const p of all.rows) for (const r of await h.auditRows(p.id)) actors.add(r.actorType);
    expect([...actors]).toEqual(['customer']);
  });

  test('after the customer reports a transfer the method cannot change: staff decide', async () => {
    const token = await customer(TOKEN_A);
    const o = (await order(token)).json.order;
    await call('POST', `/v1/app/orders/${o.id}/claim`, token);
    const res = await call('POST', `/v1/app/orders/${o.id}/payment`, token, { method: 'cash' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('PAYMENT_NOT_PENDING');
    const view = (await call('GET', `/v1/app/orders/${o.id}`, token)).json() as MyOrder;
    expect(view.actions).toMatchObject({ changeMethod: false, claim: false, methods: [] });
  });

  test('ไทยช่วยไทย can still be chosen once the scheme has closed: staff see the request', async () => {
    const token = await customer(TOKEN_A);
    const o = (await order(token, { paymentMethod: 'promptpay' })).json.order;
    await setScheme(false);
    const res = await call('POST', `/v1/app/orders/${o.id}/payment`, token, {
      method: 'gov_copay',
    });
    expect(res.statusCode).toBe(200);
    const view = (await call('GET', `/v1/app/orders/${o.id}`, token)).json() as MyOrder;
    expect(view.payment).toMatchObject({ method: 'gov_copay', status: 'pending' });
  });

  test('staff cannot confirm a ไทยช่วยไทย request while the scheme is off; once it runs the figures are saved', async () => {
    const token = await customer(TOKEN_A);
    await setScheme(false);
    const o = (await order(token, { paymentMethod: 'gov_copay' })).json.order;
    const staffToken = await h.ownerSession(owner);
    const refused = await call('POST', `/v1/payments/${o.payment?.id}/confirm`, staffToken, {});
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe('GOV_COPAY_UNAVAILABLE');
    await setScheme(true);
    const ok = await call('POST', `/v1/payments/${o.payment?.id}/confirm`, staffToken, {});
    expect(ok.statusCode).toBe(200);
    expect(
      (
        await h.client.query<{ scheme_id: string | null; est_gov_share_satang: string | null }>(
          'select scheme_id, est_gov_share_satang from payments where id = $1',
          [o.payment?.id],
        )
      ).rows[0],
    ).toMatchObject({ scheme_id: expect.any(String), est_gov_share_satang: expect.anything() });
  });

  test('after staff confirm, the customer sees paid and cannot change or claim', async () => {
    const token = await customer(TOKEN_A);
    const o = (await order(token)).json.order;
    await call('POST', `/v1/app/orders/${o.id}/claim`, token);
    const staffToken = await h.ownerSession(owner);
    const confirm = await call('POST', `/v1/payments/${o.payment?.id}/confirm`, staffToken, {});
    expect(confirm.statusCode).toBe(200);
    const view = (await call('GET', `/v1/app/orders/${o.id}`, token)).json() as MyOrder;
    expect(view.paymentStatus).toBe('paid');
    expect(view.payment).toMatchObject({ status: 'confirmed' });
    expect(view.actions).toMatchObject({ claim: false, changeMethod: false });
  });
});

describe('remembering the recipient', () => {
  test('the last recipient is offered for reference, and gone once the retention job has erased it', async () => {
    const token = await customer(TOKEN_C); // a customer with no orders yet
    expect((await call('GET', '/v1/app/checkout', token)).json().lastRecipient).toBeNull();
    const o = (await order(token, { recipientName: 'ลูกค้าทดสอบ', deliveryBuilding: 'C2' })).json
      .order;
    expect((await call('GET', '/v1/app/checkout', token)).json().lastRecipient).toEqual({
      building: 'C2',
      recipientName: 'ลูกค้าทดสอบ',
      deliveryNote: 'ชั้น 3',
    });
    // Finish the order, then run the retention batch 31 days later.
    await h.client.query(
      "update orders set status = 'completed', completed_at = $1 where id = $2",
      [h.clock.now().toISOString(), o.id],
    );
    h.clock.advanceSeconds(31 * 86400);
    await retentionRepo.anonymizeOrderSnapshotsBatch(h.db, {
      before: new Date(h.clock.now().getTime() - 30 * 86_400_000),
      limit: 100,
      now: h.clock.now(),
    });
    const stored = (
      await h.client.query<{ recipient_name: string; delivery_building: string }>(
        'select recipient_name, delivery_building from orders where id = $1',
        [o.id],
      )
    ).rows[0];
    expect(stored).toMatchObject({
      recipient_name: ANONYMIZED_RECIPIENT_NAME,
      delivery_building: ANONYMIZED_BUILDING,
    });
    const later = await signIn(TOKEN_C); // the old session ended long ago
    expect((await call('GET', '/v1/app/checkout', later)).json().lastRecipient).toBeNull();
  });
});

describe('the menu and logs', () => {
  test('the public LINE menu is what the app shows: LINE prices, no costs, no sold-out items', async () => {
    const res = await call('GET', '/v1/menu?channel=line', undefined);
    expect(res.statusCode).toBe(200);
    const text = JSON.stringify(res.json());
    expect(text).toContain('น้ำเปล่า');
    expect(text).not.toContain('estCost');
    expect(text).not.toContain('หมด"');
  });

  test('no LINE user id, token or customer detail reaches the logs', async () => {
    const token = await customer(TOKEN_A);
    const { json } = await order(token, { recipientName: 'นามสมมติ', deliveryNote: 'หมายเหตุสมมติ' });
    await call('POST', `/v1/app/orders/${json.order.id}/claim`, token);
    await call('POST', '/v1/app/orders', token, { bad: true });
    await call('POST', '/v1/app/session', undefined, {
      idToken: 'secret-looking-token-0000000000000',
    });
    const logs = h.logs();
    for (const secret of [U_A, TOKEN_A, token, 'นามสมมติ', 'หมายเหตุสมมติ', 'secret-looking-token']) {
      expect(logs, secret).not.toContain(secret);
    }
  });
});
