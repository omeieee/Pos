/**
 * The bank check of a slip by Slip2Go (D-27) on the real app and an in-memory Postgres, with a FAKE
 * fetch and synthetic answers: the real service is never called. OCR is OFF in all but one test, as
 * on the shop's server. The verdict is a hint for staff: with auto-confirm off the checker never
 * changes a payment's status (rule 2), and the customer never sees any of it.
 */
import { createHash } from 'node:crypto';
import type { MyOrder } from '@sds/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { LiffUnavailableError, type LiffVerifier } from '../line/liff-verify.ts';
import { createLineRuntime } from '../line/runtime.ts';
import { createHarness, type Harness, type Menu } from '../test-support/harness.ts';
import { createSlipChecker, installSlipChecker, type SlipChecker } from './checker.ts';
import type { SlipOcr } from './ocr.ts';
import type { SlipQrReader } from './qr.ts';
import type { SlipQrText } from './qr-decode.ts';
import { createSlip2goVerifier } from './slip2go.ts';
import { createMemorySlipStore, type SlipStore } from './store.ts';

const KEY = 'TEST-ONLY-KEY-MARKER-77c1';
const RAW_QR = '00410006000001010300000000000SYNTHETIC-QR-TEXT-NOT-A-REAL-SLIP';
/** Every test gets its own transfer, so one test's slips are never duplicates of another's. */
let testNo = 0;
const localRef = () => `LOCALREF${String(testNo).padStart(7, '0')}`;
const remoteRef = () => String(testNo).padStart(25, '0');
const localQrFor = (): SlipQrText => ({
  qr: { sendingBank: '014', transRef: localRef() },
  raw: RAW_QR,
});
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

let tokenNo = 0;
const newToken = () => `id-token-${++tokenNo}-2222222222222222222222`;

/** A PNG header with a plausible phone size: every reader here is fake. */
const picture = (fill = 1, width = 1170, height = 2532) => {
  const b = Buffer.alloc(64, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  // The test's number, so that no two tests send the same file (the same hash is a duplicate).
  b.writeUInt32BE(testNo, 40);
  return b;
};
/** A WebP file: allowed as an upload, never sent to Slip2Go. */
const webp = (fill = 5) => {
  const b = Buffer.alloc(64, fill);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  return b;
};

const liff: LiffVerifier = {
  async verify(credential) {
    const token = 'idToken' in credential ? credential.idToken : credential.accessToken;
    if (token === 'down') throw new LiffUnavailableError();
    return token.startsWith('id-token-') ? { userId: `Uverify${token.slice(9)}` } : null;
  },
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string | FormData | undefined;
}
type Reply =
  | { status?: number; body: unknown }
  | Error
  | Promise<{ status?: number; body: unknown }>;

let h: Harness;
let menu: Menu;
let store: SlipStore;
let staffToken: string;
let ownerId: string;
let checker: SlipChecker;
let calls: Call[] = [];
let logLines: Record<string, unknown>[] = [];
/** What the fake service answers next; the default is an answer built from the payment. */
let respond: (call: Call, n: number) => Reply = () => ({ body: answer('200200', 0) });
let localQr: SlipQrText | null = null;
let dailyCap = 100;
let autoConfirm: { maxSatang: number } | null = null;
let ownerFixture: Awaited<ReturnType<Harness['newOwner']>>;
let ocrOn = false;
let ocrText = '';

/** The service's answer: `baht` is data.amount (a JSON number). */
const answer = (code: string, baht: number, data: Record<string, unknown> = {}) => ({
  code,
  message: 'synthetic',
  data: {
    referenceId: `REF-${code}`,
    transRef: remoteRef(),
    amount: baht,
    dateTime: '2028-02-01T15:00:00+07:00',
    sender: { bank: { id: '002' }, account: { name: 'PRIVATE SENDER NAME' } },
    ...data,
  },
});
const baht = (satang: number) => Number((satang / 100).toFixed(2));

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const call: Call = {
    url: String(input),
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    body: init?.body as string | FormData | undefined,
  };
  calls.push(call);
  const reply = await respond(call, calls.length);
  if (reply instanceof Error) throw reply;
  return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
}) as typeof fetch;

const qrReader: SlipQrReader = {
  read: async () => localQr?.qr ?? null,
  readRaw: async () => localQr,
};
const ocr: SlipOcr = { read: async () => ocrText };

