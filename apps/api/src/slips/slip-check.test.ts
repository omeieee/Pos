/**
 * The automatic reading of a slip (D-26) on the real app and an in-memory Postgres, with a FAKE
 * reader. It is only a hint: it never confirms or rejects money (rule 2), never delays or fails an
 * upload, and its text is never stored. The customer never sees it.
 */
import type { MyOrder } from '@sds/shared';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { LiffUnavailableError, type LiffVerifier } from '../line/liff-verify.ts';
import { createLineRuntime } from '../line/runtime.ts';
import { createHarness, type Harness, type Menu } from '../test-support/harness.ts';
import { createSlipChecker, installSlipChecker, type SlipChecker } from './checker.ts';
import type { SlipOcr } from './ocr.ts';
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
let ownerId: string;
let checker: SlipChecker;
/** What the fake reader does for the next picture. */
let reading: (image: Buffer) => Promise<string> = async () => '';
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
  ownerId = owner.staffId;
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
  });
}, 60_000);
afterAll(async () => {
  installSlipChecker(null);
  await h.close();
});
afterEach(() => {
  installSlipChecker(null);
  reading = async () => '';
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
      slip_recipient_check: string | null;
      slip_image_key: string | null;
      rev: string;
    }>(
      'select id, status, amount_satang, slip_check, slip_amount_satang, slip_recipient_check, slip_image_key, rev from payments where order_id = $1',
      [orderId],
    )
  ).rows[0];

/** The text a bank slip would give for this many satang. */
const slipText = (satang: number) =>
  `โอนเงินสำเร็จ\nจำนวน: ${(satang / 100).toFixed(2)} บาท\nค่าธรรมเนียม: 0.00 บาท`;

