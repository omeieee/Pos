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
/** Off (0) unless a test opts in: the older tests are about final answers. */
let graceSeconds = 0;
let firstCallDelayMs = 0;
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
    notFoundGraceSeconds: graceSeconds,
    firstCallDelayMs,
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
  graceSeconds = 0;
  firstCallDelayMs = 0;
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

describe('the first bank call is held back a moment', () => {
  test('with a hold set, nothing is sent at once and the one call goes out after it', async () => {
    firstCallDelayMs = 250;
    checker = buildChecker();
    installSlipChecker(checker);
    const { token, order } = await start();
    respond = () => ({ body: answer('200200', currentAmountBaht) });
    const res = await upload(token, order.id, picture());
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.length).toBe(0);
    await waitFor(() => calls.length === 1);
  });
});

describe('the minute sweep respects the first-call hold', () => {
  test('a sweep inside the hold makes no call; the one call goes out when the hold ends', async () => {
    firstCallDelayMs = 300;
    checker = buildChecker();
    installSlipChecker(checker);
    const { token, order } = await start();
    respond = () => ({ body: answer('200200', currentAmountBaht) });
    await upload(token, order.id, picture());
    // Inside the hold (the clock has not moved): the row is pending but the sweep leaves it alone.
    expect(await checker.sweep()).toBe(0);
    await checker.idle();
    expect(calls.length).toBe(0);
    await waitFor(() => calls.length === 1);
    await checker.idle();
    expect(await checker.sweep()).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.length).toBe(1);
    expect((await row(order.id))?.slip_verify).toBe('valid');
  });

  test('after the hold has passed, the sweep picks a pending row up (a restart lost the timer)', async () => {
    firstCallDelayMs = 5000;
    checker = buildChecker();
    installSlipChecker(checker);
    const { token, order } = await start();
    await upload(token, order.id, picture());
    expect(await checker.sweep()).toBe(0);
    h.clock.advanceSeconds(5);
    expect(await checker.sweep()).toBe(1);
    await checker.idle();
    expect(calls.length).toBe(1);
    expect((await row(order.id))?.slip_verify).toBe('valid');
  });

  test('the timer joins a read already running instead of starting a second one', async () => {
    firstCallDelayMs = 50;
    checker = buildChecker();
    installSlipChecker(checker);
    const { token, order } = await start();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    respond = async () => {
      await gate;
      return { body: answer('200200', currentAmountBaht) };
    };
    await upload(token, order.id, picture());
    await waitFor(() => calls.length === 1);
    // A second enqueue for the same payment while its read is in flight: no parallel call.
    const [payment] = await payments(order.id);
    checker.enqueue(payment?.id ?? '');
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.length).toBe(1);
    release();
    await checker.idle();
    expect(calls.length).toBe(1);
  });
});

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
      // The attempt is counted before the call, so a failed commit cannot repeat it for ever.
      slip_verify_attempts: 1,
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
  test('a valid answer stores Slip2Go key; any other answer keeps the local decode; the Slip2Go key fills it when the decode gave none', async () => {
    const { token, order } = await start();
    await upload(token, order.id, picture());
    await checker.idle();
    expect((await row(order.id))?.slip_qr_hash).toBe(sha256(`002:${remoteRef()}`));

    const mismatch = await start();
    respond = () => ({ body: answer('200402', currentAmountBaht) });
    await upload(mismatch.token, mismatch.order.id, picture(3));
    await checker.idle();
    expect((await row(mismatch.order.id))?.slip_qr_hash).toBe(sha256(`014:${localRef()}`));
    respond = () => ({ body: answer('200200', currentAmountBaht) });

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
    respond = () => ({
      body: answer('200200', currentAmountBaht, { transRef: `9${remoteRef().slice(1)}` }),
    });
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

  test('one transfer cannot confirm two orders, whichever is checked first', async () => {
    on();
    localQr = null;
    // A: the first call fails, so A has no Slip2Go key yet. B (another photo of the same transfer,
    // claimed later) is checked and confirmed. Then A's retry answers valid with the same key.
    respond = (_c, n) =>
      n === 1 ? new Error('reset') : { body: answer('200200', currentAmountBaht) };
    const a = await sendSlip(picture(1));
    expect((await state(a.order.id))?.status).toBe('claimed');
    const b = await sendSlip(picture(2));
    expect((await state(b.order.id))?.status).toBe('confirmed');
    await checker.sweep();
    await checker.idle();
    expect(await state(a.order.id)).toMatchObject({ status: 'claimed', auto_confirmed: false });
    expect((await row(a.order.id))?.slip_verify).toBe('valid');
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

  describe('a slip held by any other payment, in any status, never auto-confirms', () => {
    const payments = async (orderId: string) =>
      (
        await h.client.query<{ id: string; status: string; auto_confirmed: boolean }>(
          'select id, status, auto_confirmed from payments where order_id = $1 order by id',
          [orderId],
        )
      ).rows;
    const latest = async (orderId: string) => (await payments(orderId)).at(-1);
    const voidIt = async (paymentId: string, afterSeconds: number) => {
      // A moment no other test used: a one-time code is never accepted twice.
      h.clock.advanceSeconds(afterSeconds);
      const token = await h.steppedUpOwner(ownerFixture);
      const res = await h.app.inject({
        method: 'POST',
        url: `/v1/payments/${paymentId}/void`,
        headers: { authorization: `Bearer ${token}` },
        payload: { reason: 'checked the bank app: no money arrived' },
        remoteAddress: h.nextIp(),
      });
      expect(res.statusCode).toBe(200);
      return token;
    };

    test('cancelled, then the same file is claimed again: it stays claimed for staff', async () => {
      const first = await sendSlip(); // auto-confirm is off: the claim waits
      const firstPayment = await latest(first.order.id);
      expect(firstPayment?.status).toBe('claimed');
      const cancel = await h.app.inject({
        method: 'POST',
        url: `/v1/payments/${firstPayment?.id}/cancel-claimed`,
        headers: { authorization: `Bearer ${staffToken}` },
        payload: { reason: 'no money found' },
        remoteAddress: h.nextIp(),
      });
      expect(cancel.statusCode).toBe(200);
      on();
      await upload(first.token, first.order.id, picture());
      await checker.idle();
      const again = await latest(first.order.id);
      expect(again?.id).not.toBe(firstPayment?.id);
      expect(again).toMatchObject({ status: 'claimed', auto_confirmed: false });
      expect((await row(first.order.id))?.slip_verify).toBe('valid');
    });

    test('voided, then the same file is claimed again on the same order: staff tick', async () => {
      on();
      const first = await sendSlip();
      const confirmed = await latest(first.order.id);
      expect(confirmed?.status).toBe('confirmed');
      const ownerToken = await voidIt(confirmed?.id ?? '', 150);
      // Staff open a new PromptPay payment on the order; the customer sends the same file.
      const fresh = await h.app.inject({
        method: 'POST',
        url: `/v1/orders/${first.order.id}/payments`,
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { clientRequestId: crypto.randomUUID(), method: 'promptpay' },
        remoteAddress: h.nextIp(),
      });
      expect(fresh.statusCode).toBe(201);
      const up = await upload(first.token, first.order.id, picture());
      expect(up.statusCode).toBe(200);
      await checker.idle();
      const again = await latest(first.order.id);
      expect(again?.id).not.toBe(confirmed?.id);
      expect(again).toMatchObject({ status: 'claimed', auto_confirmed: false });
    });

    test('a voided slip reused on a new order inside the date slack: staff tick', async () => {
      on();
      const first = await sendSlip();
      const confirmed = await latest(first.order.id);
      await voidIt(confirmed?.id ?? '', 210);
      // Another photo of the same transfer on a new order, placed minutes later.
      h.clock.advanceSeconds(60);
      const second = await sendSlip(picture(9));
      expect(await latest(second.order.id)).toMatchObject({
        status: 'claimed',
        auto_confirmed: false,
      });
      expect((await row(second.order.id))?.slip_verify).toBe('valid');
    });
  });

  describe('the transfer key and the receiver must be proven', () => {
    test('a valid answer without a transRef, or with a bank id that is not 3 digits, is shown but not confirmed', async () => {
      on();
      const variants = [
        { transRef: undefined },
        { sender: { bank: { id: '14' } } },
        { sender: { bank: {} } },
      ];
      for (const [i, data] of variants.entries()) {
        respond = () => ({ body: answer('200200', currentAmountBaht, data) });
        const sent = await sendSlip(picture(20 + i));
        expect(await state(sent.order.id)).toMatchObject({
          status: 'claimed',
          auto_confirmed: false,
        });
        const stored = await row(sent.order.id);
        expect(stored?.slip_verify).toBe('valid');
        // The local decode still supplies a key for the staff duplicate hint.
        expect(stored?.slip_qr_hash).toBe(sha256(`014:${localRef()}`));
      }
    });

    test('a valid answer stores the Slip2Go key, so auto-confirmed rows share one format', async () => {
      on();
      const sent = await sendSlip();
      expect(await state(sent.order.id)).toMatchObject({ status: 'confirmed' });
      expect((await row(sent.order.id))?.slip_qr_hash).toBe(sha256(`002:${remoteRef()}`));
    });

    const setPromptpay = (value: Record<string, string>) =>
      h.client.query("update settings set value = $1::jsonb where key = 'promptpay'", [
        JSON.stringify(value),
      ]);
    afterEach(async () => {
      await h.client.query("delete from settings where key in ('promptpay', 'bank_account')");
      await h.client.query(
        "insert into settings (key, value, updated_by) values ('promptpay', $1::jsonb, $2)",
        [JSON.stringify({ idType: 'phone', idValue: '0899994321' }), ownerId],
      );
    });

    test.each([
      ['a 13-digit ID', { idType: 'national_id', idValue: '1234567890123' }],
      ['a 15-digit ID', { idType: 'ewallet', idValue: '123456789012345' }],
    ])('%s: the call and the verdict happen, the confirmation does not', async (_n, id) => {
      on();
      await setPromptpay(id);
      const sent = await sendSlip();
      expect(calls).toHaveLength(1);
      expect((await row(sent.order.id))?.slip_verify).toBe('valid');
      expect(await state(sent.order.id)).toMatchObject({
        status: 'claimed',
        auto_confirmed: false,
      });
    });

    test('a bank-account receiver as well', async () => {
      on();
      const placed = await start();
      await h.client.query("delete from settings where key = 'promptpay'");
      await h.client.query(
        "insert into settings (key, value, updated_by) values ('bank_account', $1::jsonb, $2) on conflict (key) do update set value = excluded.value",
        [
          JSON.stringify({ bankCode: '014', accountNumber: '1234567890', accountName: 'X' }),
          ownerId,
        ],
      );
      await upload(placed.token, placed.order.id, picture());
      await checker.idle();
      expect(calls).toHaveLength(1);
      expect((await row(placed.order.id))?.slip_verify).toBe('valid');
      expect((await state(placed.order.id))?.status).toBe('claimed');
    });
  });
});

describe('a commit that fails after the answer', () => {
  test('at most three calls in all, then unchecked', async () => {
    const { token, order } = await start();
    // The verdict cannot be written (a check constraint stands in for any commit failure).
    await h.client.query(
      "alter table payments add constraint test_no_valid check (slip_verify is distinct from 'valid') not valid",
    );
    try {
      await upload(token, order.id, picture());
      await checker.idle();
      for (let i = 0; i < 6; i++) {
        await checker.sweep();
        await checker.idle();
      }
    } finally {
      await h.client.query('alter table payments drop constraint test_no_valid');
    }
    expect(calls).toHaveLength(3);
    expect(await row(order.id)).toMatchObject({
      slip_verify: 'unchecked',
      slip_verify_attempts: 3,
      status: 'claimed',
    });
    expect(await checker.sweep()).toBe(0);
    expect(calls).toHaveLength(3);
  });
});

describe('a payment that is no longer claimed', () => {
  test('is settled as unchecked without a call', async () => {
    const { token, order } = await start();
    await upload(token, order.id, picture());
    await checker.idle();
    expect(calls).toHaveLength(1);
    await h.client.query(
      "update payments set status = 'cancelled', slip_verify = 'pending', slip_verify_attempts = 0 where order_id = $1",
      [order.id],
    );
    expect(await checker.sweep()).toBe(1);
    await checker.idle();
    expect(calls).toHaveLength(1);
    expect(await row(order.id)).toMatchObject({ slip_verify: 'unchecked', status: 'cancelled' });
  });
});

describe('the other account codes alert the owner too', () => {
  test.each(['401001', '401002', '401003'])('%s: one alert a business date', async (code) => {
    h.clock.set(`2028-05-0${code.slice(-1)}T08:00:00.000Z`);
    respond = () => ({ body: { code, message: 'account' }, status: 401 });
    const before = alertsOf('slip2go.unavailable').length;
    for (const fill of [31, 32]) {
      const sent = await start();
      await upload(sent.token, sent.order.id, picture(fill));
      await checker.idle();
      expect(await row(sent.order.id)).toMatchObject({
        slip_verify: 'unchecked',
        slip_verify_code: code,
      });
    }
    expect(alertsOf('slip2go.unavailable')).toHaveLength(before + 1);
  });
});

describe('what the customer is told about the slip (neutral)', () => {
  const slipCheckOf = async (token: string, orderId: string) =>
    (await call('GET', `/v1/app/orders/${orderId}`, token)).json().slipCheck;
  const claimOnly = (token: string, orderId: string) =>
    call('POST', `/v1/app/orders/${orderId}/claim`, token);

  test('none with no picture, checking while the bank check runs, then staff_review', async () => {
    const { token, order } = await start();
    expect(await slipCheckOf(token, order.id)).toBe('none');
    await claimOnly(token, order.id);
    expect(await slipCheckOf(token, order.id)).toBe('none');

    let release: (reply: { body: unknown }) => void = () => undefined;
    respond = () => new Promise((resolve) => (release = resolve));
    await upload(token, order.id, picture());
    await waitFor(() => calls.length === 1);
    expect(await slipCheckOf(token, order.id)).toBe('checking');
    release({ body: answer('200200', currentAmountBaht) });
    await checker.idle();
    // A valid answer with auto-confirm off is still staff's to tick.
    expect(await slipCheckOf(token, order.id)).toBe('staff_review');
  });

  test.each([
    ['200200'],
    ['200000'],
    ['200401'],
    ['200402'],
    ['200403'],
    ['200404'],
    ['200500'],
    ['401004'],
  ])(
    'code %s: the customer sees the same staff_review and not a trace of the verdict',
    async (code) => {
      const { token, order } = await start();
      respond = () => ({ body: answer(code, currentAmountBaht) });
      const res = await upload(token, order.id, picture());
      await checker.idle();
      const mine = await call('GET', `/v1/app/orders/${order.id}`, token);
      expect(mine.json().slipCheck).toBe('staff_review');
      expect(mine.json().payment.status).toBe('claimed');
      for (const body of [mine.body, res.body]) {
        expect(body).not.toMatch(
          /verify|verdict|valid|mismatch|not_found|fraud|unchecked|\b\d{6}\b/i,
        );
      }
    },
  );

  test('a slip that was never marked for the bank check (verifier off) is staff_review, not an endless checking', async () => {
    const { token, order } = await start();
    installSlipChecker(null);
    await upload(token, order.id, picture());
    expect((await row(order.id))?.slip_verify).toBeNull();
    expect(await slipCheckOf(token, order.id)).toBe('staff_review');
  });

  test('a paid order carries no slipCheck', async () => {
    autoConfirm = { maxSatang: 100_000 };
    checker = buildChecker();
    installSlipChecker(checker);
    const { token, order } = await start();
    await upload(token, order.id, picture());
    await checker.idle();
    const mine = await call('GET', `/v1/app/orders/${order.id}`, token);
    expect(mine.json().paymentStatus).toBe('paid');
    expect(mine.json().slipCheck).toBeUndefined();
  });
});

describe('staff recheck of the bank check', () => {
  // The earlier tests used up this business date's 100 calls: these start with room to spare.
  beforeEach(() => {
    dailyCap = 10_000;
    checker = buildChecker();
    installSlipChecker(checker);
  });

  const crid = () => crypto.randomUUID();
  const recheck = (paymentId: string, token: string | null = staffToken, id = crid()) =>
    h.app.inject({
      method: 'POST',
      url: `/v1/payments/${paymentId}/slip-recheck`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: { clientRequestId: id },
      remoteAddress: h.nextIp(),
    });
  const verdictOf = (res: { json(): { slipChecks?: { verify?: { verdict: string } }[] } }) =>
    res.json().slipChecks?.[0]?.verify?.verdict;
  /** An order whose slip got `first` as the bank's answer. */
  async function checked(first: string, picFill = 1) {
    const placed = await start();
    respond = () => ({ body: answer(first, currentAmountBaht) });
    await upload(placed.token, placed.order.id, picture(picFill));
    await checker.idle();
    const payment = await row(placed.order.id);
    return { ...placed, paymentId: payment?.id ?? '' };
  }

  test('runs the check again, stores the new verdict, answers the payments view, audits, and publishes', async () => {
    const { order, paymentId } = await checked('200404');
    expect((await row(order.id))?.slip_verify).toBe('not_found');
    respond = () => ({ body: answer('200200', currentAmountBaht) });
    const marker = h.events.length;

    const res = await recheck(paymentId);
    expect(res.statusCode).toBe(200);
    expect(verdictOf(res)).toBe('valid');
    expect(calls).toHaveLength(2);
    expect(await row(order.id)).toMatchObject({
      slip_verify: 'valid',
      slip_verify_attempts: 2,
      status: 'claimed',
    });
    const seen = h.events
      .slice(marker)
      .filter((e) => e.type === 'payment.upserted' && e.id === paymentId);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const audit = (await h.auditRows(paymentId)).filter((a) => a.action === 'payment.slip_recheck');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'staff', actorId: ownerId });
    expect(JSON.stringify(audit[0])).not.toContain(KEY);
  });

  test('with auto-confirm on, a valid recheck confirms by the D-27 path; with it off the payment stays claimed', async () => {
    autoConfirm = { maxSatang: 100_000 };
    checker = buildChecker();
    installSlipChecker(checker);
    const on = await checked('200402');
    expect((await row(on.order.id))?.status).toBe('claimed');
    respond = () => ({ body: answer('200200', currentAmountBaht) });
    expect((await recheck(on.paymentId)).statusCode).toBe(200);
    expect(
      (
        await h.client.query<{ status: string; auto_confirmed: boolean }>(
          'select status, auto_confirmed from payments where id = $1',
          [on.paymentId],
        )
      ).rows[0],
    ).toEqual({ status: 'confirmed', auto_confirmed: true });

    autoConfirm = null;
    checker = buildChecker();
    installSlipChecker(checker);
    const off = await checked('200402', 2);
    respond = () => ({ body: answer('200200', currentAmountBaht) });
    expect(verdictOf(await recheck(off.paymentId))).toBe('valid');
    expect((await row(off.order.id))?.status).toBe('claimed');
  });

  test('the same request id again makes no second call and changes nothing', async () => {
    const { order, paymentId } = await checked('200404');
    respond = () => ({ body: answer('200200', currentAmountBaht) });
    const id = crid();
    expect((await recheck(paymentId, staffToken, id)).statusCode).toBe(200);
    const again = await recheck(paymentId, staffToken, id);
    expect(again.statusCode).toBe(200);
    expect(verdictOf(again)).toBe('valid');
    expect(calls).toHaveLength(2);
    expect((await row(order.id))?.slip_verify_attempts).toBe(2);
    expect(
      (await h.auditRows(paymentId)).filter((a) => a.action === 'payment.slip_recheck'),
    ).toHaveLength(1);
  });

  test('a body without a request id, or with anything else, is refused', async () => {
    const { paymentId } = await checked('200404');
    for (const payload of [{}, { clientRequestId: crid(), x: 1 }]) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/v1/payments/${paymentId}/slip-recheck`,
        headers: { authorization: `Bearer ${staffToken}` },
        payload,
        remoteAddress: h.nextIp(),
      });
      expect(res.statusCode).toBe(400);
    }
    expect(calls).toHaveLength(1);
  });

  test('a role without payment.confirm gets 403, no session 401, a customer token is no staff session', async () => {
    const { token, paymentId } = await checked('200404');
    const device = await h.newDevice();
    const kitchen = await h.newStaff('kitchen', '4821');
    const kitchenToken = await h.pinSession(device.token, kitchen.id, kitchen.pin);
    expect((await recheck(paymentId, kitchenToken)).statusCode).toBe(403);
    expect((await recheck(paymentId, null)).statusCode).toBe(401);
    expect((await recheck(paymentId, token)).statusCode).toBe(401);
    expect(calls).toHaveLength(1);
  });

  test('one press is one call: a bank hiccup settles as unchecked at once', async () => {
    const { order, paymentId } = await checked('200404');
    respond = () => new Error('connection reset');
    const res = await recheck(paymentId);
    expect(res.statusCode).toBe(200);
    expect(verdictOf(res)).toBe('unchecked');
    expect(calls).toHaveLength(2);
    expect((await row(order.id))?.slip_verify_attempts).toBe(2);
  });

  test('staff get 3 more attempts on top of the automatic ones (6 for a not-found picture): a 10th call is refused, nothing is written', async () => {
    const { order, paymentId } = await checked('200404');
    // The grace budget was used up (6 calls) and staff already made 2 more: one press is left.
    await h.client.query(
      'update payments set slip_verify_attempts = 8, slip_staff_calls = 2 where id = $1',
      [paymentId],
    );
    respond = () => ({ body: answer('200404', currentAmountBaht) });
    expect((await recheck(paymentId)).statusCode).toBe(200);
    expect((await row(order.id))?.slip_verify_attempts).toBe(9);
    const before = await row(order.id);
    const refused = await recheck(paymentId);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'SLIP_RECHECK_LIMIT' });
    expect(calls).toHaveLength(2);
    expect(await row(order.id)).toEqual(before);
  });

  test('a not-found picture that only had 1 call gets a ceiling of max(1, 3) + 3 = 6, not 9', async () => {
    const { order, paymentId } = await checked('200404');
    expect((await row(order.id))?.slip_verify_attempts).toBe(1);
    // Four staff calls made on top of that 1: one press is left, and the ceiling does not grow.
    await h.client.query(
      'update payments set slip_verify_attempts = 5, slip_staff_calls = 4 where id = $1',
      [paymentId],
    );
    respond = () => ({ body: answer('200404', currentAmountBaht) });
    expect((await recheck(paymentId)).statusCode).toBe(200);
    expect((await row(order.id))?.slip_verify_attempts).toBe(6);
    const refused = await recheck(paymentId);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'SLIP_RECHECK_LIMIT' });
    expect(calls).toHaveLength(2);
  });

  test('the daily cap holds: refused with the old verdict kept and no call', async () => {
    // Today's calls so far, plus the one this test makes, are the whole day's allowance.
    const used = (
      await h.client.query<{ n: number }>(
        "select coalesce(sum(n), 0)::int as n from slip_verify_daily where kind = 'calls' and business_date = '2028-02-01'",
      )
    ).rows[0]?.n;
    dailyCap = (used ?? 0) + 1;
    checker = buildChecker();
    installSlipChecker(checker);
    const { order, paymentId } = await checked('200404');
    expect(calls).toHaveLength(1);
    const refused = await recheck(paymentId);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'SLIP2GO_DAILY_CAP' });
    expect(calls).toHaveLength(1);
    expect((await row(order.id))?.slip_verify).toBe('not_found');
  });

  test('refused (409) for a payment that is not claimed, has no slip, or is still being checked', async () => {
    const done = await checked('200404');
    await h.client.query("update payments set status = 'cancelled' where id = $1", [
      done.paymentId,
    ]);
    expect((await recheck(done.paymentId)).json()).toMatchObject({ code: 'PAYMENT_NOT_CLAIMED' });

    const bare = await start();
    await call('POST', `/v1/app/orders/${bare.order.id}/claim`, bare.token);
    const bareId = (await row(bare.order.id))?.id ?? '';
    const noSlip = await recheck(bareId);
    expect(noSlip.statusCode).toBe(409);
    expect(noSlip.json()).toMatchObject({ code: 'NO_SLIP' });

    const running = await checked('200404', 3);
    await h.client.query("update payments set slip_verify = 'pending' where id = $1", [
      running.paymentId,
    ]);
    const busy = await recheck(running.paymentId);
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ code: 'SLIP_CHECK_RUNNING' });
    await h.client.query("update payments set slip_verify = 'unchecked' where id = $1", [
      running.paymentId,
    ]);
    expect(calls).toHaveLength(2);
  });

  test('with no bank check switched on there is nothing to run again: 409', async () => {
    const { paymentId } = await checked('200404');
    installSlipChecker(null);
    const res = await recheck(paymentId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'SLIP_VERIFIER_OFF' });
  });

  test('the payments view lists claimed payments that have no slip picture', async () => {
    const withSlip = await checked('200404');
    const bare = await start();
    await call('POST', `/v1/app/orders/${bare.order.id}/claim`, bare.token);
    const bareId = (await row(bare.order.id))?.id ?? '';
    const bareView = await call('GET', `/v1/orders/${bare.order.id}/payments`, staffToken);
    expect(bareView.json().claimedWithoutSlipPaymentIds).toEqual([bareId]);
    const slipView = await call('GET', `/v1/orders/${withSlip.order.id}/payments`, staffToken);
    expect(slipView.json().claimedWithoutSlipPaymentIds).toEqual([]);
  });
});

// ---------- QA fixes, cooldown, block and flag (owner decisions) ----------

const send = (
  method: 'GET' | 'POST',
  url: string,
  token: string | undefined,
  body?: Record<string, unknown>,
) =>
  h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body }),
    remoteAddress: h.nextIp(),
  });

interface SlipState {
  id: string;
  status: string;
  slip_verify: string | null;
  slip_verified_at: string | null;
  slip_verify_attempts: number;
  slip_image_hash: string | null;
  slip_invalid_count: number;
  slip_invalid_at: string | null;
  slip_blocked_at: string | null;
  slip_block_reason: string | null;
  slip_reviewed_at: string | null;
}
/** Every payment of the order, oldest first, with the slip fields the new rules use. */
const payments = async (orderId: string) =>
  (
    await h.client.query<SlipState>(
      `select id, status, slip_verify, slip_verified_at, slip_verify_attempts, slip_image_hash,
              slip_invalid_count, slip_invalid_at, slip_blocked_at, slip_block_reason, slip_reviewed_at
         from payments where order_id = $1 order by rev`,
      [orderId],
    )
  ).rows;
const flagOf = async (orderId: string) =>
  (
    await h.client.query<{
      id: string;
      slip_flag_at: string | null;
      slip_flag_reason: string | null;
      slip_flag_count: number;
    }>(
      `select c.id, c.slip_flag_at, c.slip_flag_reason, c.slip_flag_count
         from customers c join orders o on o.customer_id = c.id where o.id = $1`,
      [orderId],
    )
  ).rows[0];
const ms = (iso: string | null) => new Date(iso ?? 'invalid').getTime();
const seconds = (n: number) => n * 1000;
/** A transfer nobody has used yet: the QR the local reader finds and the reference Slip2Go answers with. */
let transferNo = 0;
function freshTransfer(): string {
  transferNo += 1;
  localQr = {
    qr: { sendingBank: '014', transRef: `FRESHREF${String(transferNo).padStart(7, '0')}` },
    raw: RAW_QR,
  };
  return String(900_000 + transferNo).padStart(25, '0');
}
const NEUTRAL_LEAK =
  /fraud|flag|suspect|fake|forg|ปลอม|200500|verdict|verify|blocked_at|slipBlockedAt|invalid_count|reason/i;

describe('QA fixes in the staff recheck', () => {
  beforeEach(() => {
    dailyCap = 10_000;
    checker = buildChecker();
    installSlipChecker(checker);
  });
  const recheckOf = (paymentId: string, token = staffToken) =>
    send('POST', `/v1/payments/${paymentId}/slip-recheck`, token, {
      clientRequestId: crypto.randomUUID(),
    });
  async function checkedAs(code: string) {
    const placed = await start();
    respond = () => ({ body: answer(code, currentAmountBaht) });
    await upload(placed.token, placed.order.id, picture(1));
    await checker.idle();
    return { ...placed, paymentId: (await row(placed.order.id))?.id ?? '' };
  }

  test('a refusal that comes late, inside the checker, keeps the verdict staff had (the cap)', async () => {
    const used = (
      await h.client.query<{ n: number }>(
        "select coalesce(sum(n), 0)::int as n from slip_verify_daily where kind = 'calls' and business_date = '2028-02-01'",
      )
    ).rows[0]?.n;
    dailyCap = (used ?? 0) + 1;
    // The route's own pre-check says yes; only the checker's last look at the cap says no.
    checker = { ...buildChecker(), recheckBlocker: async () => null };
    installSlipChecker(checker);
    const { order, paymentId } = await checkedAs('200404');
    const before = (await payments(order.id))[0];
    expect(before?.slip_verify).toBe('not_found');
    expect(calls).toHaveLength(1);

    const res = await recheckOf(paymentId);
    expect(res.statusCode).toBe(200);
    expect(res.json().slipChecks[0].verify.verdict).toBe('not_found');
    expect(calls).toHaveLength(1);
    const after = (await payments(order.id))[0];
    expect(after?.slip_verify).toBe('not_found');
    expect(ms(after?.slip_verified_at ?? null)).toBe(ms(before?.slip_verified_at ?? null));
    expect(after?.slip_verify_attempts).toBe(before?.slip_verify_attempts);
  });

  test('the same when the attempts run out between the route and the checker', async () => {
    checker = { ...buildChecker(), recheckBlocker: async () => null };
    installSlipChecker(checker);
    const { order, paymentId } = await checkedAs('200402');
    await h.client.query('update payments set slip_verify_attempts = 6 where id = $1', [paymentId]);
    const res = await recheckOf(paymentId);
    expect(res.statusCode).toBe(200);
    expect(res.json().slipChecks[0].verify.verdict).toBe('amount_mismatch');
    expect(calls).toHaveLength(1);
    expect((await payments(order.id))[0]?.slip_verify).toBe('amount_mismatch');
  });

  test('a verdict that is already valid cannot be rechecked: 409, no call, nothing written', async () => {
    const { order, paymentId } = await checkedAs('200200');
    expect((await payments(order.id))[0]?.slip_verify).toBe('valid');
    const before = await row(order.id);
    const res = await recheckOf(paymentId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'SLIP_ALREADY_VALID' });
    expect(calls).toHaveLength(1);
    expect(await row(order.id)).toEqual(before);
  });
});

describe('the slip cooldown', () => {
  beforeEach(() => {
    dailyCap = 10_000;
    checker = buildChecker();
    installSlipChecker(checker);
  });

  test.each([
    ['200401', 1],
    ['200402', 1],
    ['200403', 1],
    ['200404', 1],
    ['200200', 0],
    ['200000', 0],
    ['200500', 0],
    ['200501', 0],
    ['401004', 0],
  ])('code %s adds %i to the count of invalid results', async (code, added) => {
    const before = alertsOf('slip.fraud_blocked').length;
    const { token, order } = await start();
    respond = () => ({ body: answer(code, currentAmountBaht) });
    await upload(token, order.id, picture(1));
    await checker.idle();
    const [payment] = await payments(order.id);
    expect(payment?.slip_invalid_count).toBe(added);
    expect(payment?.slip_invalid_at === null).toBe(added === 0);
    // Only the fake-slip answer raises the owner alert; every other verdict stays quiet.
    expect(alertsOf('slip.fraud_blocked')).toHaveLength(before + (code === '200500' ? 1 : 0));
  });

  test('a call that failed (network) is no invalid result', async () => {
    const { token, order } = await start();
    respond = () => new Error('connection reset');
    await upload(token, order.id, picture(1));
    await checker.idle();
    expect((await payments(order.id))[0]?.slip_invalid_count).toBe(0);
  });

  /** Three invalid slips on one order; returns the clock time of the last result. */
  async function threeInvalid() {
    const placed = await start();
    respond = () => ({ body: answer('200404', currentAmountBaht) });
    for (const fill of [1, 2, 3]) {
      expect((await upload(placed.token, placed.order.id, picture(fill))).statusCode).toBe(200);
      await checker.idle();
      if (fill < 3) h.clock.advanceSeconds(10);
    }
    expect((await payments(placed.order.id))[0]).toMatchObject({ slip_invalid_count: 3 });
    return { ...placed, lastAt: h.clock.now().getTime() };
  }

  test('after three invalid results the next slip waits until 5 minutes after the LAST one, exactly', async () => {
    const { token, order, lastAt } = await threeInvalid();
    const hashBefore = (await payments(order.id))[0]?.slip_image_hash;

    const refused = await upload(token, order.id, picture(4));
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({
      code: 'SLIP_COOLDOWN',
      details: { retryAfterSeconds: 300 },
    });
    expect(refused.body).not.toMatch(NEUTRAL_LEAK);
    // Nothing was written for the refused picture, and the service was not called for it.
    expect((await payments(order.id))[0]?.slip_image_hash).toBe(hashBefore);
    expect(calls).toHaveLength(3);

    // The customer's own view says how long, and keeps the slip action.
    h.clock.set(new Date(lastAt + seconds(120)).toISOString());
    const mine = (await send('GET', `/v1/app/orders/${order.id}`, token)).json();
    expect(mine.slipRetryAfterSeconds).toBe(180);
    expect(mine.actions.attachSlip).toBe(true);
    expect(mine.slipBlocked).toBeUndefined();

    h.clock.set(new Date(lastAt + seconds(299)).toISOString());
    const late = await upload(token, order.id, picture(4));
    expect(late.statusCode).toBe(429);
    expect(late.json().details).toEqual({ retryAfterSeconds: 1 });

    // Exactly five minutes after the last invalid result: accepted.
    h.clock.set(new Date(lastAt + seconds(300)).toISOString());
    expect((await send('GET', `/v1/app/orders/${order.id}`, token)).json()).not.toHaveProperty(
      'slipRetryAfterSeconds',
    );
    // The three pictures used the payment's 3 check cycles; this test is about the wait, so give one more.
    await h.client.query('update payments set slip_verify_cycles = 2 where order_id = $1', [
      order.id,
    ]);
    const open = await upload(token, order.id, picture(4));
    expect(open.statusCode).toBe(200);
    await checker.idle();
    // It was invalid again: the wait starts over from that result.
    const [after] = await payments(order.id);
    expect(after?.slip_invalid_count).toBe(4);
    expect(ms(after?.slip_invalid_at ?? null)).toBe(lastAt + seconds(300));
    expect((await upload(token, order.id, picture(5))).statusCode).toBe(429);
  });

  test('"โอนแล้ว" with no slip is never held back, and neither is the staff recheck; a rechecked failure does not count', async () => {
    const { token, order } = await threeInvalid();
    const [payment] = await payments(order.id);
    expect((await send('POST', `/v1/app/orders/${order.id}/claim`, token)).statusCode).toBe(200);
    const recheck = await send('POST', `/v1/payments/${payment?.id}/slip-recheck`, staffToken, {
      clientRequestId: crypto.randomUUID(),
    });
    expect(recheck.statusCode).toBe(200);
    expect(calls).toHaveLength(4);
    expect((await payments(order.id))[0]).toMatchObject({
      slip_invalid_count: 3,
      slip_invalid_at: payment?.slip_invalid_at,
    });
  });

  test('a claim that is still pending (no slip yet) is not blocked by the cooldown either', async () => {
    const { token, order } = await start();
    await h.client.query(
      "update payments set slip_invalid_count = 5, slip_invalid_at = $2 where order_id = $1 and status = 'pending'",
      [order.id, h.clock.now().toISOString()],
    );
    expect((await upload(token, order.id, picture(1))).statusCode).toBe(429);
    const claim = await send('POST', `/v1/app/orders/${order.id}/claim`, token);
    expect(claim.statusCode).toBe(200);
    expect(claim.json().payment.status).toBe('claimed');
  });

  test('the cooldown belongs to the order: it survives a staff reject and the new payment; a new order starts clean', async () => {
    const { token, order, lastAt } = await threeInvalid();
    const [first] = await payments(order.id);
    const cancelled = await send('POST', `/v1/payments/${first?.id}/cancel-claimed`, staffToken, {
      reason: 'ไม่พบยอดเงินเข้า',
    });
    expect(cancelled.statusCode).toBe(200);

    // Rejected state: the customer's view still says how long to wait.
    h.clock.set(new Date(lastAt + seconds(100)).toISOString());
    const rejected = (await send('GET', `/v1/app/orders/${order.id}`, token)).json();
    expect(rejected.slipRetryAfterSeconds).toBe(200);
    expect(rejected.slipBlocked).toBeUndefined();

    // The customer pays again: the new payment is still in the cooldown, for the remaining time.
    expect((await send('POST', `/v1/app/orders/${order.id}/claim`, token)).statusCode).toBe(200);
    expect((await payments(order.id)).length).toBe(2);
    const refused = await upload(token, order.id, picture(4));
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({
      code: 'SLIP_COOLDOWN',
      details: { retryAfterSeconds: 200 },
    });
    expect(calls).toHaveLength(3);
    h.clock.set(new Date(lastAt + seconds(300)).toISOString());
    expect((await upload(token, order.id, picture(4))).statusCode).toBe(200);

    // Another order of the same customer starts clean.
    const next = await place(token);
    expect((await send('GET', `/v1/app/orders/${next.id}`, token)).json()).not.toHaveProperty(
      'slipRetryAfterSeconds',
    );
    expect((await upload(token, next.id, picture(7))).statusCode).toBe(200);
    expect(order.id).not.toBe(next.id);
  });
});

describe('a "fake slip" answer (200500)', () => {
  beforeEach(() => {
    dailyCap = 10_000;
    checker = buildChecker();
    installSlipChecker(checker);
  });
  const claimOf = (token: string, orderId: string) =>
    send('POST', `/v1/app/orders/${orderId}/claim`, token);

  async function fraudOrder(fill = 1) {
    const placed = await start();
    respond = () => ({ body: answer('200500', currentAmountBaht) });
    const res = await upload(placed.token, placed.order.id, picture(fill));
    await checker.idle();
    return { ...placed, res, paymentId: (await row(placed.order.id))?.id ?? '' };
  }

  test('blocks the order, flags the customer, writes an audit row, and the payment stays claimed', async () => {
    const { order, paymentId } = await fraudOrder();
    const [payment] = await payments(order.id);
    expect(payment).toMatchObject({
      status: 'claimed',
      slip_verify: 'fraud',
      slip_block_reason: 'fraud',
      slip_invalid_count: 0,
    });
    expect(payment?.slip_blocked_at).not.toBeNull();
    const flag = await flagOf(order.id);
    expect(flag).toMatchObject({ slip_flag_reason: 'fraud', slip_flag_count: 1 });
    expect(flag?.slip_flag_at).not.toBeNull();
    const audit = (await h.auditRows(paymentId)).filter((a) => a.action === 'payment.slip_blocked');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'system' });
    expect(audit[0]?.after).toEqual({ reason: 'fraud', code: '200500' });
  });

  test('the owner is alerted once per block, with the order number and no personal data', async () => {
    const before = alertsOf('slip.fraud_blocked').length;
    const { order, paymentId } = await fraudOrder();
    const alerts = alertsOf('slip.fraud_blocked').slice(before);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'warn',
      subject: { orderId: order.id, paymentId },
      orderNo: order.orderNo,
    });
    const text = JSON.stringify(alerts[0]);
    expect(text).not.toMatch(/200500|slip2go|lineUserId|displayName|phone|U[0-9a-f]{32}/i);
    // A staff recheck of the same block raises nothing new.
    const res = await send('POST', `/v1/payments/${paymentId}/slip-recheck`, staffToken, {
      clientRequestId: crypto.randomUUID(),
    });
    expect(res.statusCode).toBe(200);
    expect(alertsOf('slip.fraud_blocked')).toHaveLength(before + 1);
  });

  test('a second "fake" answer for the same block does not raise the flag again', async () => {
    const { order, paymentId } = await fraudOrder();
    const res = await send('POST', `/v1/payments/${paymentId}/slip-recheck`, staffToken, {
      clientRequestId: crypto.randomUUID(),
    });
    expect(res.statusCode).toBe(200);
    expect((await flagOf(order.id))?.slip_flag_count).toBe(1);
  });

  test('more slips for the order are refused with a neutral message; "โอนแล้ว" still works', async () => {
    const { token, order } = await fraudOrder();
    const hash = (await payments(order.id))[0]?.slip_image_hash;
    const refused = await upload(token, order.id, picture(2));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'SLIP_BLOCKED' });
    expect(refused.body).not.toMatch(NEUTRAL_LEAK);
    expect((await payments(order.id))[0]?.slip_image_hash).toBe(hash);
    expect(calls).toHaveLength(1);

    const mine = (await send('GET', `/v1/app/orders/${order.id}`, token)).json();
    expect(mine.slipBlocked).toBe(true);
    expect(mine.actions.attachSlip).toBe(false);
    expect(mine.payment.status).toBe('claimed');
    expect((await claimOf(token, order.id)).statusCode).toBe(200);
  });

  test('a pending payment of a blocked order can still be claimed; only the slip is refused', async () => {
    const { token, order } = await start();
    await h.client.query(
      "update payments set slip_blocked_at = now(), slip_block_reason = 'fraud' where order_id = $1",
      [order.id],
    );
    expect((await upload(token, order.id, picture(1))).statusCode).toBe(409);
    const claim = await claimOf(token, order.id);
    expect(claim.statusCode).toBe(200);
    expect(claim.json().payment.status).toBe('claimed');
  });

  test('the block belongs to the order: it survives a rejected claim and the new payment', async () => {
    const { token, order, paymentId } = await fraudOrder();
    const cancelled = await send('POST', `/v1/payments/${paymentId}/cancel-claimed`, staffToken, {
      reason: 'ไม่พบยอดเงินเข้า',
    });
    expect(cancelled.statusCode).toBe(200);
    // The customer pays again: a fresh payment is made when they claim, and still no slip.
    const again = await claimOf(token, order.id);
    expect(again.statusCode).toBe(200);
    expect((await payments(order.id)).length).toBe(2);
    expect((await upload(token, order.id, picture(2))).json()).toMatchObject({
      code: 'SLIP_BLOCKED',
    });
    expect((await send('GET', `/v1/app/orders/${order.id}`, token)).json().actions.attachSlip).toBe(
      false,
    );
  });

  test('a NEW order of the same customer starts clean', async () => {
    const { token } = await fraudOrder();
    const next = await place(token);
    const view = (await send('GET', `/v1/app/orders/${next.id}`, token)).json();
    expect(view.slipBlocked).toBeUndefined();
    expect(view.actions.attachSlip).toBe(true);
    respond = () => ({ body: answer('200200', currentAmountBaht) });
    expect((await upload(token, next.id, picture(9))).statusCode).toBe(200);
  });

  test('staff see the block and the flag; the customer, sync and the payment itself do not carry them', async () => {
    const { token, order, res, paymentId } = await fraudOrder();
    const staff = await send('GET', `/v1/orders/${order.id}/payments`, staffToken);
    const body = staff.json();
    expect(body.slipBlocks).toEqual([{ paymentId, at: expect.any(String), reason: 'fraud' }]);
    expect(body.customerSlipFlag).toMatchObject({ reason: 'fraud', count: 1 });
    expect(body.slipChecks[0].verify.verdict).toBe('fraud');
    expect(JSON.stringify(body.payments)).not.toMatch(/slip|flag|block/i);

    // Every answer the customer can get, in every shape.
    const bodies = [
      res.body,
      (await send('GET', `/v1/app/orders/${order.id}`, token)).body,
      (await send('GET', '/v1/app/orders', token)).body,
      (await claimOf(token, order.id)).body,
      (await upload(token, order.id, picture(3))).body,
    ];
    for (const text of bodies) expect(text).not.toMatch(NEUTRAL_LEAK);

    const sync = await send('GET', '/v1/sync', staffToken);
    expect(sync.statusCode).toBe(200);
    expect(sync.body).not.toMatch(/slip_?flag|slip_?block|slipBlocked|slipInvalid|slipReviewed/i);
  });

  test('a customer flag is read by staff on its own endpoint (customer.view), 404 for nobody', async () => {
    const { order } = await fraudOrder();
    const id = (await flagOf(order.id))?.id ?? '';
    const res = await send('GET', `/v1/customers/${id}/slip-flag`, staffToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().slipFlag).toMatchObject({ reason: 'fraud', count: 1 });
    expect((await send('GET', `/v1/customers/${id}/slip-flag`, undefined)).statusCode).toBe(401);
    const kitchenDevice = await h.newDevice();
    const kitchen = await h.newStaff('kitchen', '4821');
    const kitchenToken = await h.pinSession(kitchenDevice.token, kitchen.id, '4821');
    expect((await send('GET', `/v1/customers/${id}/slip-flag`, kitchenToken)).statusCode).toBe(403);
    expect(
      (await send('GET', `/v1/customers/${crypto.randomUUID()}/slip-flag`, staffToken)).statusCode,
    ).toBe(404);
    const clean = await start();
    const cleanId = (await flagOf(clean.order.id))?.id ?? '';
    expect((await send('GET', `/v1/customers/${cleanId}/slip-flag`, staffToken)).json()).toEqual({
      slipFlag: null,
    });
  });

  describe('the automatic confirmation', () => {
    beforeEach(() => {
      autoConfirm = { maxSatang: 100_000 };
      checker = buildChecker();
      installSlipChecker(checker);
    });
    const valid = () => {
      respond = () => ({ body: answer('200200', currentAmountBaht) });
    };
    const statusOf = async (orderId: string) => (await payments(orderId)).at(-1)?.status;

    test('never fires for a blocked payment, even when a recheck comes back valid', async () => {
      const { order, paymentId } = await fraudOrder();
      valid();
      const res = await send('POST', `/v1/payments/${paymentId}/slip-recheck`, staffToken, {
        clientRequestId: crypto.randomUUID(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().slipChecks[0].verify.verdict).toBe('valid');
      expect(await statusOf(order.id)).toBe('claimed');
    });

    test("never fires for a flagged customer's other orders; an unflagged customer still confirms", async () => {
      const flagged = await fraudOrder();
      const next = await place(flagged.token);
      valid();
      expect((await upload(flagged.token, next.id, picture(8))).statusCode).toBe(200);
      await checker.idle();
      expect(await statusOf(next.id)).toBe('claimed');
      expect((await payments(next.id))[0]?.slip_verify).toBe('valid');

      const clean = await start();
      const transRef = freshTransfer();
      respond = () => ({ body: answer('200200', currentAmountBaht, { transRef }) });
      await upload(clean.token, clean.order.id, picture(9));
      await checker.idle();
      expect(await statusOf(clean.order.id)).toBe('confirmed');
    });
  });
});

describe('the owner lifts a block or a flag', () => {
  const crid = () => crypto.randomUUID();
  // A one-time code cannot be used twice, so each owner sign-in gets a clock of its own.
  let owners = 0;
  const later = async () => {
    h.clock.set(new Date(Date.UTC(2028, 1, 1, 8, 20, 0) + ++owners * 200_000).toISOString());
    return h.steppedUpOwner(ownerFixture);
  };
  const clearBlock = (
    paymentId: string,
    token: string | undefined,
    body?: Record<string, unknown>,
  ) => send('POST', `/v1/payments/${paymentId}/slip-block/clear`, token, body);
  const clearFlag = (
    customerId: string,
    token: string | undefined,
    body?: Record<string, unknown>,
  ) => send('POST', `/v1/customers/${customerId}/slip-flag/clear`, token, body);

  async function fraudOrder(fill = 1) {
    const placed = await start();
    respond = () => ({ body: answer('200500', currentAmountBaht) });
    await upload(placed.token, placed.order.id, picture(fill));
    await checker.idle();
    const paymentId = (await row(placed.order.id))?.id ?? '';
    const customerId = (await flagOf(placed.order.id))?.id ?? '';
    return { ...placed, paymentId, customerId };
  }
  beforeEach(() => {
    dailyCap = 10_000;
    checker = buildChecker();
    installSlipChecker(checker);
  });

  test('who may: no session 401; manager, cashier and kitchen 403 even after step-up; the owner needs a fresh step-up', async () => {
    const { paymentId, customerId } = await fraudOrder();
    const body = { clientRequestId: crid(), reason: 'ตรวจกับธนาคารแล้ว' };
    expect((await clearBlock(paymentId, undefined, body)).statusCode).toBe(401);
    expect((await clearFlag(customerId, undefined, body)).statusCode).toBe(401);
    const device = await h.newDevice();
    for (const role of ['manager', 'cashier', 'kitchen'] as const) {
      const who = await h.newStaff(role, '4821');
      const token = await h.pinSession(device.token, who.id, '4821');
      await send('POST', '/v1/auth/step-up', token, { pin: '4821' });
      expect((await clearBlock(paymentId, token, body)).statusCode, role).toBe(403);
      expect((await clearFlag(customerId, token, body)).statusCode, role).toBe(403);
    }
    h.clock.set(new Date(Date.UTC(2028, 1, 1, 8, 20, 0) + ++owners * 200_000).toISOString());
    const plain = await h.ownerSession(ownerFixture);
    for (const res of [
      await clearBlock(paymentId, plain, body),
      await clearFlag(customerId, plain, body),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    }
    expect((await payments((await orderOf(paymentId)) ?? ''))[0]?.slip_blocked_at).not.toBeNull();
    expect(
      (await h.auditRows(paymentId)).some((a) => a.action === 'payment.slip_block_clear'),
    ).toBe(false);
  });

  const orderOf = async (paymentId: string) =>
    (
      await h.client.query<{ order_id: string }>('select order_id from payments where id = $1', [
        paymentId,
      ])
    ).rows[0]?.order_id;

  test('a reason is required (1 to 200 characters) and the request id too', async () => {
    const { paymentId, customerId } = await fraudOrder();
    const owner = await later();
    const bad: Record<string, unknown>[] = [
      {},
      { clientRequestId: crid() },
      { clientRequestId: crid(), reason: '' },
      { clientRequestId: crid(), reason: '   ' },
      { clientRequestId: crid(), reason: 'x'.repeat(201) },
      { reason: 'ok' },
      { clientRequestId: crid(), reason: 'ok', extra: 1 },
    ];
    for (const body of bad) {
      expect((await clearBlock(paymentId, owner, body)).statusCode).toBe(400);
      expect((await clearFlag(customerId, owner, body)).statusCode).toBe(400);
    }
    expect((await payments((await orderOf(paymentId)) ?? ''))[0]?.slip_blocked_at).not.toBeNull();
    const edge = await clearBlock(paymentId, owner, {
      clientRequestId: crid(),
      reason: 'x'.repeat(200),
    });
    expect(edge.statusCode).toBe(200);
  });

  test('lifting the block: reviewed, back to unchecked, audited with the reason, owner alerted, customer can send a slip again, staff confirm as usual', async () => {
    const { token, order, paymentId, customerId } = await fraudOrder();
    const owner = await later();
    const marker = h.events.length;
    const alertsBefore = h.alerts.length;
    const reason = 'ดูสลิปแล้ว โอนจริง';
    const id = crid();

    const res = await clearBlock(paymentId, owner, { clientRequestId: id, reason });
    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view.slipBlocks).toBeUndefined();
    expect(view.slipChecks[0].verify).toMatchObject({ verdict: 'unchecked' });
    expect(typeof view.slipChecks[0].verify.reviewedAt).toBe('string');
    // The customer's flag is its own action: untouched here.
    expect(view.customerSlipFlag).toMatchObject({ count: 1 });

    const [payment] = await payments(order.id);
    expect(payment).toMatchObject({
      slip_blocked_at: null,
      slip_block_reason: null,
      slip_verify: 'unchecked',
      status: 'claimed',
    });
    expect(payment?.slip_reviewed_at).not.toBeNull();

    const audit = (await h.auditRows(paymentId)).filter(
      (a) => a.action === 'payment.slip_block_clear',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'staff', actorId: ownerId });
    expect(audit[0]?.after).toEqual({ clientRequestId: id, reason });
    const alerts = h.alerts
      .slice(alertsBefore)
      .filter((a) => a.kind === 'payment.slip_block_cleared');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'warn', staffId: ownerId });
    expect(JSON.stringify(alerts[0])).not.toContain(reason);
    expect(
      h.events.slice(marker).some((e) => e.type === 'payment.upserted' && e.id === paymentId),
    ).toBe(true);

    // The same picture cannot be sent to the bank again: it would only raise the block anew.
    const callsBefore = calls.length;
    const again = await send('POST', `/v1/payments/${paymentId}/slip-recheck`, staffToken, {
      clientRequestId: crid(),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'SLIP_REVIEWED' });
    expect(calls).toHaveLength(callsBefore);

    // The customer may send a slip again, and the customer's view is clean.
    const mine = (await send('GET', `/v1/app/orders/${order.id}`, token)).json();
    expect(mine.slipBlocked).toBeUndefined();
    expect(mine.actions.attachSlip).toBe(true);
    respond = () => ({ body: answer('200200', currentAmountBaht) });
    expect((await upload(token, order.id, picture(2))).statusCode).toBe(200);
    await checker.idle();
    expect(await flagOf(order.id)).toMatchObject({ id: customerId, slip_flag_count: 1 });
    // The owner's review was of the old picture: the new one carries no "reviewed" mark.
    const fresh = await send('GET', `/v1/orders/${order.id}/payments`, staffToken);
    expect(fresh.json().slipChecks[0].verify.verdict).toBe('valid');
    expect(fresh.json().slipChecks[0].verify.reviewedAt).toBeUndefined();
    expect((await payments(order.id))[0]?.slip_reviewed_at).toBeNull();

    // Staff confirm normally.
    const confirm = await send('POST', `/v1/payments/${paymentId}/confirm`, staffToken, {});
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().payment.status).toBe('confirmed');
  });

  test('the same request id again: 200, one audit row, one alert; a header that disagrees is 400', async () => {
    const { paymentId } = await fraudOrder();
    const owner = await later();
    const id = crid();
    const alertsBefore = h.alerts.length;
    expect(
      (await clearBlock(paymentId, owner, { clientRequestId: id, reason: 'ok' })).statusCode,
    ).toBe(200);
    const again = await clearBlock(paymentId, owner, { clientRequestId: id, reason: 'ok' });
    expect(again.statusCode).toBe(200);
    expect(
      (await h.auditRows(paymentId)).filter((a) => a.action === 'payment.slip_block_clear'),
    ).toHaveLength(1);
    expect(
      h.alerts.slice(alertsBefore).filter((a) => a.kind === 'payment.slip_block_cleared'),
    ).toHaveLength(1);

    const mismatch = await h.app.inject({
      method: 'POST',
      url: `/v1/payments/${paymentId}/slip-block/clear`,
      headers: { authorization: `Bearer ${owner}`, 'idempotency-key': crid() },
      payload: { clientRequestId: crid(), reason: 'ok' },
      remoteAddress: h.nextIp(),
    });
    expect(mismatch.statusCode).toBe(400);

    // The same id in capitals on both sides is the same id.
    const upper = crid().toUpperCase();
    const { customerId } = await fraudOrder(5);
    const owner2 = await later();
    const caps = await h.app.inject({
      method: 'POST',
      url: `/v1/customers/${customerId}/slip-flag/clear`,
      headers: { authorization: `Bearer ${owner2}`, 'idempotency-key': upper },
      payload: { clientRequestId: upper, reason: 'ok' },
      remoteAddress: h.nextIp(),
    });
    expect(caps.statusCode).toBe(200);
  });

  test('an order that is not blocked answers 409, an unknown payment 404', async () => {
    const clean = await start();
    const paymentId = (await row(clean.order.id))?.id ?? '';
    const owner = await later();
    const body = { clientRequestId: crid(), reason: 'ok' };
    const res = await clearBlock(paymentId, owner, body);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'SLIP_NOT_BLOCKED' });
    expect((await clearBlock(crypto.randomUUID(), owner, body)).statusCode).toBe(404);
  });

  test('clearing the flag: gone from staff views, the count and the history kept, audited with the reason, owner alerted', async () => {
    const { order, paymentId, customerId } = await fraudOrder();
    const owner = await later();
    const alertsBefore = h.alerts.length;
    const reason = 'ลูกค้าแสดงหลักฐานการโอน';
    const id = crid();
    const res = await clearFlag(customerId, owner, { clientRequestId: id, reason });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ slipFlag: null });

    expect(await flagOf(order.id)).toMatchObject({
      slip_flag_at: null,
      slip_flag_reason: null,
      slip_flag_count: 1,
    });
    expect(
      (await send('GET', `/v1/orders/${order.id}/payments`, staffToken)).json().customerSlipFlag,
    ).toBeUndefined();
    // The block of the order is a separate thing and stays until the owner lifts it too.
    expect((await payments(order.id))[0]?.slip_blocked_at).not.toBeNull();
    expect(
      (await send('GET', `/v1/orders/${order.id}/payments`, staffToken)).json().slipBlocks,
    ).toHaveLength(1);

    const audit = (await h.auditRows(customerId)).filter(
      (a) => a.action === 'customer.slip_flag_clear',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'staff', actorId: ownerId });
    expect(audit[0]?.after).toEqual({ clientRequestId: id, reason });
    // The raise is still in the history.
    expect((await h.auditRows(paymentId)).some((a) => a.action === 'payment.slip_blocked')).toBe(
      true,
    );
    const alerts = h.alerts
      .slice(alertsBefore)
      .filter((a) => a.kind === 'customer.slip_flag_cleared');
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts[0])).not.toContain(reason);

    // Same request again, and a customer with no flag: 200, nothing more written.
    expect((await clearFlag(customerId, owner, { clientRequestId: id, reason })).statusCode).toBe(
      200,
    );
    expect(
      (await clearFlag(customerId, owner, { clientRequestId: crid(), reason })).statusCode,
    ).toBe(200);
    expect(
      (await h.auditRows(customerId)).filter((a) => a.action === 'customer.slip_flag_clear'),
    ).toHaveLength(1);
    expect(
      (await clearFlag(crypto.randomUUID(), owner, { clientRequestId: crid(), reason })).statusCode,
    ).toBe(404);
  });

  test('after the flag is cleared (and the block lifted) the automatic confirmation works for that customer again', async () => {
    autoConfirm = { maxSatang: 100_000 };
    checker = buildChecker();
    installSlipChecker(checker);
    const { token, paymentId, customerId } = await fraudOrder();
    const owner = await later();
    expect(
      (await clearBlock(paymentId, owner, { clientRequestId: crid(), reason: 'ok' })).statusCode,
    ).toBe(200);
    expect(
      (await clearFlag(customerId, owner, { clientRequestId: crid(), reason: 'ok' })).statusCode,
    ).toBe(200);
    const next = await place(token);
    const transRef = freshTransfer();
    respond = () => ({ body: answer('200200', currentAmountBaht, { transRef }) });
    await upload(token, next.id, picture(6));
    await checker.idle();
    expect((await payments(next.id)).at(-1)?.status).toBe('confirmed');
  });
});

describe('a slow bank: "not found" inside the grace window is not final', () => {
  beforeEach(() => {
    graceSeconds = 300;
    dailyCap = 10_000;
    checker = buildChecker();
    installSlipChecker(checker);
  });
  const notFound = () => ({ body: answer('200404', currentAmountBaht) });
  async function sendAt404(fill = 1) {
    const placed = await start();
    respond = notFound;
    await upload(placed.token, placed.order.id, picture(fill));
    await checker.idle();
    return placed;
  }

  test('a 404 right after the upload stays pending: no cooldown count, no final verdict, one call', async () => {
    const { order } = await sendAt404();
    expect(await row(order.id)).toMatchObject({
      slip_verify: 'pending',
      // The marker that this picture is in its grace budget (6 calls), not the 3 of an error.
      slip_verify_code: '200404',
      slip_verify_attempts: 1,
      status: 'claimed',
    });
    const [payment] = await payments(order.id);
    expect(payment).toMatchObject({ slip_invalid_count: 0, slip_invalid_at: null });
    expect(payment?.slip_verified_at).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('the sweep does not call again before the gap, and calls once after it (no busy loop)', async () => {
    const { order } = await sendAt404();
    for (let i = 0; i < 3; i++) {
      await checker.sweep();
      await checker.idle();
    }
    expect(calls).toHaveLength(1);
    h.clock.advanceSeconds(29);
    await checker.sweep();
    await checker.idle();
    expect(calls).toHaveLength(1);
    h.clock.advanceSeconds(1);
    await checker.sweep();
    await checker.idle();
    expect(calls).toHaveLength(2);
    expect((await row(order.id))?.slip_verify).toBe('pending');
  });

  test('a later 200200 takes the normal valid path, including the automatic confirmation', async () => {
    autoConfirm = { maxSatang: 100_000 };
    checker = buildChecker();
    installSlipChecker(checker);
    const { order } = await sendAt404();
    expect((await row(order.id))?.status).toBe('claimed');
    h.clock.advanceSeconds(30);
    respond = () => ({ body: answer('200200', currentAmountBaht) });
    await checker.sweep();
    await checker.idle();
    expect(await row(order.id)).toMatchObject({
      slip_verify: 'valid',
      slip_verify_code: '200200',
      status: 'confirmed',
    });
    expect((await payments(order.id))[0]?.slip_invalid_count).toBe(0);
    expect(calls).toHaveLength(2);
  });

  test('a 404 after the window is final not_found, counted once, and no more calls', async () => {
    const { order } = await sendAt404();
    h.clock.advanceSeconds(200);
    await checker.sweep();
    await checker.idle();
    expect((await payments(order.id))[0]).toMatchObject({ slip_verify: 'pending' });
    expect(calls).toHaveLength(2);
    h.clock.advanceSeconds(101);
    await checker.sweep();
    await checker.idle();
    const [payment] = await payments(order.id);
    expect(payment).toMatchObject({ slip_verify: 'not_found', slip_invalid_count: 1 });
    // The window had passed: the last 404 became final without spending another call.
    expect(calls).toHaveLength(2);
    for (let i = 0; i < 3; i++) {
      h.clock.advanceSeconds(60);
      await checker.sweep();
      await checker.idle();
    }
    expect(calls).toHaveLength(2);
    expect((await payments(order.id))[0]?.slip_invalid_count).toBe(1);
  });

  test('the live incident: 404 at 6, 50 and 100 seconds stays pending (the shared 3 no longer cut it)', async () => {
    const { order } = await sendAt404();
    h.clock.advanceSeconds(44);
    await checker.sweep();
    await checker.idle();
    h.clock.advanceSeconds(50);
    await checker.sweep();
    await checker.idle();
    expect(calls).toHaveLength(3);
    expect(await payments(order.id)).toMatchObject([
      { slip_verify: 'pending', slip_invalid_count: 0, slip_verify_attempts: 3 },
    ]);
    // A later 200200 still lands as valid.
    h.clock.advanceSeconds(40);
    respond = () => ({ body: answer('200200', currentAmountBaht) });
    await checker.sweep();
    await checker.idle();
    expect((await row(order.id))?.slip_verify).toBe('valid');
    expect(calls).toHaveLength(4);
  });

  test('6 calls inside the window use the grace budget up: the last 404 is final, counted once', async () => {
    const { order } = await sendAt404();
    for (let i = 0; i < 12; i++) {
      h.clock.advanceSeconds(30);
      await checker.sweep();
      await checker.idle();
    }
    expect(calls).toHaveLength(6);
    expect((await payments(order.id))[0]).toMatchObject({
      slip_verify: 'not_found',
      slip_invalid_count: 1,
      slip_verify_attempts: 6,
    });
  });

  test('errors keep the normal 3 attempts; a 404 after two errors still gets the grace budget', async () => {
    const placed = await start();
    respond = () => new Error('connection reset');
    await upload(placed.token, placed.order.id, picture(1));
    await checker.idle();
    await checker.sweep();
    await checker.idle();
    respond = notFound;
    await checker.sweep();
    await checker.idle();
    expect(await row(placed.order.id)).toMatchObject({
      slip_verify: 'pending',
      slip_verify_attempts: 3,
      slip_verify_code: '200404',
    });
    // Errors alone stop at 3.
    const other = await start();
    respond = () => new Error('connection reset');
    await upload(other.token, other.order.id, picture(2));
    for (let i = 0; i < 4; i++) {
      await checker.idle();
      await checker.sweep();
    }
    await checker.idle();
    expect(await row(other.order.id)).toMatchObject({
      slip_verify: 'unchecked',
      slip_verify_attempts: 3,
    });
  });

  test('errors inside the grace budget are bounded by its 6 calls and settle as unchecked', async () => {
    const { order } = await sendAt404();
    respond = () => new Error('connection reset');
    for (let i = 0; i < 10; i++) {
      h.clock.advanceSeconds(30);
      await checker.sweep();
      await checker.idle();
    }
    expect(calls).toHaveLength(6);
    expect(await row(order.id)).toMatchObject({
      slip_verify: 'unchecked',
      slip_verify_attempts: 6,
    });
  });

  describe('the same picture sent again', () => {
    /** A 404 that has become final (the window passed), then `gap` seconds on. */
    async function finalNotFound(gap: number) {
      const placed = await sendAt404();
      h.clock.advanceSeconds(301);
      await checker.sweep();
      await checker.idle();
      expect((await row(placed.order.id))?.slip_verify).toBe('not_found');
      h.clock.advanceSeconds(gap);
      return placed;
    }

    test('after 60 seconds it is a new check, and a later 200200 confirms by itself', async () => {
      autoConfirm = { maxSatang: 100_000 };
      checker = buildChecker();
      installSlipChecker(checker);
      const { token, order } = await finalNotFound(60);
      const before = calls.length;
      respond = () => ({ body: answer('200200', currentAmountBaht) });
      expect((await upload(token, order.id, picture(1))).statusCode).toBe(200);
      await checker.idle();
      expect(calls.length).toBe(before + 1);
      expect(await row(order.id)).toMatchObject({
        slip_verify: 'valid',
        slip_verify_attempts: 1,
        status: 'confirmed',
      });
      // The earlier final answer was counted once and the new result adds nothing.
      expect((await payments(order.id))[0]?.slip_invalid_count).toBe(1);
    });

    test('a new window opens: a 404 stays pending again and the cooldown count is not raised', async () => {
      const { token, order } = await finalNotFound(60);
      const before = calls.length;
      await upload(token, order.id, picture(1));
      await checker.idle();
      expect(calls.length).toBe(before + 1);
      expect(await row(order.id)).toMatchObject({
        slip_verify: 'pending',
        slip_verify_attempts: 1,
      });
      expect((await payments(order.id))[0]?.slip_invalid_count).toBe(1);
    });

    test('inside 60 seconds of the last call nothing is called and the verdict stays', async () => {
      const { token, order } = await finalNotFound(59);
      const before = calls.length;
      expect((await upload(token, order.id, picture(1))).statusCode).toBe(200);
      await checker.idle();
      expect(calls.length).toBe(before);
      expect(await row(order.id)).toMatchObject({ slip_verify: 'not_found' });
    });

    test('an unchecked verdict is re-checked the same way', async () => {
      const { token, order } = await finalNotFound(0);
      await h.client.query(
        "update payments set slip_verify = 'unchecked', slip_verify_code = null where order_id = $1",
        [order.id],
      );
      h.clock.advanceSeconds(60);
      const before = calls.length;
      await upload(token, order.id, picture(1));
      await checker.idle();
      expect(calls.length).toBe(before + 1);
    });

    test('after a valid answer, a fake-slip block or a mismatch it never calls', async () => {
      const a = await start();
      respond = () => ({ body: answer('200200', currentAmountBaht) });
      await upload(a.token, a.order.id, picture(3));
      await checker.idle();
      const b = await start();
      respond = () => ({ body: answer('200402', currentAmountBaht) });
      await upload(b.token, b.order.id, picture(4));
      await checker.idle();
      const c = await start();
      respond = () => ({ body: answer('200500', currentAmountBaht) });
      await upload(c.token, c.order.id, picture(5));
      await checker.idle();
      h.clock.advanceSeconds(600);
      const before = calls.length;
      expect((await upload(a.token, a.order.id, picture(3))).statusCode).toBe(200);
      expect((await upload(b.token, b.order.id, picture(4))).statusCode).toBe(200);
      expect((await upload(c.token, c.order.id, picture(5))).statusCode).toBe(409);
      await checker.idle();
      expect(calls.length).toBe(before);
      expect((await row(a.order.id))?.slip_verify).toBe('valid');
      expect((await row(b.order.id))?.slip_verify).toBe('amount_mismatch');
      expect((await row(c.order.id))?.slip_verify).toBe('fraud');
    });

    /** Lets the current picture's window pass so its 404 becomes final, then waits out the cooldown. */
    async function settle(orderId: string, gap = 400) {
      h.clock.advanceSeconds(301);
      await checker.sweep();
      await checker.idle();
      expect((await row(orderId))?.slip_verify).toBe('not_found');
      h.clock.advanceSeconds(gap);
    }
    const cyclesOf = async (orderId: string) =>
      (
        await h.client.query<{ c: number }>(
          'select slip_verify_cycles c from payments where order_id = $1',
          [orderId],
        )
      ).rows[0]?.c;

    test('lifetime limit: the first check and 2 re-sends are 3 cycles; a third re-send keeps the verdict and calls nothing', async () => {
      const { token, order } = await sendAt404();
      expect(await cyclesOf(order.id)).toBe(1);
      await settle(order.id);
      for (const cycle of [2, 3]) {
        const before = calls.length;
        expect((await upload(token, order.id, picture(1))).statusCode).toBe(200);
        await checker.idle();
        expect(calls.length).toBe(before + 1);
        expect(await cyclesOf(order.id)).toBe(cycle);
        await settle(order.id);
      }
      const before = calls.length;
      const rowBefore = await row(order.id);
      expect((await upload(token, order.id, picture(1))).statusCode).toBe(200);
      await checker.idle();
      expect(calls.length).toBe(before);
      expect(await cyclesOf(order.id)).toBe(3);
      // The stored picture is the new file; the verdict and its counters are untouched.
      expect(await row(order.id)).toMatchObject({
        slip_verify: 'not_found',
        slip_verify_attempts: rowBefore?.slip_verify_attempts,
        slip_verified_at: rowBefore?.slip_verified_at,
      });
      // Nothing calls later either.
      h.clock.advanceSeconds(120);
      await checker.sweep();
      await checker.idle();
      expect(calls.length).toBe(before);
    });

    test('alternating two pictures does not farm cycles: a different picture is a fresh slip but spends a cycle', async () => {
      const { token, order } = await sendAt404(1);
      await settle(order.id);
      for (const fill of [2, 1]) {
        const before = calls.length;
        expect((await upload(token, order.id, picture(fill))).statusCode).toBe(200);
        await checker.idle();
        expect(calls.length).toBe(before + 1);
        await settle(order.id);
      }
      expect(await cyclesOf(order.id)).toBe(3);
      // The fourth picture of the payment gets no bank check at all.
      const before = calls.length;
      expect((await upload(token, order.id, picture(2))).statusCode).toBe(200);
      await checker.idle();
      expect(calls.length).toBe(before);
      expect(await row(order.id)).toMatchObject({ slip_verify: null, slip_verify_attempts: 0 });
      expect(await cyclesOf(order.id)).toBe(3);
      // At most 3 cycles x 6 calls reached the bank for this payment.
      expect(calls.length).toBeLessThanOrEqual(18);
    });

    test('the cooldown refuses the upload first, with no call', async () => {
      const { token, order } = await finalNotFound(60);
      await h.client.query(
        'update payments set slip_invalid_count = 3, slip_invalid_at = $2 where order_id = $1',
        [order.id, h.clock.now().toISOString()],
      );
      const before = calls.length;
      const res = await upload(token, order.id, picture(1));
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ code: 'SLIP_COOLDOWN' });
      await checker.idle();
      expect(calls.length).toBe(before);
      expect((await row(order.id))?.slip_verify).toBe('not_found');
    });

    test('the daily cap still applies: no call, nothing counted against the customer', async () => {
      const used = await h.client.query<{ n: number }>(
        "select coalesce(sum(n), 0)::int as n from slip_verify_daily where kind = 'calls' and business_date = '2028-02-01'",
      );
      dailyCap = (used.rows[0]?.n ?? 0) + 1;
      checker = buildChecker();
      installSlipChecker(checker);
      const { token, order } = await finalNotFound(60);
      const before = calls.length;
      await upload(token, order.id, picture(1));
      await checker.idle();
      expect(calls.length).toBe(before);
      expect(await row(order.id)).toMatchObject({ slip_verify: 'unchecked' });
      expect((await payments(order.id))[0]?.slip_invalid_count).toBe(1);
    });
  });

  test('the daily cap is respected: no call over it, and nothing is counted against the customer', async () => {
    // The day's usage is shared by the tests of this file: allow exactly one more call.
    const used = await h.client.query<{ n: number }>(
      "select coalesce(sum(n), 0)::int as n from slip_verify_daily where kind = 'calls' and business_date = '2028-02-01'",
    );
    dailyCap = (used.rows[0]?.n ?? 0) + 1;
    checker = buildChecker();
    installSlipChecker(checker);
    const { order } = await sendAt404();
    h.clock.advanceSeconds(30);
    await checker.sweep();
    await checker.idle();
    expect(calls).toHaveLength(1);
    expect((await payments(order.id))[0]?.slip_invalid_count).toBe(0);
  });

  test('a fake-slip answer (200500) is never delayed: final and blocked at once', async () => {
    const placed = await start();
    respond = () => ({ body: answer('200500', currentAmountBaht) });
    await upload(placed.token, placed.order.id, picture(1));
    await checker.idle();
    expect((await payments(placed.order.id))[0]).toMatchObject({
      slip_verify: 'fraud',
      slip_block_reason: 'fraud',
      slip_invalid_count: 0,
    });
    expect(calls).toHaveLength(1);
  });

  test('the other final answers (e.g. wrong amount) are not delayed either', async () => {
    const placed = await start();
    respond = () => ({ body: answer('200402', currentAmountBaht) });
    await upload(placed.token, placed.order.id, picture(1));
    await checker.idle();
    expect((await payments(placed.order.id))[0]).toMatchObject({
      slip_verify: 'amount_mismatch',
      slip_invalid_count: 1,
    });
  });

  test('a staff recheck of a fresh slip is final on a 404 and does not count', async () => {
    const { order } = await sendAt404();
    const [before] = await payments(order.id);
    await h.client.query(
      "update payments set slip_verify = 'pending', slip_uploaded_at = $2 where id = $1",
      [before?.id, h.clock.now().toISOString()],
    );
    await checker.recheck(before?.id ?? '', {
      verdict: 'unchecked',
      code: null,
      ref: null,
      at: null,
    });
    const [after] = await payments(order.id);
    expect(after).toMatchObject({ slip_verify: 'not_found', slip_invalid_count: 0 });
  });
});