function buildChecker(): SlipChecker {
  return createSlipChecker({
    ctx: { db: h.db, now: h.clock.now, events: h.bus },
    slips: store,
    ...(ocrOn ? { ocr } : {}),
    qr: qrReader,
    verifier: createSlip2goVerifier(
      {
        baseUrl: 'https://slip2go.example.test',
        secretKey: KEY,
        timeoutMs: 1000,
        log: { info: (o) => logLines.push(o), warn: (o) => logLines.push(o) },
      },
      fakeFetch,
    ),
    dailyCap,
    autoConfirm,
    log: { warn: (o) => logLines.push(o) },
  });
}

beforeAll(async () => {
  store = createMemorySlipStore();
  const runtime = createLineRuntime(
    {
      channelSecret: 'unused-test-secret',
      channelAccessToken: undefined,
      liffId: '1234567890-abcdefgh',
    },
    { liffVerifier: liff, client: null },
  );
  h = await createHarness({ line: runtime, slips: store });
  menu = await h.newMenu();
  const owner = await h.newOwner();
  ownerId = owner.staffId;
  ownerFixture = owner;
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
  // A test that left a slip waiting must not hand its payment to the next test's sweep.
  await h.client.query(
    "update payments set slip_verify = 'unchecked' where slip_verify = 'pending'",
  );
  h.clock.set('2028-02-01T08:00:00.000Z');
  calls = [];
  logLines = [];
  testNo += 1;
  localQr = localQrFor();
  dailyCap = 100;
  autoConfirm = null;
  ocrOn = false;
  ocrText = '';
  respond = (_call, _n) => {
    // The default answer matches the payment being checked.
    return { body: answer('200200', currentAmountBaht) };
  };
  checker = buildChecker();
  installSlipChecker(checker);
});
afterEach(() => {
  installSlipChecker(null);
});

/** The amount of the payment under test, in baht; set by `start`. */
let currentAmountBaht = 0;

const call = (method: 'GET' | 'POST', url: string, token: string | undefined) =>
  h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    remoteAddress: h.nextIp(),
  });

async function customer(): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/app/session',
    payload: { idToken: newToken() },
    remoteAddress: h.nextIp(),
  });
  const token = res.json().token as string;
  await call('POST', '/v1/app/privacy-ack', token);
  return token;
}

async function place(token: string) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/app/orders',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      clientRequestId: crypto.randomUUID(),
      items: [{ menuItemId: menu.water, qty: 1 }],
      deliveryBuilding: 'B1',
      recipientName: 'ฟ้าทดสอบ',
      paymentMethod: 'promptpay',
    },
    remoteAddress: h.nextIp(),
  });
  expect(res.statusCode).toBe(201);
  return res.json().order as MyOrder;
}

const upload = (token: string, orderId: string, bytes: Buffer, type = 'image/png') =>
  h.app.inject({
    method: 'POST',
    url: `/v1/app/orders/${orderId}/slip`,
    headers: { authorization: `Bearer ${token}`, 'content-type': type },
    payload: bytes,
    remoteAddress: h.nextIp(),
  });

interface PaymentRow {
  id: string;
  status: string;
  amount_satang: string;
  slip_check: string | null;
  slip_qr_hash: string | null;
  slip_verify: string | null;
  slip_verify_code: string | null;
  slip_verify_ref: string | null;
  slip_verify_attempts: number;
  slip_verified_at: string | null;
  slip_image_key: string | null;
  rev: string;
}
const row = async (orderId: string) =>
  (
    await h.client.query<PaymentRow>(
      `select id, status, amount_satang, slip_check, slip_qr_hash, slip_verify, slip_verify_code,
              slip_verify_ref, slip_verify_attempts, slip_verified_at, slip_image_key, rev
         from payments where order_id = $1`,
      [orderId],
    )
  ).rows[0];

/** A customer with a placed order; the default answer uses the payment's amount. */
async function start() {
  const token = await customer();
  const order = await place(token);
  currentAmountBaht = baht(order.totalSatang);
  return { token, order };
}

const urls = () => calls.map((c) => new URL(c.url).pathname);
const alertsOf = (kind: string) => h.alerts.filter((a) => a.kind === kind);
const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(condition()).toBe(true);
};

