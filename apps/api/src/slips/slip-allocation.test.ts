/**
 * Slice 4 and 5 (D-40, D-41): a chat slip with several open PromptPay orders is allocated by the
 * amount read locally (PAY-05), one transfer can never confirm two orders (PAY-06), the customer
 * app asks to combine, unpaid pay-first orders are cancelled after the timeout and a late slip is
 * kept for staff. Real app on in-memory Postgres; LINE, OCR, QR and Slip2Go are fakes with made-up
 * data. A picture carries its transfer amount and a nonce in its bytes, which the fakes read: OCR
 * can be made to fail (`ocrBlind`) while the "bank" still knows the true amount.
 */
import { createHmac } from 'node:crypto';
import type { LineClient } from '@sds/line';
import { slipNeedsCombineSchema } from '@sds/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { cancelUnpaidOrders } from '../jobs/unpaid-timeout.ts';
import { LiffUnavailableError, type LiffVerifier } from '../line/liff-verify.ts';
import { createLineRuntime, type LineRuntime } from '../line/runtime.ts';
import { createHarness, type Harness, type Menu } from '../test-support/harness.ts';
import { createSlipChecker, installSlipChecker, type SlipChecker } from './checker.ts';
import type { SlipOcr } from './ocr.ts';
import { installSlipScreen, type SlipQrReader } from './qr.ts';
import { createSlip2goVerifier } from './slip2go.ts';
import { createMemorySlipStore, type SlipStore } from './store.ts';

const SECRET = 'test-channel-secret-not-real';
const LIFF_ID = '1234567890-abcdefgh';

let h: Harness;
let menu: Menu;
let store: SlipStore;
let runtime: LineRuntime;
let staffToken: string;
let owner: Awaited<ReturnType<Harness['newOwner']>>;
let checker: SlipChecker | null = null;
let ocrBlind = false;
let ocrOn = true;
let slip2goCalls = 0;
const sent: { kind: 'reply' | 'push'; text: string }[] = [];
/** What LINE hands back for a picture message id. */
const pictures = new Map<string, Buffer>();

let nonceNo = 0;
let people = 0;

/**
 * A PNG header with a plausible phone size and, after it, the transfer: its amount in baht and a
 * nonce that makes it one transfer (the same nonce twice is the same transfer).
 */
function picture(baht: number, nonce = `n${++nonceNo}`): Buffer {
  const b = Buffer.alloc(120, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(1170, 16);
  b.writeUInt32BE(2532, 20);
  b.write(`AMT=${baht};NONCE=${nonce};`, 30, 'latin1');
  return b;
}
const meaning = (bytes: Buffer) => {
  const m = /AMT=(\d+);NONCE=(\w+);/.exec(bytes.toString('latin1', 30, 100));
  return { baht: Number(m?.[1]), nonce: m?.[2] ?? '' };
};

const fakeClient: LineClient = {
  async getMessageContent(messageId) {
    const bytes = pictures.get(messageId);
    return bytes ? { ok: true, bytes } : { ok: false, definite: true, status: 404 };
  },
  async reply(_token, messages) {
    sent.push({ kind: 'reply', text: JSON.stringify(messages) });
    return { ok: true };
  },
  async push(_to, messages) {
    sent.push({ kind: 'push', text: JSON.stringify(messages) });
    return { ok: true };
  },
};
const liff: LiffVerifier = {
  async verify(credential) {
    const token = 'idToken' in credential ? credential.idToken : credential.accessToken;
    if (token === 'down') throw new LiffUnavailableError();
    return token.startsWith('idt-') ? { userId: `Ualloc${token.slice(4, 8)}` } : null;
  },
};

const ocr: SlipOcr = {
  read: async (bytes) => {
    if (ocrBlind) throw new Error('OCR_FAILED');
    return `จำนวน ${meaning(bytes).baht}.00 บาท`;
  },
};
const qr: SlipQrReader = {
  read: async (bytes) => ({ sendingBank: '014', transRef: `LOCAL${meaning(bytes).nonce}` }),
  readRaw: async (bytes) => ({
    qr: { sendingBank: '014', transRef: `LOCAL${meaning(bytes).nonce}` },
    raw: `RAWQR|${meaning(bytes).baht}|${meaning(bytes).nonce}`,
  }),
};
/** The "bank": the transfer's real amount and reference come from the picture, whatever OCR saw. */
const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  slip2goCalls += 1;
  const raw = /RAWQR\|(\d+)\|(\w+)/.exec(String(init?.body ?? ''));
  const baht = Number(raw?.[1]);
  const nonce = raw?.[2] ?? 'none';
  return new Response(
    JSON.stringify({
      code: '200200',
      message: 'synthetic',
      data: {
        referenceId: `REF-${nonce}`,
        transRef: nonce.padStart(25, '0'),
        amount: baht,
        dateTime: '2028-02-01T15:00:00+07:00',
        sender: { bank: { id: '002' }, account: { name: 'PRIVATE SENDER NAME' } },
      },
    }),
    { status: 200 },
  );
}) as typeof fetch;

