/**
 * The ordering chat and the completion push, end to end through the real webhook (signature,
 * dedupe, router, handlers) on an in-memory Postgres. LINE is a fake client that records what was
 * replied and pushed; nothing here calls LINE. The rules under test: reply first (free), push only
 * through the quota-aware sender and only once per LINE order, a chat button reaches only the
 * sender's own orders, "โอนแล้ว" only claims, and no QR ever goes out in a chat card (rule 4).
 */
import { createHmac } from 'node:crypto';
import type { LineClient, LineMessage } from '@sds/line';
import { orderPlacedText } from '@sds/line';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createMemorySlipStore } from '../slips/store.ts';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';
import { LiffUnavailableError, type LiffVerifier } from './liff-verify.ts';
import { createLineRuntime, type LineRuntime } from './runtime.ts';

// Made-up ids and tokens only.
const SECRET = 'test-channel-secret-not-real';
const LIFF_ID = '1234567890-abcdefgh';
const LIFF = `https://liff.line.me/${LIFF_ID}`;
const U_A = 'Utest00000000000000000000000000a1';
const U_B = 'Utest00000000000000000000000000b2';
const TOKENS: Record<string, string> = {
  'id-token-a-0000000000000000000000': U_A,
  'id-token-b-0000000000000000000000': U_B,
};
const PHONE = '0899994321';

interface Sent {
  kind: 'reply' | 'push';
  to: string;
  messages: LineMessage[];
}
const sent: Sent[] = [];
let pushFails = false;
// One owner sign-in per test: a one-time code cannot be used twice in the same 30 seconds.
let staffToken: string | undefined;

// What LINE would hand back for a picture message id: a tiny made-up JPEG, or a failure.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
let content: Awaited<ReturnType<NonNullable<LineClient['getMessageContent']>>> = {
  ok: true,
  bytes: JPEG,
};
const fetched: string[] = [];
const slipStore = createMemorySlipStore();

const fakeClient: LineClient = {
  async getMessageContent(messageId) {
    fetched.push(messageId);
    return content;
  },
  async reply(replyToken, messages) {
    sent.push({ kind: 'reply', to: replyToken, messages });
    return { ok: true };
  },
  async push(to, messages) {
    sent.push({ kind: 'push', to, messages });
    return pushFails ? { ok: false, definite: true, status: 400 } : { ok: true };
  },
};
const verifier: LiffVerifier = {
  async verify(credential) {
    const token = 'idToken' in credential ? credential.idToken : credential.accessToken;
    const userId = TOKENS[token];
    if (token === 'down') throw new LiffUnavailableError();
    return userId ? { userId } : null;
  },
};

let h: Harness;
let runtime: LineRuntime;
let owner: OwnerFixture;

beforeAll(async () => {
  runtime = createLineRuntime(
    { channelSecret: SECRET, channelAccessToken: undefined, liffId: LIFF_ID },
    { client: fakeClient, liffVerifier: verifier },
  );
  h = await createHarness({ line: runtime, slips: slipStore });
  owner = await h.newOwner();
}, 60_000);
afterAll(async () => {
  await h.close();
});

let dayNo = 0;
beforeEach(async () => {
  dayNo += 1;
  h.clock.set(new Date(Date.UTC(2029, 0, dayNo, 8, 0, 0)).toISOString()); // 15:00 Bangkok
  sent.length = 0;
  fetched.length = 0;
  content = { ok: true, bytes: JPEG };
  pushFails = false;
  staffToken = undefined;
  // Earlier tests' orders must not fill the per-customer limit of open orders.
  await h.client.query(
    "update orders set status = 'completed' where channel = 'line' and status not in ('completed', 'cancelled')",
  );
  await h.client.query(
    "delete from settings where key in ('promptpay', 'line_policy', 'payment_methods')",
  );
  await h.client.query(
    "insert into settings (key, value, updated_by) values ('promptpay', $1::jsonb, $2)",
    [JSON.stringify({ idType: 'phone', idValue: PHONE }), owner.staffId],
  );
  await h.client.query(
    `insert into gov_copay_schemes (code, name_th, gov_share_bp, gov_daily_cap_satang, gov_total_cap_satang,
       active_from, active_to, active_from_minute, active_to_minute, channels, enabled)
     values ('test', 'ไทยช่วยไทย', 6000, 20000, null, '2026-10-01', '2031-12-31', 360, 1380, '{storefront}', true)
     on conflict (code) do update set enabled = true`,
  );
});