describe('the verdict lands in the background', () => {
  test('the upload answers at once, marked pending; then the verdict is stored and the status is untouched', async () => {
    let release: (reply: { body: unknown }) => void = () => undefined;
    const { token, order } = await start();
    respond = () => new Promise((resolve) => (release = resolve));
    const marker = h.events.length;

    const res = await upload(token, order.id, picture());
    expect(res.statusCode).toBe(200);
    const before = await row(order.id);
    expect(before).toMatchObject({
      status: 'claimed',
      slip_verify: 'pending',
      slip_check: null,
      slip_verify_attempts: 0,
    });

    await waitFor(() => calls.length === 1);
    release({ body: answer('200200', currentAmountBaht) });
    await checker.idle();

    const after = await row(order.id);
    expect(after).toMatchObject({
      status: 'claimed',
      slip_verify: 'valid',
      slip_verify_code: '200200',
      slip_verify_ref: 'REF-200200',
      slip_verify_attempts: 1,
      slip_check: null,
    });
    expect(after?.slip_verified_at).not.toBeNull();
    expect(Number(after?.rev)).toBeGreaterThan(Number(before?.rev));
    const upserts = h.events
      .slice(marker)
      .filter((e) => e.type === 'payment.upserted' && e.id === after?.id);
    expect(upserts.length).toBeGreaterThanOrEqual(2);
  });

  const codes: [code: string, verdict: string][] = [
    ['200200', 'valid'],
    ['200000', 'unchecked'],
    ['200401', 'receiver_mismatch'],
    ['200402', 'amount_mismatch'],
    ['200403', 'date_mismatch'],
    ['200404', 'not_found'],
    ['200500', 'fraud'],
    ['200501', 'unchecked'],
    ['400400', 'unchecked'],
    ['401001', 'unchecked'],
  ];
  test.each(codes)(
    'code %s becomes the verdict %s, and the payment stays claimed',
    async (code, verdict) => {
      const { token, order } = await start();
      respond = () => ({ body: answer(code, currentAmountBaht) });
      await upload(token, order.id, picture());
      await checker.idle();
      const after = await row(order.id);
      expect(after).toMatchObject({
        slip_verify: verdict,
        slip_verify_code: code,
        status: 'claimed',
      });
    },
  );

  test('the local amount re-check overrides a valid', async () => {
    const { token, order } = await start();
    respond = () => ({ body: answer('200200', currentAmountBaht + 1) });
    await upload(token, order.id, picture());
    await checker.idle();
    expect(await row(order.id)).toMatchObject({
      slip_verify: 'amount_mismatch',
      status: 'claimed',
    });

    const other = await start();
    respond = () => ({ body: { code: '200200', message: 'no amount', data: {} } });
    await upload(other.token, other.order.id, picture(2));
    await checker.idle();
    expect((await row(other.order.id))?.slip_verify).toBe('amount_mismatch');
  });
});