function buildChecker(): SlipChecker {
  return createSlipChecker({
    ctx: { db: h.db, now: h.clock.now, events: h.bus },
    slips: store,
    ...(ocrOn ? { ocr } : {}),
    qr,
    verifier: createSlip2goVerifier(
      {
        baseUrl: 'https://slip2go.example.test',
        secretKey: 'TEST-ONLY-KEY',
        timeoutMs: 1000,
        log: { info: () => undefined, warn: () => undefined },
      },
      fakeFetch,
    ),
    autoConfirm: { maxSatang: 100_000 },
    notFoundGraceSeconds: 0,
    graceRetryDelaysMs: [],
  });
}

beforeAll(async () => {
  store = createMemorySlipStore();
  runtime = createLineRuntime(
    { channelSecret: SECRET, channelAccessToken: undefined, liffId: LIFF_ID },
    { client: fakeClient, liffVerifier: liff },
  );
  h = await createHarness({ line: runtime, slips: store });
  menu = await h.newMenu();
  owner = await h.newOwner();
  h.clock.set('2028-02-01T08:00:00.000Z');
  staffToken = await h.ownerSession(owner);
  await h.client.query(
    "insert into settings (key, value, updated_by) values ('promptpay', $1::jsonb, $2)",
    [JSON.stringify({ idType: 'phone', idValue: '0899994321' }), owner.staffId],
  );
}, 60_000);
afterAll(async () => {
  installSlipChecker(null);
  await h.close();
});
beforeEach(async () => {
  h.clock.set('2028-02-01T08:00:00.000Z');
  sent.length = 0;
  slip2goCalls = 0;
  ocrBlind = false;
  ocrOn = true;
  people += 1;
  await h.client.query("delete from settings where key = 'unpaid_timeout'");
  checker = buildChecker();
  installSlipChecker(checker);
});
afterEach(() => {
  installSlipChecker(null);
});

// ---------- helpers ----------

const userId = () => `Ualloc${String(people).padStart(4, '0')}`;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: unknown) =>
  h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });

async function customer(): Promise<string> {
  const res = await call('POST', '/v1/app/session', undefined, {
    idToken: `idt-${String(people).padStart(4, '0')}-padpadpadpadpadpadpadpad`,
  });
  const token = res.json().token as string;
  await call('POST', '/v1/app/privacy-ack', token);
  return token;
}

type Placed = { id: string; orderNo: string; totalSatang: number };
/** 10 baht = one water; 50 baht = one noodle (thin); `cash` pays face to face. */
async function place(
  token: string,
  baht: 10 | 50,
  method: 'promptpay' | 'cash' = 'promptpay',
): Promise<Placed> {
  const items =
    baht === 10
      ? [{ menuItemId: menu.water, qty: 1 }]
      : [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin] }];
  const res = await call('POST', '/v1/app/orders', token, {
    clientRequestId: crypto.randomUUID(),
    items,
    deliveryBuilding: 'B1',
    recipientName: 'ฟ้าทดสอบ',
    paymentMethod: method,
  });
  expect(res.statusCode).toBe(201);
  return res.json().order as Placed;
}