// ---------- helpers ----------

const sign = (raw: string) => createHmac('sha256', SECRET).update(raw).digest('base64');
let counter = 0;
const eventId = () => `evt-chat-${Date.now()}-${++counter}`;

async function deliver(...events: Record<string, unknown>[]) {
  const raw = JSON.stringify({ destination: 'Utest', events });
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/line/webhook',
    headers: { 'content-type': 'application/json', 'x-line-signature': sign(raw) },
    payload: raw,
    remoteAddress: h.nextIp(),
  });
  expect(res.statusCode).toBe(200);
  await runtime.idle();
}
const base = (userId: string, id = eventId()) => ({
  webhookEventId: id,
  replyToken: `rt-${id}`,
  source: { type: 'user', userId },
  timestamp: 1,
  mode: 'active',
  deliveryContext: { isRedelivery: false },
});
const text = (userId: string, value: string, id?: string) => ({
  type: 'message',
  ...base(userId, id),
  message: { type: 'text', id: '1', text: value },
});
const postback = (userId: string, data: string, id?: string) => ({
  type: 'postback',
  ...base(userId, id),
  postback: { data },
});

function call(method: 'GET' | 'POST', url: string, token?: string, body?: unknown) {
  return h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}

async function signIn(idToken: string) {
  const res = await call('POST', '/v1/app/session', undefined, { idToken });
  const token = res.json().token as string;
  await call('POST', '/v1/app/privacy-ack', token);
  return token;
}

async function place(token: string, method: 'cash' | 'promptpay' | 'gov_copay' = 'promptpay') {
  const m = await h.newMenu();
  const res = await call('POST', '/v1/app/orders', token, {
    clientRequestId: crypto.randomUUID(),
    items: [
      { menuItemId: m.noodles, qty: 2, modifierOptionIds: [m.thin, m.egg] },
      { menuItemId: m.water, qty: 1 },
    ],
    deliveryBuilding: 'B1',
    recipientName: 'ฟ้าทดสอบ',
    paymentMethod: method,
  });
  expect(res.statusCode).toBe(201);
  return res.json().order as { id: string; orderNo: string; totalSatang: number };
}

const walk = (node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] => {
  if (Array.isArray(node)) for (const n of node) walk(n, out);
  else if (node && typeof node === 'object') {
    out.push(node as Record<string, unknown>);
    for (const v of Object.values(node)) walk(v, out);
  }
  return out;
};
const allText = (messages: LineMessage[]) =>
  messages
    .flatMap((m) => walk(m))
    .map((n) => (typeof n.text === 'string' ? n.text : ''))
    .join('\n');
const replies = () => sent.filter((s) => s.kind === 'reply');
const pushes = () => sent.filter((s) => s.kind === 'push');
const lastReply = () => replies().at(-1)?.messages ?? [];

async function paymentOf(orderId: string) {
  const r = await h.client.query<{ id: string; method: string; status: string }>(
    'select id, method, status from payments where order_id = $1 order by rev',
    [orderId],
  );
  return r.rows;
}

async function staffSession(): Promise<string> {
  staffToken ??= await h.ownerSession(owner);
  return staffToken;
}

/** Walks an order to `completed` the way staff do, with the owner's session. */
async function complete(orderId: string) {
  const staff = await staffSession();
  const now = (
    await h.client.query<{ status: string }>('select status from orders where id = $1', [orderId])
  ).rows[0]?.status;
  const steps = ['preparing', 'ready', 'completed'];
  // A counter order starts already preparing.
  for (const to of steps.slice(steps.indexOf(now === 'new' ? 'preparing' : 'ready'))) {
    const res = await call('POST', `/v1/orders/${orderId}/transition`, staff, { to });
    expect(res.statusCode, to).toBe(200);
  }
  await runtime.idle();
}

// ---------- tests ----------