describe('with the reading on', () => {
  test('the upload answers at once, marked pending, and the reading follows in the background', async () => {
    installSlipChecker(checker);
    let finish: (text: string) => void = () => undefined;
    reading = () => new Promise<string>((resolve) => (finish = resolve));
    const token = await customer();
    const order = await place(token);
    const marker = h.events.length;

    const res = await upload(token, order.id, picture());
    expect(res.statusCode).toBe(200);
    expect(res.json().payment.status).toBe('claimed');
    // The answer is back while the reader has not finished: nothing waited for it.
    const before = await row(order.id);
    expect(before?.slip_check).toBe('pending');
    expect(before?.slip_amount_satang).toBeNull();

    finish(slipText(Number(before?.amount_satang)));
    await checker.idle();

    const after = await row(order.id);
    expect(after?.slip_check).toBe('match');
    expect(Number(after?.slip_amount_satang)).toBe(Number(before?.amount_satang));
    // A hint, nothing more: the payment is still only claimed (rule 2).
    expect(after?.status).toBe('claimed');
    // Devices are told once, after the commit, so the staff screen asks for the hint.
    const upserts = h.events
      .slice(marker)
      .filter((e) => e.type === 'payment.upserted' && e.id === after?.id);
    expect(upserts.length).toBeGreaterThanOrEqual(2);
    expect(Number(after?.rev)).toBeGreaterThan(Number(before?.rev));
  });

  test('another amount on the slip is a mismatch, and it is still only claimed', async () => {
    installSlipChecker(checker);
    reading = async () => slipText(99900);
    const token = await customer();
    const order = await place(token);
    await upload(token, order.id, picture());
    await checker.idle();
    const after = await row(order.id);
    expect(after).toMatchObject({ slip_check: 'mismatch', slip_amount_satang: 99900 });
    expect(after?.status).toBe('claimed');
  });

  test('a reader that fails or finds no amount is unreadable, and the upload still worked', async () => {
    installSlipChecker(checker);
    reading = async () => {
      throw new Error('OCR_TIMEOUT');
    };
    const token = await customer();
    const order = await place(token);
    expect((await upload(token, order.id, picture())).statusCode).toBe(200);
    await checker.idle();
    expect(await row(order.id)).toMatchObject({
      slip_check: 'unreadable',
      slip_amount_satang: null,
    });

    reading = async () => 'ไม่มีตัวเลขเลย';
    const other = await customer();
    const another = await place(other);
    await upload(other, another.id, picture(1170, 2532, 7));
    await checker.idle();
    expect((await row(another.id))?.slip_check).toBe('unreadable');
  });

  test('a picture with too many pixels is unreadable and never reaches the reader', async () => {
    installSlipChecker(checker);
    const token = await customer();
    const order = await place(token);
    await upload(token, order.id, picture(9000, 9000));
    await checker.idle();
    expect((await row(order.id))?.slip_check).toBe('unreadable');
    expect(seen).toHaveLength(0);
  });

  test('a picture whose size cannot be read is unreadable and never reaches the reader', async () => {
    installSlipChecker(checker);
    const token = await customer();
    const order = await place(token);
    const odd = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.alloc(40, 3)]);
    await h.app.inject({
      method: 'POST',
      url: `/v1/app/orders/${order.id}/slip`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' },
      payload: odd,
      remoteAddress: h.nextIp(),
    });
    await checker.idle();
    expect((await row(order.id))?.slip_check).toBe('unreadable');
    expect(seen).toHaveLength(0);
  });

  test('a new slip clears the old reading, and the old reading arriving late is thrown away', async () => {
    installSlipChecker(checker);
    const finishers: ((text: string) => void)[] = [];
    reading = () => new Promise<string>((resolve) => finishers.push(resolve));
    const token = await customer();
    const order = await place(token);
    await upload(token, order.id, picture(1170, 2532, 1));
    const first = await row(order.id);

    // A second picture replaces the first while the first is still being read.
    await upload(token, order.id, picture(1170, 2532, 2));
    const replaced = await row(order.id);
    expect(replaced?.slip_image_key).not.toBe(first?.slip_image_key);
    expect(replaced?.slip_check).toBe('pending');

    // The first reading ends late with a wrong amount; the second is right.
    await vi_waitFor(() => finishers.length >= 1);
    finishers[0]?.(slipText(12300));
    await vi_waitFor(() => finishers.length >= 2);
    finishers[1]?.(slipText(Number(first?.amount_satang)));
    await checker.idle();
    const final = await row(order.id);
    expect(final).toMatchObject({ slip_check: 'match' });
    expect(final?.slip_image_key).toBe(replaced?.slip_image_key);
  });

  test('the sweep reads a payment that was left pending (a restart), and skips nothing twice', async () => {
    installSlipChecker(checker);
    reading = async () => slipText(5555);
    const token = await customer();
    const order = await place(token);
    await upload(token, order.id, picture());
    await checker.idle();
    // Simulate the process dying before the reading finished.
    await h.client.query(
      "update payments set slip_check = 'pending', slip_amount_satang = null where order_id = $1",
      [order.id],
    );
    seen.length = 0;
    expect(await checker.sweep()).toBeGreaterThanOrEqual(1);
    await checker.idle();
    expect(await row(order.id)).toMatchObject({
      slip_check: 'mismatch',
      slip_amount_satang: 5555,
    });
    expect(seen).toHaveLength(1);
    expect(await checker.sweep()).toBe(0);
  });

  test('the staff list carries the hint; the customer answer never does', async () => {
    installSlipChecker(checker);
    reading = async () => slipText(1234500);
    const token = await customer();
    const order = await place(token);
    const res = await upload(token, order.id, picture());
    await checker.idle();
    const payment = await row(order.id);

    const staff = await call('GET', `/v1/orders/${order.id}/payments`, staffToken);
    expect(staff.json().slipChecks).toEqual([
      {
        paymentId: payment?.id,
        check: 'mismatch',
        amountSatang: 1234500,
        qrFound: false,
        recipientCheck: 'unknown',
      },
    ]);
    // Not in the payment DTO (realtime and sync carry that one).
    expect(JSON.stringify(staff.json().payments)).not.toMatch(/slip/i);

    // The customer only learns that a slip is on file.
    expect(res.json().hasSlip).toBe(true);
    const mine = await call('GET', `/v1/app/orders/${order.id}`, token);
    expect(mine.json().hasSlip).toBe(true);
    expect(mine.body).not.toMatch(/slipCheck|slipAmount|mismatch|unreadable|1234500/);
    expect(res.body).not.toMatch(/slipCheck|slipAmount|mismatch|unreadable/);
  });

  test('the text the reader found is not kept anywhere', async () => {
    installSlipChecker(checker);
    reading = async () => `นาย สมชาย ใจดี 123-4-56789-0\n${slipText(7700)}`;
    const token = await customer();
    const order = await place(token);
    await upload(token, order.id, picture());
    await checker.idle();
    const dump = JSON.stringify([
      (await h.client.query('select * from payments where order_id = $1', [order.id])).rows,
      (await h.client.query('select * from audit_log')).rows,
    ]);
    expect(dump).not.toContain('สมชาย');
    expect(dump).not.toContain('123-4-56789-0');
  });
});