let eventNo = 0;
async function chatSlip(bytes: Buffer): Promise<void> {
  const id = `m${++eventNo}-${people}`;
  pictures.set(id, bytes);
  const raw = JSON.stringify({
    destination: 'Utest',
    events: [
      {
        type: 'message',
        webhookEventId: `evt-alloc-${id}`,
        replyToken: `rt-${id}`,
        source: { type: 'user', userId: userId() },
        timestamp: 1,
        mode: 'active',
        deliveryContext: { isRedelivery: false },
        message: { type: 'image', id },
      },
    ],
  });
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/line/webhook',
    headers: {
      'content-type': 'application/json',
      'x-line-signature': createHmac('sha256', SECRET).update(raw).digest('base64'),
    },
    payload: raw,
    remoteAddress: h.nextIp(),
  });
  expect(res.statusCode).toBe(200);
  await runtime.idle();
  await checker?.idle();
}

const upload = (token: string, orderId: string, bytes: Buffer, query = '') =>
  h.app.inject({
    method: 'POST',
    url: `/v1/app/orders/${orderId}/slip${query}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
    payload: bytes,
    remoteAddress: h.nextIp(),
  });

interface Pay {
  id: string;
  status: string;
  amount_satang: number;
  slip_image_key: string | null;
  slip_autoconfirm_blocked: boolean;
  auto_confirmed: boolean;
}
const pays = async (orderId: string) =>
  (
    await h.client.query<Pay>(
      `select id, status, amount_satang, slip_image_key, slip_autoconfirm_blocked, auto_confirmed
         from payments where order_id = $1 order by rev`,
      [orderId],
    )
  ).rows;
const orderRow = async (orderId: string) =>
  (
    await h.client.query<{
      status: string;
      cancel_reason: string | null;
      total_satang: string;
      payment_status: string;
    }>('select status, cancel_reason, total_satang, payment_status from orders where id = $1', [
      orderId,
    ])
  ).rows[0];
const live = async (orderId: string) => (await pays(orderId)).find((p) => p.status !== 'cancelled');
const reviewAlerts = () =>
  h.events.filter((e) => e.type === 'alert.payment' && e.kind === 'slip_review');

// ---------- Slice 5: chat allocation ----------

describe('a chat slip with several open PromptPay orders (PAY-05)', () => {
  test('two orders of the same amount and one slip: the OLDEST gets it and is confirmed, the other stays unpaid', async () => {
    const token = await customer();
    const first = await place(token, 50);
    const second = await place(token, 50);
    await chatSlip(picture(50));
    expect(await live(first.id)).toMatchObject({ status: 'confirmed', auto_confirmed: true });
    expect(await live(second.id)).toMatchObject({ status: 'pending', slip_image_key: null });
    expect(slip2goCalls).toBe(1);
    expect(sent.filter((s) => s.kind === 'push')).toHaveLength(0);
  });

  test('10 and 50, the 50 slip first: each slip confirms its own order, whichever is older', async () => {
    const token = await customer();
    const big = await place(token, 50); // older
    const small = await place(token, 10); // newer: the old "newest order" rule would take it
    await chatSlip(picture(50));
    expect(await live(big.id)).toMatchObject({ status: 'confirmed' });
    expect(await live(small.id)).toMatchObject({ status: 'pending' });
    await chatSlip(picture(10));
    expect(await live(small.id)).toMatchObject({ status: 'confirmed' });
    expect(await live(big.id)).toMatchObject({ status: 'confirmed' });
    expect(slip2goCalls).toBe(2);
  });

  test('one slip for the sum of 10 + 50 merges them into the oldest and confirms once, with one bank call', async () => {
    const token = await customer();
    const first = await place(token, 10);
    const second = await place(token, 50);
    await chatSlip(picture(60));
    expect(await orderRow(second.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: `merged:${first.orderNo}`,
    });
    expect(await orderRow(first.id)).toMatchObject({
      status: 'preparing',
      total_satang: 6000,
      payment_status: 'paid',
    });
    const mine = await pays(first.id);
    expect(mine.filter((p) => p.status === 'confirmed')).toHaveLength(1);
    expect(mine.find((p) => p.status === 'confirmed')?.amount_satang).toBe(6000);
    expect(slip2goCalls).toBe(1);
  });

  test('two 50 orders and one 100 slip: merged, confirmed once', async () => {
    const token = await customer();
    const first = await place(token, 50);
    const second = await place(token, 50);
    await chatSlip(picture(100));
    expect(await orderRow(second.id)).toMatchObject({ status: 'cancelled' });
    expect(await live(first.id)).toMatchObject({ status: 'confirmed', amount_satang: 10000 });
    expect(slip2goCalls).toBe(1);
  });

  test('an unreadable amount goes to review on the oldest: blocked, never confirmed, staff are told, staff can confirm', async () => {
    ocrBlind = true;
    const token = await customer();
    const first = await place(token, 50);
    const second = await place(token, 50);
    const marker = h.events.length;
    await chatSlip(picture(50));
    // The "bank" says the transfer is valid and exactly this payment's amount: still not confirmed.
    expect(slip2goCalls).toBe(1);
    expect(await live(first.id)).toMatchObject({
      status: 'claimed',
      slip_autoconfirm_blocked: true,
      auto_confirmed: false,
    });
    expect(await live(second.id)).toMatchObject({ status: 'pending' });
    expect(
      h.events.slice(marker).filter((e) => e.type === 'alert.payment' && e.kind === 'slip_review'),
    ).toHaveLength(1);
    const confirm = await call(
      'POST',
      `/v1/payments/${(await live(first.id))?.id}/confirm`,
      staffToken,
      {
        attestedBankCheck: true,
      },
    );
    expect(confirm.statusCode).toBe(200);
  });

  test('with no local reader at all (OCR off, as in production) two orders mean review', async () => {
    ocrOn = false;
    installSlipChecker(buildChecker());
    const token = await customer();
    const first = await place(token, 10);
    await place(token, 50);
    await chatSlip(picture(10));
    expect(await live(first.id)).toMatchObject({
      status: 'claimed',
      slip_autoconfirm_blocked: true,
    });
  });

  test('a wrong amount (matches no order and no sum) is review, never a confirm', async () => {
    const token = await customer();
    const first = await place(token, 10);
    await place(token, 50);
    await chatSlip(picture(40));
    expect(await live(first.id)).toMatchObject({
      status: 'claimed',
      slip_autoconfirm_blocked: true,
    });
  });

  test('one open order: as before, no reading needed and no merge', async () => {
    ocrBlind = true;
    const token = await customer();
    const only = await place(token, 50);
    await chatSlip(picture(50));
    expect(await live(only.id)).toMatchObject({
      status: 'confirmed',
      slip_autoconfirm_blocked: false,
    });
  });

  test('a second slip does not overwrite the first order’s slip while that one is being checked', async () => {
    const token = await customer();
    const first = await place(token, 50);
    const second = await place(token, 50);
    // The first is claimed with a slip that stays unconfirmed (blocked), then another 50 slip comes.
    ocrBlind = true;
    await chatSlip(picture(50));
    const before = (await live(first.id))?.slip_image_key;
    expect(before).toBeTruthy();
    ocrBlind = false;
    await chatSlip(picture(50));
    expect((await live(first.id))?.slip_image_key).toBe(before);
    expect(await live(second.id)).toMatchObject({ status: 'confirmed' });
  });
});

describe('one transfer can never confirm two orders (PAY-06)', () => {
  test('the same transfer sent for a second order is refused by the machine and by staff confirm', async () => {
    const token = await customer();
    const first = await place(token, 50);
    const second = await place(token, 50);
    const sameTransfer = 'sametransfer';
    await chatSlip(picture(50, sameTransfer));
    expect(await live(first.id)).toMatchObject({ status: 'confirmed' });
    await chatSlip(picture(50, sameTransfer));
    const waiting = await live(second.id);
    expect(waiting).toMatchObject({ status: 'claimed', auto_confirmed: false });
    // Staff cannot confirm it either: the unique index on a confirmed transfer says no.
    const confirm = await call('POST', `/v1/payments/${waiting?.id}/confirm`, staffToken, {
      attestedBankCheck: true,
    });
    expect(confirm.statusCode).toBe(409);
    expect(confirm.json().code).toBe('SLIP_ALREADY_CONFIRMED');
    expect((await live(second.id))?.status).toBe('claimed');
  });
});

// ---------- Slice 5: the customer app ----------

describe('the customer app slip upload (combine?)', () => {
  test('a slip for the sum answers 409 NEEDS_COMBINE and stores nothing; combine=1 merges into THIS order and attaches', async () => {
    const token = await customer();
    const small = await place(token, 10);
    const big = await place(token, 50);
    const bytes = picture(60);
    const res = await upload(token, big.id, bytes);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NEEDS_COMBINE');
    const details = slipNeedsCombineSchema.parse(res.json().details);
    expect(details).toMatchObject({ orderNos: [big.orderNo, small.orderNo], totalSatang: 6000 });
    expect(details.orderIds).toEqual([big.id, small.id]);
    expect(await pays(big.id)).toMatchObject([{ slip_image_key: null, status: 'pending' }]);
    expect(await pays(small.id)).toMatchObject([{ slip_image_key: null, status: 'pending' }]);
    expect(slip2goCalls).toBe(0);

    const combined = await upload(token, big.id, bytes, '?combine=1');
    expect(combined.statusCode).toBe(200);
    await checker?.idle();
    expect(await orderRow(small.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: `merged:${big.orderNo}`,
    });
    expect(await live(big.id)).toMatchObject({ status: 'confirmed', amount_satang: 6000 });
    expect(slip2goCalls).toBe(1);
  });

  test('review=1 attaches the slip with auto-confirm blocked, and never confirms it', async () => {
    const token = await customer();
    await place(token, 10);
    const big = await place(token, 50);
    const res = await upload(token, big.id, picture(60), '?review=1');
    expect(res.statusCode).toBe(200);
    await checker?.idle();
    expect(await live(big.id)).toMatchObject({ status: 'claimed', slip_autoconfirm_blocked: true });
    expect(await orderRow(big.id)).toMatchObject({ total_satang: 5000 });
  });

  test('combine and review together are refused; combine with nothing to combine is a plain 409', async () => {
    const token = await customer();
    const only = await place(token, 50);
    expect((await upload(token, only.id, picture(50), '?combine=1&review=1')).statusCode).toBe(400);
    const none = await upload(token, only.id, picture(50), '?combine=1');
    expect(none.statusCode).toBe(409);
    expect(none.json().code).toBe('COMBINE_NOT_APPLICABLE');
  });

  test('an exact amount for this order is attached at once, even with other open orders', async () => {
    const token = await customer();
    await place(token, 10);
    const big = await place(token, 50);
    const res = await upload(token, big.id, picture(50));
    expect(res.statusCode).toBe(200);
    await checker?.idle();
    expect(await live(big.id)).toMatchObject({ status: 'confirmed' });
  });
});

// ---------- Slice 4: unpaid timeout ----------

describe('the unpaid timeout job (D-41)', () => {
  const deps = () => ({
    db: h.db,
    events: h.bus,
    now: h.clock.now,
    line: runtime,
    slips: store,
  });
  const at = (minutes: number) => {
    h.clock.set(new Date(Date.parse('2028-02-01T08:00:00.000Z') + minutes * 60_000).toISOString());
  };

  test('cancels at 61 minutes, not at 59, with reason unpaid_timeout, its payment cancelled and no LINE message', async () => {
    const token = await customer();
    const order = await place(token, 50);
    at(59);
    expect(await cancelUnpaidOrders(deps())).toMatchObject({ cancelled: 0 });
    expect((await orderRow(order.id))?.status).toBe('new');
    at(61);
    expect((await cancelUnpaidOrders(deps())).cancelled).toBeGreaterThanOrEqual(1);
    expect(await orderRow(order.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'unpaid_timeout',
    });
    expect(await pays(order.id)).toMatchObject([{ status: 'cancelled' }]);
    expect(sent).toHaveLength(0);
    // Run twice: nothing more happens.
    expect(await cancelUnpaidOrders(deps())).toMatchObject({ cancelled: 0 });
  });

  test('a claimed payment, a slip, a cash order and another channel are left alone', async () => {
    const token = await customer();
    const claimed = await place(token, 50);
    const withSlip = await place(token, 10);
    const cash = await place(token, 50, 'cash');
    const other = await place(token, 50);
    expect((await call('POST', `/v1/app/orders/${claimed.id}/claim`, token)).statusCode).toBe(200);
    ocrBlind = true;
    expect((await upload(token, withSlip.id, picture(10))).statusCode).toBe(200);
    await h.client.query("update orders set channel = 'storefront' where id = $1", [other.id]);
    at(120);
    await cancelUnpaidOrders(deps());
    for (const o of [claimed, withSlip, cash, other]) {
      expect((await orderRow(o.id))?.status, o.orderNo).not.toBe('cancelled');
    }
  });

  test('the setting turns it off, and its endpoint needs a session', async () => {
    const token = await customer();
    const order = await place(token, 50);
    const patch = await call('PATCH', '/v1/settings/unpaid-timeout', staffToken, {
      expectedVersion: 0,
      enabled: false,
      minutes: 60,
    });
    expect(patch.statusCode).toBe(200);
    expect((await call('GET', '/v1/settings/unpaid-timeout', staffToken)).json()).toMatchObject({
      value: { enabled: false, minutes: 60 },
    });
    at(500);
    expect(await cancelUnpaidOrders(deps())).toMatchObject({ cancelled: 0 });
    expect((await orderRow(order.id))?.status).toBe('new');
    expect((await call('GET', '/v1/settings/unpaid-timeout')).statusCode).toBe(401);
  });

  test('a late slip in the chat is kept for staff on the cancelled payment: no reopen, no bank call, never confirmed', async () => {
    const token = await customer();
    const order = await place(token, 50);
    at(61);
    await cancelUnpaidOrders(deps());
    const marker = h.events.length;
    const file = picture(50);
    await chatSlip(file);
    const cancelledPayment = (await pays(order.id))[0];
    expect(cancelledPayment).toMatchObject({
      status: 'cancelled',
      slip_autoconfirm_blocked: true,
      auto_confirmed: false,
    });
    expect(cancelledPayment?.slip_image_key).toBeTruthy();
    expect(await orderRow(order.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'unpaid_timeout',
    });
    expect(slip2goCalls).toBe(0);
    expect(
      h.events.slice(marker).filter((e) => e.type === 'alert.payment' && e.kind === 'slip_review'),
    ).toHaveLength(1);
    expect(sent.filter((s) => s.kind === 'reply')).toHaveLength(1);
    expect(sent.filter((s) => s.kind === 'push')).toHaveLength(0);
    // The same picture again changes nothing (chat events are retried).
    await chatSlip(file);
    expect(reviewAlerts().length).toBeGreaterThanOrEqual(1);
    // Staff can look at it through the usual slip view.
    const fresh = await h.ownerSession(owner); // the clock moved: the old session expired
    const view = await call('GET', `/v1/payments/${cancelledPayment?.id}/slip`, fresh);
    expect(view.statusCode).toBe(200);
  });

  test('a late slip from the customer app is kept the same way', async () => {
    const token = await customer();
    const order = await place(token, 50);
    at(61);
    await cancelUnpaidOrders(deps());
    const res = await upload(await customer(), order.id, picture(50));
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');
    expect((await pays(order.id))[0]).toMatchObject({
      status: 'cancelled',
      slip_autoconfirm_blocked: true,
    });
    expect(slip2goCalls).toBe(0);
  });

  test('after the 24 hour window the late slip is not kept and gets no reply (nothing waits, D-44)', async () => {
    const token = await customer();
    const order = await place(token, 50);
    at(61);
    await cancelUnpaidOrders(deps());
    at(61 + 25 * 60);
    const marker = sent.length;
    await chatSlip(picture(50));
    expect((await pays(order.id))[0]?.slip_image_key).toBeNull();
    expect(sent.slice(marker)).toHaveLength(0);
  });

  test('inside the window a chat picture with no bank-slip QR is still dropped in silence (D-44)', async () => {
    const token = await customer();
    const order = await place(token, 50);
    at(61);
    await cancelUnpaidOrders(deps());
    const marker = sent.length;
    installSlipScreen({ read: async () => null });
    try {
      await chatSlip(picture(50));
    } finally {
      installSlipScreen(null);
    }
    expect((await pays(order.id))[0]).toMatchObject({ status: 'cancelled', slip_image_key: null });
    expect(sent.slice(marker)).toHaveLength(0);
  });
});