describe('the order confirmation the app asks for', () => {
  test('is a free reply with the card and the how-to-pay card: no QR picture, a button to the order page', async () => {
    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token, 'promptpay');
    await deliver(text(U_A, orderPlacedText(order.orderNo)));

    expect(replies()).toHaveLength(1);
    expect(pushes()).toHaveLength(0);
    const messages = lastReply();
    expect(messages).toHaveLength(2);
    const words = allText(messages);
    expect(words).toContain(order.orderNo);
    expect(words).toContain('฿120.00');
    expect(words).toContain(PHONE);
    // The exact amount and the ID are text; the QR itself lives only in the app.
    const nodes = messages.flatMap((m) => walk(m));
    expect(nodes.filter((n) => n.type === 'image')).toHaveLength(0);
    expect(JSON.stringify(messages)).not.toMatch(/qr\.png|sig=/i);
    const uris = nodes
      .map((n) => (n.action as { uri?: string } | undefined)?.uri)
      .filter((u): u is string => typeof u === 'string');
    expect(uris).toEqual([`${LIFF}/orders/${order.id}`]);
    // It was logged as an uncounted reply, and no quota was used.
    const log = await h.client.query<{ kind: string; counted: boolean }>(
      'select kind, counted from line_message_log where order_id = $1',
      [order.id],
    );
    expect(log.rows).toEqual([{ kind: 'reply', counted: false }]);
  });

  test('cash and ไทยช่วยไทย orders get their instructions with no link and no image at all', async () => {
    const token = await signIn('id-token-a-0000000000000000000000');
    for (const method of ['cash', 'gov_copay'] as const) {
      sent.length = 0;
      const order = await place(token, method);
      await deliver(text(U_A, orderPlacedText(order.orderNo)));
      const payCard = lastReply()[1] as LineMessage;
      expect(JSON.stringify(payCard), method).not.toMatch(/https?:|"type":"image"|qr\.png/i);
    }
    expect(allText(lastReply())).toContain('ทางเข้าตึก');
  });

  test("someone else's order number, or a number nobody owns, gets no reply and shows nothing", async () => {
    const tokenA = await signIn('id-token-a-0000000000000000000000');
    await signIn('id-token-b-0000000000000000000000');
    const order = await place(tokenA);
    await deliver(text(U_B, orderPlacedText(order.orderNo)));
    await deliver(text(U_B, orderPlacedText('L-999')));
    expect(sent).toHaveLength(0);
  });

  test('the same webhook delivered twice answers once', async () => {
    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token);
    const event = text(U_A, orderPlacedText(order.orderNo), 'evt-dup-1');
    await deliver(event);
    await deliver(event);
    expect(replies()).toHaveLength(1);
  });
});

describe('"โอนแล้ว" from the chat', () => {
  test('claims the payment, tells the POS at once, and staff still have to confirm', async () => {
    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token);
    const marker = h.events.length;
    await deliver(postback(U_A, `action=paid&order=${order.id}`));
    expect(await paymentOf(order.id)).toMatchObject([{ method: 'promptpay', status: 'claimed' }]);
    expect(
      h.events
        .slice(marker)
        .some((e) => e.type === 'payment.upserted' && e.data.status === 'claimed'),
    ).toBe(true);
    expect(allText(lastReply())).toContain(order.orderNo);
    // The app sees the same.
    const view = (await call('GET', `/v1/app/orders/${order.id}`, token)).json();
    expect(view.payment.status).toBe('claimed');
    expect(view.paymentStatus).toBe('awaiting_confirmation');
    // Nothing confirmed it.
    const confirmed = await h.client.query(
      "select id from payments where order_id = $1 and status = 'confirmed'",
      [order.id],
    );
    expect(confirmed.rows).toHaveLength(0);
  });

  test("another customer's tap on this order's button changes nothing", async () => {
    const tokenA = await signIn('id-token-a-0000000000000000000000');
    await signIn('id-token-b-0000000000000000000000');
    const order = await place(tokenA);
    await deliver(postback(U_B, `action=paid&order=${order.id}`));
    expect(await paymentOf(order.id)).toMatchObject([{ status: 'pending' }]);
    expect(allText(lastReply())).toContain('ไม่พบออเดอร์');
    expect(allText(lastReply())).not.toContain(order.orderNo);
  });

  test('a cash order has nothing to claim: the customer is told, nothing is written', async () => {
    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token, 'cash');
    await deliver(postback(U_A, `action=paid&order=${order.id}`));
    expect(await paymentOf(order.id)).toEqual([]);
    expect(replies()).toHaveLength(1);
  });
});

