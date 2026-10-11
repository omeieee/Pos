/**
 * The duplicate-slip hint (D-26) on the real app and an in-memory Postgres, with a FAKE reader.
 * A slip is a duplicate when an earlier claimed, confirmed or refunded payment holds the same
 * picture or the same bank reference. It is only a hint for staff: it never confirms or rejects
 * money (rule 2), and the customer is never told about it.
 */
import type { MyOrder } from '@sds/shared';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { LiffUnavailableError, type LiffVerifier } from '../line/liff-verify.ts';
import { createLineRuntime } from '../line/runtime.ts';
import { createHarness, type Harness, type Menu } from '../test-support/harness.ts';
import { createSlipChecker, installSlipChecker, type SlipChecker } from './checker.ts';
import type { SlipOcr } from './ocr.ts';
import type { SlipQrReader } from './qr.ts';
import { createMemorySlipStore, type SlipStore } from './store.ts';

let tokenNo = 0;
const newToken = () => `id-token-${++tokenNo}-1111111111111111111111`;

/** A PNG header with a plausible phone size: the reader is fake, only the header is looked at. */
const picture = (width = 1170, height = 2532, fill = 1) => {
  const b = Buffer.alloc(64, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
};

const verifier: LiffVerifier = {
  async verify(credential) {
    const token = 'idToken' in credential ? credential.idToken : credential.accessToken;
    if (token === 'down') throw new LiffUnavailableError();
    return token.startsWith('id-token-') ? { userId: `Ucheck${token.slice(9)}` } : null;
  },
};

let h: Harness;
let menu: Menu;
let store: SlipStore;
let staffToken: string;
let checker: SlipChecker;
/** What the fake reader does for the next picture. */
let reading: (image: Buffer) => Promise<string> = async () => '';
/** What the fake QR reader answers for the next picture (null: no QR; it may throw). */
let qrReading: (image: Buffer) => Promise<{ sendingBank: string; transRef: string } | null> =
  async () => null;
const qr: SlipQrReader = { read: (image) => qrReading(image) };
const seen: Buffer[] = [];
const ocr: SlipOcr = {
  read: async (image) => {
    seen.push(image);
    return reading(image);
  },
};

beforeAll(async () => {
  store = createMemorySlipStore();
  const runtime = createLineRuntime(
    {
      channelSecret: 'unused-test-secret',
      channelAccessToken: undefined,
      liffId: '1234567890-abcdefgh',
    },
    { liffVerifier: verifier, client: null },
  );
  h = await createHarness({ line: runtime, slips: store });
  menu = await h.newMenu();
  const owner = await h.newOwner();
  h.clock.set('2028-02-01T08:00:00.000Z');
  staffToken = await h.ownerSession(owner);
  await h.client.query(
    "insert into settings (key, value, updated_by) values ('promptpay', $1::jsonb, $2)",
    [JSON.stringify({ idType: 'phone', idValue: '0899994321' }), owner.staffId],
  );
  checker = createSlipChecker({
    ctx: { db: h.db, now: h.clock.now, events: h.bus },
    slips: store,
    ocr,
    qr,
  });
}, 60_000);
afterAll(async () => {
  installSlipChecker(null);
  await h.close();
});
afterEach(() => {
  installSlipChecker(null);
  reading = async () => '';
  qrReading = async () => null;
  seen.length = 0;
});

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

const upload = (token: string, orderId: string, bytes: Buffer) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/app/orders/${orderId}/slip`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
    payload: bytes,
    remoteAddress: h.nextIp(),
  });

const row = async (orderId: string) =>
  (
    await h.client.query<{
      id: string;
      status: string;
      amount_satang: string;
      slip_check: string | null;
      slip_amount_satang: string | null;
      slip_image_key: string | null;
      rev: string;
    }>(
      'select id, status, amount_satang, slip_check, slip_amount_satang, slip_image_key, rev from payments where order_id = $1',
      [orderId],
    )
  ).rows[0];

const orderNo = async (orderId: string) =>
  (
    await h.client.query<{ order_no: string }>('select order_no from orders where id = $1', [
      orderId,
    ])
  ).rows[0]?.order_no;

const staffList = async (orderId: string) =>
  (await call('GET', `/v1/orders/${orderId}/payments`, staffToken)).json();

/** Each picture is sent one second after the last, so "earlier" is well defined. */
const send = async (token: string, orderId: string, bytes: Buffer) => {
  h.clock.advanceSeconds(1);
  return upload(token, orderId, bytes);
};

const setStatus = async (orderId: string, status: 'confirmed' | 'cancelled' | 'voided') => {
  const staff = await h.client.query<{ id: string }>('select id from staff limit 1');
  await h.client.query(
    `update payments set status = $2,
       confirmed_by_staff_id = case when $2 in ('confirmed', 'voided') then $3::uuid end,
       confirmed_at = case when $2 in ('confirmed', 'voided') then now() end
     where order_id = $1`,
    [orderId, status, staff.rows[0]?.id],
  );
};

const refText = (ref: string) => `โอนเงินสำเร็จ\nรหัสอ้างอิง ${ref}\nจำนวน: 0.01 บาท`;
const hex64 = /^[0-9a-f]{64}$/;
const refHash = async (orderId: string) =>
  (
    await h.client.query<{ slip_ref_hash: string | null }>(
      'select slip_ref_hash from payments where order_id = $1',
      [orderId],
    )
  ).rows[0]?.slip_ref_hash;

describe('the same picture', () => {
  test('on a new order is flagged for staff, names only the earlier order, and still claims', async () => {
    const tokenA = await customer();
    const a = await place(tokenA);
    const first = picture(1170, 2532, 21);
    await send(tokenA, a.id, first);

    const tokenB = await customer();
    const b = await place(tokenB);
    const res = await send(tokenB, b.id, first);
    expect(res.statusCode).toBe(200);
    // Rule 2: the claim goes through exactly as before.
    expect(res.json().payment.status).toBe('claimed');

    const payment = await row(b.id);
    const listing = await staffList(b.id);
    expect(listing.slipDuplicates).toEqual([
      {
        paymentId: payment?.id,
        orderNo: await orderNo(a.id),
        paymentStatus: 'claimed',
        matchedBy: 'image',
      },
    ]);
    // The earlier one is not told it is a copy of the later one.
    expect((await staffList(a.id)).slipDuplicates).toBeUndefined();
    // Nothing personal and no hash in the answer, and the customer learns nothing.
    expect(JSON.stringify(listing)).not.toMatch(/[0-9a-f]{64}|ฟ้าทดสอบ/);
    expect(res.body).not.toMatch(/duplicate/i);
    expect((await call('GET', `/v1/app/orders/${b.id}`, tokenB)).body).not.toMatch(/duplicate/i);
  });

  test('only a hash of the picture is kept', async () => {
    const token = await customer();
    const order = await place(token);
    await send(token, order.id, picture(1170, 2532, 22));
    const [found] = (
      await h.client.query<{ slip_image_hash: string | null }>(
        'select slip_image_hash from payments where order_id = $1',
        [order.id],
      )
    ).rows;
    expect(found?.slip_image_hash).toMatch(hex64);
  });

  test('the identical file sent again for the same payment is not a duplicate', async () => {
    const token = await customer();
    const order = await place(token);
    const sent = picture(1170, 2532, 23);
    await send(token, order.id, sent);
    expect((await send(token, order.id, sent)).statusCode).toBe(200);
    expect((await staffList(order.id)).slipDuplicates).toBeUndefined();
  });

  test('the earlier payment confirmed: its status is passed on', async () => {
    const tokenA = await customer();
    const a = await place(tokenA);
    const sent = picture(1170, 2532, 24);
    await send(tokenA, a.id, sent);
    await setStatus(a.id, 'confirmed');
    const tokenB = await customer();
    const b = await place(tokenB);
    await send(tokenB, b.id, sent);
    expect((await staffList(b.id)).slipDuplicates?.[0]).toMatchObject({
      orderNo: await orderNo(a.id),
      paymentStatus: 'confirmed',
      matchedBy: 'image',
    });
  });

  test.each(['voided', 'cancelled'] as const)(
    'an earlier payment that was %s does not count',
    async (status) => {
      const tokenA = await customer();
      const a = await place(tokenA);
      const sent = picture(1170, 2532, status === 'voided' ? 25 : 26);
      await send(tokenA, a.id, sent);
      await setStatus(a.id, status);
      const tokenB = await customer();
      const b = await place(tokenB);
      await send(tokenB, b.id, sent);
      expect((await staffList(b.id)).slipDuplicates).toBeUndefined();
    },
  );

  test('is found with the reading off, and the claim is never blocked', async () => {
    const sent = picture(1170, 2532, 27);
    const tokenA = await customer();
    const a = await place(tokenA);
    await send(tokenA, a.id, sent);
    const tokenB = await customer();
    const b = await place(tokenB);
    const res = await send(tokenB, b.id, sent);
    expect(res.json().payment.status).toBe('claimed');
    expect((await staffList(b.id)).slipDuplicates).toHaveLength(1);
    expect((await row(b.id))?.slip_check).toBeNull();
  });
});

describe('the same bank reference', () => {
  test('on a different picture is flagged once the reading has finished', async () => {
    installSlipChecker(checker);
    reading = async () => refText('202610111432123456');
    const tokenA = await customer();
    const a = await place(tokenA);
    await send(tokenA, a.id, picture(1170, 2532, 31));
    await checker.idle();

    const tokenB = await customer();
    const b = await place(tokenB);
    await send(tokenB, b.id, picture(1170, 2532, 32));
    await checker.idle();
    const listing = await staffList(b.id);
    expect(listing.slipDuplicates).toEqual([
      {
        paymentId: (await row(b.id))?.id,
        orderNo: await orderNo(a.id),
        paymentStatus: 'claimed',
        matchedBy: 'ref',
      },
    ]);
    // Still only a hint: it is claimed, and the amount check is intact.
    expect((await row(b.id))?.status).toBe('claimed');
    expect(listing.slipChecks[0].check).toBe('mismatch');
  });

  test('only a hash of the reference is stored, never the reference or the text', async () => {
    installSlipChecker(checker);
    reading = async () => `นาย สมชาย ใจดี\n${refText('999888777666555444')}`;
    const token = await customer();
    const order = await place(token);
    await send(token, order.id, picture(1170, 2532, 33));
    await checker.idle();
    expect(await refHash(order.id)).toMatch(hex64);
    const dump = JSON.stringify([
      (await h.client.query('select * from payments where order_id = $1', [order.id])).rows,
      (await h.client.query('select * from audit_log')).rows,
    ]);
    expect(dump).not.toContain('999888777666555444');
    expect(dump).not.toContain('สมชาย');
  });

  test('an unclear reference stores nothing', async () => {
    installSlipChecker(checker);
    reading = async () => `${refText('202610111432123456')}\nเลขที่รายการ 016285143033BTF01234`;
    const token = await customer();
    const order = await place(token);
    await send(token, order.id, picture(1170, 2532, 34));
    await checker.idle();
    expect(await refHash(order.id)).toBeNull();
  });

  test('a new picture clears the old reference, so it cannot match any more', async () => {
    installSlipChecker(checker);
    reading = async () => refText('555444333222111000');
    const token = await customer();
    const order = await place(token);
    await send(token, order.id, picture(1170, 2532, 35));
    await checker.idle();
    expect(await refHash(order.id)).toMatch(hex64);
    reading = async () => '';
    await send(token, order.id, picture(1170, 2532, 36));
    await checker.idle();
    expect(await refHash(order.id)).toBeNull();
  });
});

const qrHash = async (orderId: string) =>
  (
    await h.client.query<{ slip_qr_hash: string | null }>(
      'select slip_qr_hash from payments where order_id = $1',
      [orderId],
    )
  ).rows[0]?.slip_qr_hash;

describe('the reference inside the slip QR', () => {
  const QR = { sendingBank: '014', transRef: '016285143033BTF01234' };

  test('catches a screenshot: another picture, the text unreadable, the same QR', async () => {
    installSlipChecker(checker);
    qrReading = async () => QR;
    const tokenA = await customer();
    const a = await place(tokenA);
    await send(tokenA, a.id, picture(1170, 2532, 41));
    await checker.idle();

    const tokenB = await customer();
    const b = await place(tokenB);
    const res = await send(tokenB, b.id, picture(900, 1600, 42));
    // Rule 2: the claim still goes through as claimed.
    expect(res.json().payment.status).toBe('claimed');
    await checker.idle();
    const listing = await staffList(b.id);
    expect(listing.slipDuplicates).toEqual([
      {
        paymentId: (await row(b.id))?.id,
        orderNo: await orderNo(a.id),
        paymentStatus: 'claimed',
        matchedBy: 'qr',
      },
    ]);
    expect(listing.slipChecks[0].qrFound).toBe(true);
    expect((await row(b.id))?.status).toBe('claimed');
    // The customer is never told.
    expect((await call('GET', `/v1/app/orders/${b.id}`, tokenB)).body).not.toMatch(
      /duplicate|matchedBy|qrFound/i,
    );
  });

  test('only a hash is kept, never the bank code, the reference or the QR text', async () => {
    installSlipChecker(checker);
    qrReading = async () => ({ sendingBank: '006', transRef: '777666555444333222111' });
    reading = async () => `นาย สมชาย ใจดี\n${refText('202610111432123456')}`;
    const token = await customer();
    const order = await place(token);
    await send(token, order.id, picture(1170, 2532, 43));
    await checker.idle();
    expect(await qrHash(order.id)).toMatch(hex64);
    const dump = JSON.stringify([
      (await h.client.query('select * from payments where order_id = $1', [order.id])).rows,
      (await h.client.query('select * from audit_log')).rows,
    ]);
    expect(dump).not.toContain('777666555444333222111');
  });

  test('works when the text cannot be read at all', async () => {
    installSlipChecker(checker);
    qrReading = async () => ({ sendingBank: '004', transRef: '444555666777888999000' });
    reading = async () => {
      throw new Error('OCR_FAILED');
    };
    const token = await customer();
    const order = await place(token);
    await send(token, order.id, picture(1170, 2532, 44));
    await checker.idle();
    expect((await row(order.id))?.slip_check).toBe('unreadable');
    expect(await qrHash(order.id)).toMatch(hex64);
  });

  test('a different bank with the same reference is not the same transfer', async () => {
    installSlipChecker(checker);
    const tokenA = await customer();
    const a = await place(tokenA);
    qrReading = async () => ({ sendingBank: '014', transRef: '123123123123123123123' });
    await send(tokenA, a.id, picture(1170, 2532, 45));
    await checker.idle();
    const tokenB = await customer();
    const b = await place(tokenB);
    qrReading = async () => ({ sendingBank: '025', transRef: '123123123123123123123' });
    await send(tokenB, b.id, picture(1170, 2532, 46));
    await checker.idle();
    expect((await staffList(b.id)).slipDuplicates).toBeUndefined();
  });

  test.each(['voided', 'cancelled'] as const)(
    'an earlier payment that was %s does not count',
    async (status) => {
      installSlipChecker(checker);
      const ref = status === 'voided' ? '555555555555555555551' : '555555555555555555552';
      qrReading = async () => ({ sendingBank: '014', transRef: ref });
      const tokenA = await customer();
      const a = await place(tokenA);
      await send(tokenA, a.id, picture(1170, 2532, status === 'voided' ? 47 : 48));
      await checker.idle();
      await setStatus(a.id, status);
      const tokenB = await customer();
      const b = await place(tokenB);
      await send(tokenB, b.id, picture(1170, 2532, status === 'voided' ? 53 : 54));
      await checker.idle();
      expect((await staffList(b.id)).slipDuplicates).toBeUndefined();
    },
  );

  test('a failing QR reader never fails the check: the amount is still read', async () => {
    installSlipChecker(checker);
    qrReading = async () => {
      throw new Error('QR_TIMEOUT');
    };
    reading = async () => '1.00 บาท';
    const token = await customer();
    const order = await place(token);
    await send(token, order.id, picture(1170, 2532, 50));
    await checker.idle();
    expect((await row(order.id))?.slip_check).not.toBe('pending');
    expect(await qrHash(order.id)).toBeNull();
    expect((await staffList(order.id)).slipChecks[0].qrFound).toBe(false);
  });

  test('a new picture clears the old QR hash', async () => {
    installSlipChecker(checker);
    qrReading = async () => ({ sendingBank: '014', transRef: '888777666555444333222' });
    const token = await customer();
    const order = await place(token);
    await send(token, order.id, picture(1170, 2532, 51));
    await checker.idle();
    expect(await qrHash(order.id)).toMatch(hex64);
    qrReading = async () => null;
    await send(token, order.id, picture(1170, 2532, 52));
    await checker.idle();
    expect(await qrHash(order.id)).toBeNull();
  });
});