/** A slip that names the receiver; the shop's (fake) PromptPay ID in the settings ends in 4321. */
const slipTo = (receiver: string, satang = 1234500) =>
  `โอนเงินสำเร็จ
จาก
นาย ผู้ส่ง ทดสอบ
xxx-x-x7777-x
ไปยัง
นาย ผู้รับ ทดสอบ
${receiver}
${slipText(satang)}`;

describe('the receiver on the slip (D-26)', () => {
  const start = async () => {
    const token = await customer();
    return { token, order: await place(token) };
  };
  const run = async (text: string, placed?: Awaited<ReturnType<typeof start>>) => {
    installSlipChecker(checker);
    reading = async () => text;
    const { token, order } = placed ?? (await start());
    await upload(token, order.id, picture());
    await checker.idle();
    return { token, order, payment: await row(order.id) };
  };

  test('the own tail of the shop is a match; staff see it, the customer never does', async () => {
    const { token, order, payment } = await run(slipTo('xxx-xxx-4321'));
    expect(payment).toMatchObject({ slip_recipient_check: 'match', status: 'claimed' });
    const staff = await call('GET', `/v1/orders/${order.id}/payments`, staffToken);
    expect(staff.json().slipChecks[0].recipientCheck).toBe('match');
    const mine = await call('GET', `/v1/app/orders/${order.id}`, token);
    expect(mine.body).not.toMatch(/recipientCheck|slipRecipient/i);
    expect(JSON.stringify(staff.json().payments)).not.toMatch(/recipientCheck|slipRecipient/i);
  });

  test('another receiver with the same amount is a mismatch, still only claimed', async () => {
    const { payment } = await run(slipTo('xxx-xxx-8765', 99900));
    expect(payment).toMatchObject({ slip_recipient_check: 'mismatch', status: 'claimed' });
  });

  test('a hidden or missing receiver is unknown', async () => {
    expect((await run(slipTo('xxx-xxx-xxxx'))).payment?.slip_recipient_check).toBe('unknown');
    expect((await run(slipText(1234500))).payment?.slip_recipient_check).toBe('unknown');
  });

  test('the ID is read from the settings at check time, and no digits are kept', async () => {
    await h.client.query("update settings set value = $1::jsonb where key = 'promptpay'", [
      JSON.stringify({ idType: 'phone', idValue: '0891118765' }),
    ]);
    try {
      const { order, payment } = await run(slipTo('xxx-xxx-8765'));
      expect(payment?.slip_recipient_check).toBe('match');
      const dump = JSON.stringify([
        (await h.client.query('select * from payments where order_id = $1', [order.id])).rows,
        (await h.client.query('select * from audit_log')).rows,
      ]);
      // (The masked target of the payment itself holds the tail of the ID; the slip's text must not.)
      expect(dump).not.toContain('xxx-xxx');
      expect(dump).not.toContain('ผู้รับ ทดสอบ');
    } finally {
      await h.client.query("update settings set value = $1::jsonb where key = 'promptpay'", [
        JSON.stringify({ idType: 'phone', idValue: '0899994321' }),
      ]);
    }
  });

  test('without a PromptPay ID in the settings there is no recipient check, and the amount still reads', async () => {
    const placed = await start();
    await h.client.query("delete from settings where key = 'promptpay'");
    try {
      const { payment } = await run(slipTo('xxx-xxx-4321'), placed);
      expect(payment).toMatchObject({ slip_recipient_check: null, slip_amount_satang: 1234500 });
    } finally {
      await h.client.query(
        "insert into settings (key, value, updated_by) values ('promptpay', $1::jsonb, $2)",
        [JSON.stringify({ idType: 'phone', idValue: '0899994321' }), ownerId],
      );
    }
  });

  test('an unreadable picture has no recipient check, and a new slip clears the old one', async () => {
    const { token, order, payment } = await run(slipTo('xxx-xxx-4321'));
    expect(payment?.slip_recipient_check).toBe('match');
    // The new slip is not read (reading off): the old check must not stay.
    installSlipChecker(null);
    await upload(token, order.id, picture(1170, 2532, 9));
    expect((await row(order.id))?.slip_recipient_check).toBeNull();
  });
});