describe('changing the payment method from the chat', () => {
  test('the picker always offers ไทยช่วยไทย, with no QR and no link', async () => {
    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token);
    await deliver(postback(U_A, `action=change_method&order=${order.id}`));
    const picker = JSON.stringify(lastReply());
    expect(picker).toContain('set_method');
    expect(picker).toContain('gov_copay');
    expect(picker).not.toMatch(/https?:|"image"/i);

    await h.client.query("update gov_copay_schemes set enabled = false where code = 'test'");
    sent.length = 0;
    await deliver(postback(U_A, `action=change_method&order=${order.id}`));
    expect(JSON.stringify(lastReply())).toContain('gov_copay');
    expect(JSON.stringify(lastReply())).not.toMatch(/https?:|"image"/i);
  });

  test('choosing a method updates the POS the same way the app does, and replies with the new instructions', async () => {
    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token);
    const marker = h.events.length;
    await deliver(postback(U_A, `action=set_method&order=${order.id}&method=gov_copay`));
    expect(await paymentOf(order.id)).toMatchObject([
      { method: 'promptpay', status: 'cancelled' },
      { method: 'gov_copay', status: 'pending' },
    ]);
    expect(h.events.slice(marker).filter((e) => e.type === 'payment.upserted')).toHaveLength(2);
    // ไทยช่วยไทย: words only. Staff handle it at the hand-over.
    const card = JSON.stringify(lastReply());
    expect(card).not.toMatch(/https?:|"image"|qr\.png/i);
    expect(allText(lastReply())).toContain('เดี๋ยวจะส่ง QR ให้นะคะ');

    await deliver(postback(U_A, `action=set_method&order=${order.id}&method=cash`));
    expect((await paymentOf(order.id)).filter((p) => p.status === 'pending')).toEqual([]);
    expect(allText(lastReply())).toContain('เงินสด');

    await deliver(postback(U_A, `action=set_method&order=${order.id}&method=promptpay`));
    expect(JSON.stringify(lastReply())).toContain(`${LIFF}/orders/${order.id}`);
  });

  test('after the customer claimed, the method cannot change: staff decide', async () => {
    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token);
    await deliver(postback(U_A, `action=paid&order=${order.id}`));
    await deliver(postback(U_A, `action=set_method&order=${order.id}&method=cash`));
    expect(await paymentOf(order.id)).toMatchObject([{ status: 'claimed' }]);
    expect(allText(lastReply())).toContain('แจ้งโอนแล้ว');
  });

  test('a forged method in a postback is ignored', async () => {
    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token);
    await deliver(postback(U_A, `action=set_method&order=${order.id}&method=platform`));
    expect(sent).toHaveLength(0);
    expect(await paymentOf(order.id)).toMatchObject([{ method: 'promptpay', status: 'pending' }]);
  });
});

describe('keywords and the rich menu', () => {
  test('the menu, how-to-pay, hours and contact all answer with a free reply', async () => {
    await signIn('id-token-a-0000000000000000000000');
    await deliver(text(U_A, 'เมนู'));
    expect(JSON.stringify(lastReply())).toContain(`${LIFF}/menu`);

    await deliver(postback(U_A, 'rm=pay-info'));
    const pay = allText(lastReply());
    expect(pay).toContain('พร้อมเพย์');
    expect(pay).toContain('เงินสด');
    expect(pay).toContain('ไทยช่วยไทย');
    expect(JSON.stringify(lastReply())).not.toMatch(/https?:|"type":"image"|qr\.png/i);

    await deliver(text(U_A, 'เวลาเปิด'));
    expect(allText(lastReply())).toContain('13:00');
    expect(allText(lastReply())).toContain('23:00');

    await deliver(postback(U_A, 'rm=contact'));
    expect(allText(lastReply())).toContain('ร้านได้รับแล้ว');
    expect(replies()).toHaveLength(4);
    expect(pushes()).toHaveLength(0);
  });

  test('the hours reply follows the LINE ordering switch', async () => {
    await signIn('id-token-a-0000000000000000000000');
    const setMode = (mode: string) =>
      h.client.query(
        `insert into settings (key, value, updated_by) values ('line_ordering', $1::jsonb, $2)
         on conflict (key) do update set value = $1::jsonb`,
        [JSON.stringify({ mode }), owner.staffId],
      );
    await setMode('open');
    await deliver(text(U_A, 'เวลาเปิด'));
    expect(allText(lastReply())).toContain('ทุกเวลา');
    await setMode('closed');
    await deliver(text(U_A, 'เวลาเปิด'));
    expect(allText(lastReply())).toContain('ยังไม่เปิดรับออเดอร์');
    await h.client.query("delete from settings where key = 'line_ordering'");
  });

  test('"สถานะ" shows the latest order, or says there is none', async () => {
    await signIn('id-token-b-0000000000000000000000');
    await deliver(text(U_B, 'สถานะ'));
    expect(allText(lastReply())).toContain('ไม่มีออเดอร์');

    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token);
    await deliver(text(U_A, 'สถานะ'));
    const words = allText(lastReply());
    expect(words).toContain(order.orderNo);
    expect(words).toContain('รอร้านรับออเดอร์');
    expect(words).toContain('ยังไม่ชำระ');
  });
});