describe('what is sent', () => {
  test('the QR text first, with this payment amount, the shop receiver and the date from the order', async () => {
    await h.client.query(
      "insert into settings (key, value, updated_by) values ('bank_account', $1::jsonb, $2) on conflict (key) do update set value = excluded.value",
      [JSON.stringify({ bankCode: '004', accountNumber: '1234567890' }), ownerId],
    );
    try {
      const { token, order } = await start();
      await upload(token, order.id, picture());
      await checker.idle();
      expect(urls()).toEqual(['/api/verify-slip/qr-code/info']);
      const sent = calls[0];
      expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`);
      const body = JSON.parse(String(sent?.body));
      expect(body.payload.qrCode).toBe(RAW_QR);
      const payment = await row(order.id);
      const cents = Number(payment?.amount_satang);
      expect(body.payload.checkCondition.checkAmount).toEqual({
        type: 'eq',
        amount: `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`,
      });
      expect(body.payload.checkCondition.checkReceiver).toEqual([
        { accountType: '02001', accountNumber: '0899994321' },
        { accountType: '01004', accountNumber: '1234567890' },
      ]);
      const placed = (
        await h.client.query<{ placed_at: string }>('select placed_at from orders where id = $1', [
          order.id,
        ])
      ).rows[0];
      expect(body.payload.checkCondition.checkDate).toEqual({
        type: 'gte',
        date: new Date(new Date(String(placed?.placed_at)).getTime() - 10 * 60_000).toISOString(),
      });
    } finally {
      await h.client.query("delete from settings where key = 'bank_account'");
    }
  });

  test('a picture with no readable QR is sent as an image when it is a PNG or JPEG', async () => {
    localQr = null;
    const { token, order } = await start();
    await upload(token, order.id, picture());
    await checker.idle();
    expect(urls()).toEqual(['/api/verify-slip/qr-image/info']);
    const form = calls[0]?.body as FormData;
    expect(form.get('file')).toBeInstanceOf(Blob);
    // The conditions are at the root of the payload on this endpoint.
    expect(JSON.parse(String(form.get('payload')))).toHaveProperty('checkReceiver');
    expect((await row(order.id))?.slip_verify).toBe('valid');
  });

  test('a WebP picture is never sent: unchecked, and no call is made', async () => {
    localQr = null;
    const { token, order } = await start();
    await upload(token, order.id, webp(), 'image/webp');
    await checker.idle();
    expect(calls).toHaveLength(0);
    expect(await row(order.id)).toMatchObject({ slip_verify: 'unchecked', slip_verify_code: null });
  });

  test('nothing to check against (no PromptPay ID, no bank account): no call, unchecked', async () => {
    const { token, order } = await start();
    await h.client.query("delete from settings where key = 'promptpay'");
    try {
      await upload(token, order.id, picture());
      await checker.idle();
      expect(calls).toHaveLength(0);
      expect((await row(order.id))?.slip_verify).toBe('unchecked');
    } finally {
      await h.client.query(
        "insert into settings (key, value, updated_by) values ('promptpay', $1::jsonb, $2)",
        [JSON.stringify({ idType: 'phone', idValue: '0899994321' }), ownerId],
      );
    }
  });
});

describe('the duplicate key', () => {
  test('the local QR decode fills the key; the Slip2Go reference fills it when the decode gave none', async () => {
    const { token, order } = await start();
    await upload(token, order.id, picture());
    await checker.idle();
    expect((await row(order.id))?.slip_qr_hash).toBe(sha256(`014:${localRef()}`));

    localQr = null;
    const other = await start();
    await upload(other.token, other.order.id, picture(2));
    await checker.idle();
    expect((await row(other.order.id))?.slip_qr_hash).toBe(sha256(`002:${remoteRef()}`));
  });
});

describe('transient failures', () => {
  test('three attempts in all, one per read, then unchecked', async () => {
    const { token, order } = await start();
    respond = () => new Error('connection reset');
    await upload(token, order.id, picture());
    await checker.idle();
    expect(await row(order.id)).toMatchObject({ slip_verify: 'pending', slip_verify_attempts: 1 });

    expect(await checker.sweep()).toBe(1);
    await checker.idle();
    expect(await row(order.id)).toMatchObject({ slip_verify: 'pending', slip_verify_attempts: 2 });

    expect(await checker.sweep()).toBe(1);
    await checker.idle();
    expect(await row(order.id)).toMatchObject({
      slip_verify: 'unchecked',
      slip_verify_attempts: 3,
      status: 'claimed',
    });
    expect(calls).toHaveLength(3);
    expect(await checker.sweep()).toBe(0);
    expect(calls).toHaveLength(3);
  });

  test('a rate-limit code is retried like a network error; success on the second try is valid', async () => {
    const { token, order } = await start();
    respond = (_c, n) =>
      n === 1
        ? { body: { code: '429000', message: 'slow' }, status: 429 }
        : { body: answer('200200', currentAmountBaht) };
    await upload(token, order.id, picture());
    await checker.idle();
    expect((await row(order.id))?.slip_verify).toBe('pending');
    await checker.sweep();
    await checker.idle();
    expect(await row(order.id)).toMatchObject({ slip_verify: 'valid', slip_verify_attempts: 2 });
  });
});

describe('the sweep with OCR off and the verifier on', () => {
  test('once a verdict has landed the sweep selects nothing and the service is called exactly once', async () => {
    const { token, order } = await start();
    await upload(token, order.id, picture());
    await checker.idle();
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 4; i++) {
      expect(await checker.sweep()).toBe(0);
      await checker.idle();
    }
    expect(calls).toHaveLength(1);
    expect((await row(order.id))?.slip_check).toBeNull();
  });

  test('a payment left pending (a restart) is picked up by the sweep', async () => {
    const { token, order } = await start();
    await upload(token, order.id, picture());
    await checker.idle();
    await h.client.query(
      "update payments set slip_verify = 'pending', slip_verified_at = null where order_id = $1",
      [order.id],
    );
    expect(await checker.sweep()).toBe(1);
    await checker.idle();
    expect((await row(order.id))?.slip_verify).toBe('valid');
    expect(calls).toHaveLength(2);
  });
});

describe('a new slip and the same slip', () => {
  test('the same file sent again to the same payment keeps the verdict and makes no second call', async () => {
    const { token, order } = await start();
    const bytes = picture(3);
    await upload(token, order.id, bytes);
    await checker.idle();
    const first = await row(order.id);
    await upload(token, order.id, bytes);
    await checker.idle();
    const second = await row(order.id);
    expect(calls).toHaveLength(1);
    expect(second).toMatchObject({ slip_verify: 'valid', slip_verify_ref: 'REF-200200' });
    expect(second?.slip_image_key).not.toBe(first?.slip_image_key);
    expect(second?.slip_qr_hash).toBe(first?.slip_qr_hash);
  });

  test('a different file resets the verdict and is checked again', async () => {
    const { token, order } = await start();
    await upload(token, order.id, picture(3));
    await checker.idle();
    respond = () => ({ body: answer('200404', currentAmountBaht) });
    const res = await upload(token, order.id, picture(4));
    expect(res.statusCode).toBe(200);
    await checker.idle();
    expect(calls).toHaveLength(2);
    expect(await row(order.id)).toMatchObject({
      slip_verify: 'not_found',
      slip_verify_attempts: 1,
    });
  });

  test('a stale answer is thrown away: the first slip is replaced while it is being checked', async () => {
    const { token, order } = await start();
    const waiting: ((reply: { body: unknown }) => void)[] = [];
    respond = (_c, n) =>
      n === 1
        ? new Promise((resolve) => waiting.push(resolve))
        : { body: answer('200404', currentAmountBaht) };
    await upload(token, order.id, picture(5));
    await waitFor(() => waiting.length === 1);
    await upload(token, order.id, picture(6));
    const replaced = await row(order.id);
    expect(replaced?.slip_verify).toBe('pending');

    waiting[0]?.({ body: answer('200200', currentAmountBaht) });
    await checker.idle();
    const final = await row(order.id);
    expect(final?.slip_image_key).toBe(replaced?.slip_image_key);
    // The late "valid" belonged to the first picture; the second picture's own answer stands.
    expect(final?.slip_verify).toBe('not_found');
    expect(calls).toHaveLength(2);
  });
});

describe('alerts and the daily cap', () => {
  test('an expired package alerts the owner once per business date and falls back to unchecked', async () => {
    respond = () => ({ body: { code: '401004', message: 'package expired' }, status: 401 });
    const first = await start();
    await upload(first.token, first.order.id, picture(1));
    await checker.idle();
    const second = await start();
    await upload(second.token, second.order.id, picture(2));
    await checker.idle();
    for (const o of [first.order, second.order]) {
      expect(await row(o.id)).toMatchObject({
        slip_verify: 'unchecked',
        slip_verify_code: '401004',
        status: 'claimed',
      });
    }
    expect(alertsOf('slip2go.unavailable')).toHaveLength(1);
    expect(alertsOf('slip2go.unavailable')[0]).toMatchObject({ severity: 'warn' });

    h.clock.set('2028-02-02T08:00:00.000Z');
    const third = await start();
    await upload(third.token, third.order.id, picture(3));
    await checker.idle();
    expect(alertsOf('slip2go.unavailable')).toHaveLength(2);
  });

  test('a code that is not about the account does not alert', async () => {
    const before = alertsOf('slip2go.unavailable').length;
    respond = () => ({ body: { code: '400400', message: 'bad request' }, status: 400 });
    const { token, order } = await start();
    await upload(token, order.id, picture());
    await checker.idle();
    expect(alertsOf('slip2go.unavailable')).toHaveLength(before);
  });

  test('above the daily cap the answer is unchecked without a call, with one alert; the next day starts again', async () => {
    h.clock.set('2028-03-01T08:00:00.000Z');
    dailyCap = 2;
    checker = buildChecker();
    installSlipChecker(checker);
    const placed = [];
    for (let i = 0; i < 3; i++) {
      const o = await start();
      await upload(o.token, o.order.id, picture(10 + i));
      await checker.idle();
      placed.push(o.order);
    }
    expect(calls).toHaveLength(2);
    expect((await row(placed[2]?.id ?? ''))?.slip_verify).toBe('unchecked');
    expect(alertsOf('slip2go.cap_reached')).toHaveLength(1);

    h.clock.set('2028-03-02T08:00:00.000Z');
    const next = await start();
    await upload(next.token, next.order.id, picture(20));
    await checker.idle();
    expect(calls).toHaveLength(3);
    expect((await row(next.order.id))?.slip_verify).toBe('valid');
  });

  test('replacing the slip does not hide calls from the cap', async () => {
    h.clock.set('2028-04-01T08:00:00.000Z');
    dailyCap = 2;
    checker = buildChecker();
    installSlipChecker(checker);
    const { token, order } = await start();
    for (let i = 0; i < 4; i++) {
      await upload(token, order.id, picture(30 + i));
      await checker.idle();
    }
    expect(calls).toHaveLength(2);
  });
});

describe('what stays private', () => {
  test('the key is in no log line; no name, QR text or response body is stored or logged', async () => {
    const { token, order } = await start();
    await upload(token, order.id, picture());
    await checker.idle();
    respond = () => new Error(`failed ${KEY}`);
    const other = await start();
    await upload(other.token, other.order.id, picture(2));
    await checker.idle();

    const everything = `${h.logs()}${JSON.stringify(logLines)}`;
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(RAW_QR);
    expect(everything).not.toContain('PRIVATE SENDER NAME');
    const dump = JSON.stringify([
      (await h.client.query('select * from payments where order_id = $1', [order.id])).rows,
      (await h.client.query('select * from audit_log')).rows,
    ]);
    expect(dump).not.toContain(RAW_QR);
    expect(dump).not.toContain('PRIVATE SENDER NAME');
    expect(dump).not.toContain(remoteRef());
  });

  test('staff see the verdict on the payments list; the payment itself, sync and the customer never carry it', async () => {
    const { token, order } = await start();
    const res = await upload(token, order.id, picture());
    await checker.idle();
    const payment = await row(order.id);

    const staff = await call('GET', `/v1/orders/${order.id}/payments`, staffToken);
    expect(staff.statusCode).toBe(200);
    const entry = staff.json().slipChecks[0];
    expect(entry.paymentId).toBe(payment?.id);
    expect(entry.verify.verdict).toBe('valid');
    expect(typeof entry.verify.at).toBe('string');
    // OCR is off here: there is no amount reading, and no invented one.
    expect(entry.check).toBeUndefined();
    expect(JSON.stringify(staff.json().payments)).not.toMatch(/verif|slip/i);

    const mine = await call('GET', `/v1/app/orders/${order.id}`, token);
    for (const body of [mine.body, res.body]) {
      expect(body).not.toMatch(/verify|verdict|200200|REF-|slip_verify|slipVerify/i);
    }
  });

  test('a pending verdict is shown to staff as pending', async () => {
    const { token, order } = await start();
    respond = () => new Promise(() => undefined);
    await upload(token, order.id, picture());
    const staff = await call('GET', `/v1/orders/${order.id}/payments`, staffToken);
    expect(staff.json().slipChecks[0].verify).toEqual({ verdict: 'pending' });
  });
});

describe('OCR and the bank check together', () => {
  test('both readings are stored, each on its own pending flag', async () => {
    ocrOn = true;
    ocrText = 'จำนวน: 10.00 บาท';
    checker = buildChecker();
    installSlipChecker(checker);
    const { token, order } = await start();
    await upload(token, order.id, picture());
    await checker.idle();
    const after = await row(order.id);
    expect(after?.slip_check).not.toBe('pending');
    expect(after?.slip_check).not.toBeNull();
    expect(after?.slip_verify).toBe('valid');
    const staff = await call('GET', `/v1/orders/${order.id}/payments`, staffToken);
    expect(staff.json().slipChecks[0]).toMatchObject({ verify: { verdict: 'valid' } });
    expect(staff.json().slipChecks[0].check).toBeDefined();
  });
});
describe('auto-confirm (D-27)', () => {
  interface Confirmed {
    status: string;
    confirmed_by_staff_id: string | null;
    confirmed_at: string | null;
    auto_confirmed: boolean;
    rev: string;
    id: string;
  }
  const state = async (orderId: string) =>
    (
      await h.client.query<Confirmed>(
        'select id, status, confirmed_by_staff_id, confirmed_at, auto_confirmed, rev from payments where order_id = $1',
        [orderId],
      )
    ).rows[0];
  const on = () => {
    autoConfirm = { maxSatang: 100_000 };
    checker = buildChecker();
    installSlipChecker(checker);
  };
  const sendSlip = async (bytes = picture()) => {
    const placed = await start();
    await upload(placed.token, placed.order.id, bytes);
    await checker.idle();
    return placed;
  };
  const orderState = async (orderId: string) =>
    (
      await h.client.query<{ payment_status: string }>(
        'select payment_status from orders where id = $1',
        [orderId],
      )
    ).rows[0]?.payment_status;

  test('a valid bank check confirms the payment itself: the machine, one commit, an audit row, events', async () => {
    on();
    const marker = h.events.length;
    const { token, order } = await start();
    const res = await upload(token, order.id, picture());
    const claimedRev = Math.min(
      ...h.events.slice(marker).flatMap((e) => (e.type === 'payment.upserted' ? [e.rev] : [])),
    );
    await checker.idle();

    const after = await state(order.id);
    expect(after).toMatchObject({
      status: 'confirmed',
      confirmed_by_staff_id: null,
      auto_confirmed: true,
    });
    expect(after?.confirmed_at).not.toBeNull();
    expect(Number(after?.rev)).toBeGreaterThan(claimedRev);
    expect(await orderState(order.id)).toBe('paid');
    expect(res.json().payment.status).toBe('claimed');

    // The same service path as a staff confirm: events after the commit, for the payment and the order.
    const events = h.events.slice(marker);
    expect(
      events.some(
        (e) => e.type === 'payment.upserted' && e.id === after?.id && e.data.status === 'confirmed',
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === 'order.upserted' && e.id === order.id)).toBe(true);

    // The audit row holds the Slip2Go reference, the code and the amount in satang, nothing else.
    const audit = (await h.auditRows(after?.id ?? '')).filter(
      (a) => a.action === 'payment.auto_confirm',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'system', actorId: null, deviceId: null });
    expect(audit[0]?.before).toBeNull();
    expect(audit[0]?.after).toEqual({
      referenceId: 'REF-200200',
      code: '200200',
      amountSatang: order.totalSatang,
    });
    expect(JSON.stringify(audit[0])).not.toContain('PRIVATE SENDER NAME');
  });

  test('staff see that it was automatic on the payments list only; the payment, sync and the customer do not say so', async () => {
    on();
    const { token, order } = await sendSlip();
    const payment = await state(order.id);
    const staff = await call('GET', `/v1/orders/${order.id}/payments`, staffToken);
    expect(staff.json().autoConfirmedPaymentIds).toEqual([payment?.id]);
    expect(JSON.stringify(staff.json().payments)).not.toMatch(/auto/i);
    const mine = await call('GET', `/v1/app/orders/${order.id}`, token);
    expect(mine.body).not.toMatch(/auto|verify|slip2go/i);
  });

  test('a payment confirmed by staff is not marked automatic', async () => {
    const { token, order } = await start();
    await upload(token, order.id, picture());
    await checker.idle();
    const payment = await state(order.id);
    const confirm = await h.app.inject({
      method: 'POST',
      url: `/v1/payments/${payment?.id}/confirm`,
      headers: { authorization: `Bearer ${staffToken}` },
      payload: { attestedBankCheck: true },
      remoteAddress: h.nextIp(),
    });
    expect(confirm.statusCode).toBe(200);
    expect(await state(order.id)).toMatchObject({
      status: 'confirmed',
      auto_confirmed: false,
      confirmed_by_staff_id: ownerId,
    });
    const staff = await call('GET', `/v1/orders/${order.id}/payments`, staffToken);
    expect(staff.json().autoConfirmedPaymentIds).toBeUndefined();
  });

  test('off: a valid check changes nothing but the verdict', async () => {
    const { order } = await sendSlip();
    expect(await state(order.id)).toMatchObject({ status: 'claimed', auto_confirmed: false });
    expect((await row(order.id))?.slip_verify).toBe('valid');
  });

  test('over the ceiling staff still tick: the payment stays claimed; at the ceiling it is confirmed', async () => {
    autoConfirm = { maxSatang: 999 };
    checker = buildChecker();
    installSlipChecker(checker);
    const { order } = await sendSlip();
    expect(Number((await row(order.id))?.amount_satang)).toBeGreaterThan(999);
    expect(await state(order.id)).toMatchObject({ status: 'claimed' });
    expect((await row(order.id))?.slip_verify).toBe('valid');
    const exact = await start();
    localQr = { ...localQrFor(), qr: { sendingBank: '014', transRef: 'LOCALREF9999999' } };
    autoConfirm = { maxSatang: exact.order.totalSatang };
    checker = buildChecker();
    installSlipChecker(checker);
    await upload(exact.token, exact.order.id, picture(2));
    await checker.idle();
    expect((await state(exact.order.id))?.status).toBe('confirmed');
  });

  const refused: [name: string, code: string][] = [
    ['found without conditions (200000)', '200000'],
    ['receiver mismatch', '200401'],
    ['amount mismatch', '200402'],
    ['date mismatch', '200403'],
    ['not found', '200404'],
    ['fraud', '200500'],
    ['duplicate at the service', '200501'],
    ['account unavailable', '401004'],
    ['bad request', '400400'],
  ];
  test.each(refused)('%s never confirms', async (_name, code) => {
    on();
    respond = () => ({ body: answer(code, currentAmountBaht) });
    const { order } = await sendSlip();
    expect(await state(order.id)).toMatchObject({ status: 'claimed', auto_confirmed: false });
  });

  test('a valid answer whose amount differs from the payment never confirms (rule 1)', async () => {
    on();
    respond = () => ({ body: answer('200200', currentAmountBaht + 0.01) });
    const { order } = await sendSlip();
    expect(await state(order.id)).toMatchObject({ status: 'claimed' });
    expect((await row(order.id))?.slip_verify).toBe('amount_mismatch');
  });

  test('a transient failure never confirms; the retry that succeeds does', async () => {
    on();
    respond = (_c, n) =>
      n === 1 ? new Error('reset') : { body: answer('200200', currentAmountBaht) };
    const { order } = await sendSlip();
    expect((await state(order.id))?.status).toBe('claimed');
    await checker.sweep();
    await checker.idle();
    expect((await state(order.id))?.status).toBe('confirmed');
  });

  test('a slip already seen on another payment is a duplicate: valid, but staff tick', async () => {
    on();
    const first = await sendSlip();
    expect((await state(first.order.id))?.status).toBe('confirmed');
    // The same transfer (the same QR key) sent for another order.
    const second = await sendSlip(picture(9));
    expect(await state(second.order.id)).toMatchObject({
      status: 'claimed',
      auto_confirmed: false,
    });
    expect((await row(second.order.id))?.slip_verify).toBe('valid');
    const staff = await call('GET', `/v1/orders/${second.order.id}/payments`, staffToken);
    expect(staff.json().slipDuplicates[0]).toMatchObject({ paymentStatus: 'confirmed' });
  });

  test('a duplicate found only through the Slip2Go reference stops it too', async () => {
    on();
    localQr = null;
    const first = await sendSlip();
    expect((await state(first.order.id))?.status).toBe('confirmed');
    const second = await sendSlip(picture(9));
    expect((await state(second.order.id))?.status).toBe('claimed');
  });

  test('the payment must still be claimed when the answer commits', async () => {
    on();
    const { token, order } = await start();
    respond = async () => {
      // Staff cancel the claim while the service is being asked.
      await h.client.query("update payments set status = 'cancelled' where order_id = $1", [
        order.id,
      ]);
      return { body: answer('200200', currentAmountBaht) };
    };
    await upload(token, order.id, picture());
    await checker.idle();
    expect(await state(order.id)).toMatchObject({ status: 'cancelled', auto_confirmed: false });
  });

  test('only PromptPay: a payment that is not PromptPay at commit is never confirmed', async () => {
    on();
    const { token, order } = await start();
    respond = async () => {
      await h.client.query("update payments set method = 'cash' where order_id = $1", [order.id]);
      return { body: answer('200200', currentAmountBaht) };
    };
    await upload(token, order.id, picture());
    await checker.idle();
    expect(await state(order.id)).toMatchObject({ status: 'claimed', auto_confirmed: false });
  });

  test('a replaced slip is not confirmed by the answer for the old one', async () => {
    on();
    const { token, order } = await start();
    const waiting: ((reply: { body: unknown }) => void)[] = [];
    respond = (_c, n) =>
      n === 1
        ? new Promise((resolve) => waiting.push(resolve))
        : { body: answer('200404', currentAmountBaht) };
    await upload(token, order.id, picture(5));
    await waitFor(() => waiting.length === 1);
    await upload(token, order.id, picture(6));
    waiting[0]?.({ body: answer('200200', currentAmountBaht) });
    await checker.idle();
    expect(await state(order.id)).toMatchObject({ status: 'claimed', auto_confirmed: false });
  });

  test('staff can still void an automatic confirmation, with a reason, as any other', async () => {
    on();
    const { order } = await sendSlip();
    const payment = await state(order.id);
    expect(payment?.status).toBe('confirmed');
    h.clock.advanceSeconds(90);
    const token = await h.steppedUpOwner(ownerFixture);
    const alertsBefore = h.alerts.length;
    const bad = await h.app.inject({
      method: 'POST',
      url: `/v1/payments/${payment?.id}/void`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
      remoteAddress: h.nextIp(),
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/payments/${payment?.id}/void`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'checked the bank app: no money arrived' },
      remoteAddress: h.nextIp(),
    });
    expect(res.statusCode).toBe(200);
    expect(await state(order.id)).toMatchObject({ status: 'voided', auto_confirmed: true });
    expect(await orderState(order.id)).toBe('unpaid');
    expect(h.alerts.length).toBeGreaterThan(alertsBefore);
    const actions = (await h.auditRows(payment?.id ?? '')).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['payment.auto_confirm', 'payment.void']));
  });
});