describe('with the reading off', () => {
  test('a slip gets no hint at all, and an old hint is cleared by a new slip', async () => {
    const token = await customer();
    const order = await place(token);
    await upload(token, order.id, picture());
    expect(await row(order.id)).toMatchObject({ slip_check: null, slip_amount_satang: null });

    await h.client.query(
      "update payments set slip_check = 'mismatch', slip_amount_satang = 100, slip_recipient_check = 'match' where order_id = $1",
      [order.id],
    );
    await upload(token, order.id, picture(1170, 2532, 5));
    expect(await row(order.id)).toMatchObject({
      slip_check: null,
      slip_amount_satang: null,
      slip_recipient_check: null,
    });
  });
});

describe('the customer looks at their own slip', () => {
  test('gets the picture back, never cached, and only for their own order', async () => {
    const token = await customer();
    const order = await place(token);
    const sent = picture(1170, 2532, 9);
    await upload(token, order.id, sent);

    const res = await call('GET', `/v1/app/orders/${order.id}/slip`, token);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(sent)).toBe(true);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    // Somebody else's order is a plain 404, the same as no slip at all.
    const stranger = await customer();
    expect((await call('GET', `/v1/app/orders/${order.id}/slip`, stranger)).statusCode).toBe(404);
    expect((await call('GET', `/v1/app/orders/${order.id}/slip`, undefined)).statusCode).toBe(401);
    // A staff session does not work on a customer route.
    expect((await call('GET', `/v1/app/orders/${order.id}/slip`, staffToken)).statusCode).toBe(401);
  });

  test('an order without a slip is a 404, and looking leaves no audit row', async () => {
    const token = await customer();
    const order = await place(token);
    expect((await call('GET', `/v1/app/orders/${order.id}/slip`, token)).statusCode).toBe(404);

    await upload(token, order.id, picture());
    const before = (await h.client.query('select count(*)::int as n from audit_log')).rows[0];
    await call('GET', `/v1/app/orders/${order.id}/slip`, token);
    const after = (await h.client.query('select count(*)::int as n from audit_log')).rows[0];
    expect(after).toEqual(before);
  });

  test('the route is limited per customer', async () => {
    const token = await customer();
    const order = await place(token);
    await upload(token, order.id, picture());
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) {
      codes.push((await call('GET', `/v1/app/orders/${order.id}/slip`, token)).statusCode);
    }
    expect(codes.at(-1)).toBe(429);
  });
});

async function vi_waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(condition()).toBe(true);
}