describe('the contact alert', () => {
  test('the customer is answered every time, but staff are alerted once per customer per 10 minutes', async () => {
    await signIn('id-token-a-0000000000000000000000');
    await signIn('id-token-b-0000000000000000000000');
    const contactAlerts = () => h.alerts.filter((a) => a.kind === 'line.contact_request').length;
    const before = contactAlerts();
    await deliver(postback(U_A, 'rm=contact'));
    await deliver(postback(U_A, 'rm=contact'));
    await deliver(text(U_A, 'ติดต่อ'));
    expect(replies()).toHaveLength(3); // each tap is answered, for free
    expect(contactAlerts() - before).toBe(1);
    // Another customer is a separate budget.
    await deliver(postback(U_B, 'rm=contact'));
    expect(contactAlerts() - before).toBe(2);
    // After ten minutes the same customer can alert again, and not a moment sooner.
    h.clock.advanceSeconds(9 * 60);
    await deliver(postback(U_A, 'rm=contact'));
    expect(contactAlerts() - before).toBe(2);
    h.clock.advanceSeconds(61);
    await deliver(postback(U_A, 'rm=contact'));
    expect(contactAlerts() - before).toBe(3);
    // The alert holds no customer data.
    const alert = h.alerts.find((a) => a.kind === 'line.contact_request');
    expect(JSON.stringify(alert)).not.toContain(U_A);
  });
});

describe('the one push when a LINE order is ready', () => {
  test('goes once, at ready, to the customer, with no receipt, and is counted', async () => {
    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token, 'cash');
    await complete(order.id);
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0]?.to).toBe(U_A);
    const words = allText(pushes()[0]?.messages ?? []);
    expect(words).toContain('อาหารพร้อมแล้ว');
    expect(words).toContain(order.orderNo);
    expect(words).not.toContain('ใบเสร็จ');
    const log = await h.client.query<{ counted: boolean }>(
      "select counted from line_message_log where order_id = $1 and kind = 'push'",
      [order.id],
    );
    expect(log.rows).toEqual([{ counted: true }]);

    // A later change to the same order (staff confirm the cash) does not push again.
    const staff = await staffSession();
    await call('POST', `/v1/orders/${order.id}/payments`, staff, {
      clientRequestId: crypto.randomUUID(),
      method: 'cash',
      tendered: 12000,
    });
    await runtime.idle();
    expect(pushes()).toHaveLength(1);
  });

  test('never for an order that did not come through LINE', async () => {
    const m = await h.newMenu();
    const staff = await staffSession();
    const res = await call('POST', '/v1/orders', staff, {
      clientRequestId: crypto.randomUUID(),
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B1',
      recipientName: 'ลูกค้าหน้าร้าน',
      items: [{ menuItemId: m.water, qty: 1 }],
    });
    expect(res.statusCode).toBe(201);
    await complete(res.json().id);
    expect(sent).toHaveLength(0);
  });

  test('policy off sends nothing, and "สถานะ" answers for free without a receipt', async () => {
    await h.client.query(
      "insert into settings (key, value, updated_by) values ('line_policy', $1::jsonb, $2)",
      [JSON.stringify({ push: 'off' }), owner.staffId],
    );
    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token, 'cash');
    await complete(order.id);
    expect(pushes()).toHaveLength(0);
    await deliver(text(U_A, 'สถานะ'));
    expect(allText(lastReply())).not.toContain('ใบเสร็จ');
    expect(pushes()).toHaveLength(0);
  });

  test('at the monthly limit the push is dropped and the owner is warned once', async () => {
    await h.client.query(
      "insert into settings (key, value, updated_by) values ('line_policy', $1::jsonb, $2)",
      [JSON.stringify({ push: 'essential', monthlyLimit: 1, warnAtPercent: 80 }), owner.staffId],
    );
    await h.client.query(
      "insert into line_quota_months (month, used) values ('2029-01', 1) on conflict (month) do update set used = 1, cap_alerted_at = null, warn_alerted_at = null",
    );
    const token = await signIn('id-token-a-0000000000000000000000');
    const first = await place(token, 'cash');
    const second = await place(token, 'cash');
    const alertsBefore = h.alerts.length;
    await complete(first.id);
    await complete(second.id);
    expect(pushes()).toHaveLength(0);
    expect(h.alerts.slice(alertsBefore).filter((a) => a.kind === 'line.quota_capped')).toHaveLength(
      1,
    );
    const used = await h.client.query<{ used: number }>(
      "select used from line_quota_months where month = '2029-01'",
    );
    expect(used.rows[0]?.used).toBe(1); // never past the limit
  });

  test('a push LINE refuses gives the quota unit back', async () => {
    pushFails = true;
    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token, 'cash');
    await h.client.query(
      'update line_quota_months set used = 0, cap_alerted_at = null, warn_alerted_at = null',
    );
    await complete(order.id);
    expect(
      (
        await h.client.query(
          "select id from line_message_log where order_id = $1 and kind = 'push'",
          [order.id],
        )
      ).rows,
    ).toHaveLength(0);
  });

  test('an erased customer gets nothing', async () => {
    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token, 'cash');
    await h.client.query(
      'update customers set line_user_id = null, anonymized_at = now() where line_user_id = $1',
      [U_A],
    );
    await complete(order.id);
    expect(sent).toHaveLength(0);
  });
});

describe('a picture in the chat', () => {
  const image = (userId: string, messageId = '4001') => ({
    type: 'message',
    ...base(userId),
    message: { type: 'image', id: messageId },
  });
  const slipKey = async (orderId: string) =>
    (
      await h.client.query<{ slip_image_key: string | null }>(
        'select slip_image_key from payments where order_id = $1',
        [orderId],
      )
    ).rows[0]?.slip_image_key;

  test('from a customer with a PromptPay order waiting: kept as the slip, the payment is claimed, one free reply', async () => {
    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token);
    const marker = h.events.length;
    await deliver(image(U_A, '4001'));

    expect(fetched).toEqual(['4001']);
    expect(await paymentOf(order.id)).toMatchObject([{ method: 'promptpay', status: 'claimed' }]);
    const key = await slipKey(order.id);
    expect(key).toBeTruthy();
    expect(await slipStore.get(key as string)).toEqual(JPEG);
    expect(
      h.events
        .slice(marker)
        .some((e) => e.type === 'payment.upserted' && e.data.status === 'claimed'),
    ).toBe(true);
    // Never confirmed by a picture.
    expect(
      (
        await h.client.query(
          "select id from payments where order_id = $1 and status = 'confirmed'",
          [order.id],
        )
      ).rows,
    ).toHaveLength(0);
    expect(replies()).toHaveLength(1);
    expect(pushes()).toHaveLength(0);
    expect(allText(lastReply())).toContain(order.orderNo);
  });

  test('a second picture replaces the first and deletes the old file', async () => {
    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token);
    await deliver(image(U_A, '4002'));
    const first = await slipKey(order.id);
    await deliver(image(U_A, '4003'));
    const second = await slipKey(order.id);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(await slipStore.get(first as string)).toBeNull();
    expect(await slipStore.get(second as string)).toEqual(JPEG);
  });

  test("with no order waiting (none, cash, or another customer's order) nothing is downloaded or kept, and the usual reply is sent", async () => {
    const tokenA = await signIn('id-token-a-0000000000000000000000');
    await signIn('id-token-b-0000000000000000000000');
    const cash = await place(tokenA, 'cash');
    await deliver(image(U_A));
    await deliver(image(U_B));
    expect(fetched).toEqual([]);
    expect(await slipKey(cash.id)).toBeUndefined();
    expect(replies()).toHaveLength(2);
    expect(allText(lastReply())).toContain('โอนแล้ว');
  });

  test('a picture LINE would not hand over leaves the payment as it was; a failure that may pass is retried by the sweep', async () => {
    const token = await signIn('id-token-a-0000000000000000000000');
    const order = await place(token);
    content = { ok: false, definite: true, status: 404 };
    await deliver(image(U_A));
    expect(await paymentOf(order.id)).toMatchObject([{ status: 'pending' }]);
    expect(await slipKey(order.id)).toBeNull();
    expect(replies()).toHaveLength(1);

    content = { ok: false, definite: false };
    const id = 'evt-slip-transient';
    await deliver({ ...image(U_A), webhookEventId: id });
    const row = (
      await h.client.query<{ error: string | null }>(
        'select error from line_events where webhook_event_id = $1',
        [id],
      )
    ).rows[0];
    expect(row?.error).toBeTruthy();
    expect(await slipKey(order.id)).toBeNull();
  });
});
