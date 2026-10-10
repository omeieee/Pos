/**
 * Transfer slip pictures (D-24) on the real app and an in-memory Postgres: the customer's upload,
 * the staff view, the storage seam and the 90-day purge. A slip only ever makes a payment
 * `claimed` (rule 2): nothing here lets a picture confirm money. LINE is a fake verifier.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MyOrder, RETENTION_DAYS } from '@sds/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { JOBS } from '../jobs/jobs.ts';
import { purgeSlips, sweepOrphanSlips } from '../jobs/retention.ts';
import { LiffUnavailableError, type LiffVerifier } from '../line/liff-verify.ts';
import { createLineRuntime } from '../line/runtime.ts';
import {
  createHarness,
  type Harness,
  type Menu,
  type OwnerFixture,
} from '../test-support/harness.ts';
import { MAX_SLIP_BYTES, sniffSlip } from './image.ts';
import { createFsSlipStore, createMemorySlipStore, newSlipKey, type SlipStore } from './store.ts';

// Made-up LINE tokens: each one is its own customer, so the per-customer upload limit of one
// test never counts against another.
let tokenNo = 0;
const newToken = () => `id-token-${++tokenNo}-0000000000000000000000`;
const PHONE = '0899994321';

// Tiny made-up pictures: the right first bytes, nothing more.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40, 2),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([40, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(40, 3),
]);

const verifier: LiffVerifier = {
  async verify(credential) {
    const token = 'idToken' in credential ? credential.idToken : credential.accessToken;
    if (token === 'down') throw new LiffUnavailableError();
    return token.startsWith('id-token-') ? { userId: `Utest${token.slice(9)}` } : null;
  },
};

let h: Harness;
let menu: Menu;
let owner: OwnerFixture;
let store: SlipStore & { keys(): string[] };
let staffToken: string;
let cashierToken: string;
let kitchenToken: string;

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
  owner = await h.newOwner();
  // One day, no clock moves: the staff sessions below must stay valid for every test.
  h.clock.set('2028-02-01T08:00:00.000Z'); // 15:00 Bangkok
  staffToken = await h.ownerSession(owner);
  const device = await h.newDevice('ipad');
  const cashier = await h.newStaff('cashier', '2468');
  cashierToken = await h.pinSession(device.token, cashier.id, '2468');
  const kitchen = await h.newStaff('kitchen', '1357');
  kitchenToken = await h.pinSession(device.token, kitchen.id, '1357');
  await h.client.query(
    "insert into settings (key, value, updated_by) values ('promptpay', $1::jsonb, $2)",
    [JSON.stringify({ idType: 'phone', idValue: PHONE }), owner.staffId],
  );
}, 60_000);
afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.client.query(
    "update orders set status = 'completed' where channel = 'line' and status not in ('completed', 'cancelled')",
  );
});

const call = (method: 'GET' | 'POST', url: string, token: string | undefined, body?: unknown) =>
  h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });

async function customer(idToken = newToken()): Promise<string> {
  const res = await call('POST', '/v1/app/session', undefined, { idToken });
  const token = res.json().token as string;
  await call('POST', '/v1/app/privacy-ack', token);
  return token;
}

async function place(token: string, paymentMethod: 'promptpay' | 'cash' = 'promptpay') {
  const res = await call('POST', '/v1/app/orders', token, {
    clientRequestId: crypto.randomUUID(),
    items: [{ menuItemId: menu.water, qty: 1 }],
    deliveryBuilding: 'B1',
    recipientName: 'ฟ้าทดสอบ',
    paymentMethod,
  });
  expect(res.statusCode).toBe(201);
  return res.json().order as MyOrder;
}

const upload = (
  token: string | undefined,
  orderId: string,
  bytes: Buffer | string,
  contentType: string | null = 'image/jpeg',
) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/app/orders/${orderId}/slip`,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(contentType ? { 'content-type': contentType } : {}),
    },
    payload: bytes,
    remoteAddress: h.nextIp(),
  });

const paymentRow = async (orderId: string) =>
  (
    await h.client.query<{
      id: string;
      status: string;
      slip_image_key: string | null;
      version: number;
      rev: number;
    }>('select id, status, slip_image_key, version, rev from payments where order_id = $1', [
      orderId,
    ])
  ).rows[0];

describe('the customer uploads a slip', () => {
  test('stores the picture under a random key, claims the payment in the same step, and staff still confirm', async () => {
    const token = await customer();
    const order = await place(token);
    const marker = h.events.length;

    const res = await upload(token, order.id, JPEG);
    expect(res.statusCode).toBe(200);
    expect(res.json().payment.status).toBe('claimed');
    expect(res.json().paymentStatus).toBe('awaiting_confirmation');

    const row = await paymentRow(order.id);
    expect(row?.status).toBe('claimed');
    const key = row?.slip_image_key as string;
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // Random: nothing in the key comes from the order, the payment or the customer.
    expect(key).not.toContain(order.id.slice(0, 8));
    expect(await store.get(key)).toEqual(JPEG);

    // The POS heard of the claim in the same transaction; no frame, answer or log holds the key.
    const after = h.events.slice(marker);
    expect(after.some((e) => e.type === 'payment.upserted' && e.data.status === 'claimed')).toBe(
      true,
    );
    expect(JSON.stringify(after)).not.toContain(key);
    expect(res.body).not.toContain(key);
    expect(h.logs()).not.toContain(key);
    // A picture never confirms.
    const confirmed = await h.client.query(
      "select id from payments where order_id = $1 and (status = 'confirmed' or confirmed_at is not null)",
      [order.id],
    );
    expect(confirmed.rows).toHaveLength(0);
  });

  test('PNG and WebP are accepted too, and the bytes decide the type, not the header', async () => {
    const token = await customer();
    for (const [bytes, header, mime] of [
      [PNG, 'image/png', 'image/png'],
      [WEBP, 'image/webp', 'image/webp'],
      // A JPEG header over PNG bytes: the file is a PNG, and is served as one.
      [PNG, 'image/jpeg', 'image/png'],
    ] as const) {
      const order = await place(token);
      expect((await upload(token, order.id, bytes, header)).statusCode, mime).toBe(200);
      const row = await paymentRow(order.id);
      expect(sniffSlip((await store.get(row?.slip_image_key as string)) as Buffer)).toBe(mime);
      await h.client.query("update orders set status = 'completed' where id = $1", [order.id]);
    }
  });

  test("someone else's order is a plain 404 and nothing is stored or changed", async () => {
    const tokenA = await customer();
    const tokenB = await customer();
    const order = await place(tokenA);
    const before = store.keys().length;
    const res = await upload(tokenB, order.id, JPEG);
    expect(res.statusCode).toBe(404);
    expect(store.keys().length).toBe(before);
    expect(await paymentRow(order.id)).toMatchObject({ status: 'pending', slip_image_key: null });
  });

  test('needs a customer session: none, and a staff session, are refused before the body is read', async () => {
    const token = await customer();
    const order = await place(token);
    expect((await upload(undefined, order.id, JPEG)).statusCode).toBe(401);
    expect((await upload(staffToken, order.id, JPEG)).statusCode).toBe(401);
    expect(await paymentRow(order.id)).toMatchObject({ slip_image_key: null });
  });

  test('refuses anything that is not a JPEG, PNG or WebP picture, and keeps nothing', async () => {
    const before = store.keys().length;
    const html = Buffer.from('<html><script>alert(1)</script></html> and some more bytes');
    const cases: [string, Buffer | string, string | null][] = [
      ['a page sent as a PNG', html, 'image/png'],
      ['a GIF', Buffer.from('GIF89a' + 'x'.repeat(40)), 'image/png'],
      ['a too-short file', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
      [
        'a RIFF that is not WebP',
        Buffer.concat([Buffer.from('RIFF....WAVE'), Buffer.alloc(30)]),
        'image/webp',
      ],
      ['an unsupported type header', JPEG, 'image/gif'],
      ['plain text', 'hello', 'text/plain'],
      ['JSON', '{"a":1}', 'application/json'],
      ['no content type', JPEG, null],
    ];
    for (const [label, bytes, type] of cases) {
      // A customer each: refused attempts count against the per-customer limit too.
      const token = await customer();
      const order = await place(token);
      const res = await upload(token, order.id, bytes, type);
      expect([415, 400], label).toContain(res.statusCode);
      if (label === 'a page sent as a PNG') {
        // The magic-byte refusal has its own code.
        expect(res.statusCode).toBe(415);
        expect(res.json().code).toBe('SLIP_TYPE_UNSUPPORTED');
      }
      expect(await paymentRow(order.id), label).toMatchObject({
        status: 'pending',
        slip_image_key: null,
      });
    }
    expect(store.keys().length).toBe(before);
  });

  test('refuses a file over 5 MB, and takes one of exactly 5 MB', async () => {
    const token = await customer();
    const order = await place(token);
    const big = (size: number) => Buffer.concat([JPEG, Buffer.alloc(size - JPEG.length, 7)]);
    const before = store.keys().length;

    const over = await upload(token, order.id, big(MAX_SLIP_BYTES + 1));
    expect(over.statusCode).toBe(413);
    expect(over.json().code).toBe('SLIP_TOO_LARGE');
    const wayOver = await upload(token, order.id, big(MAX_SLIP_BYTES + 100_000));
    expect(wayOver.statusCode).toBe(413);
    expect(store.keys().length).toBe(before);
    expect(await paymentRow(order.id)).toMatchObject({ status: 'pending', slip_image_key: null });

    expect((await upload(token, order.id, big(MAX_SLIP_BYTES))).statusCode).toBe(200);
  });

  test('a second upload replaces the first: one file is left, the old one is deleted, the claim is not repeated', async () => {
    const token = await customer();
    const order = await place(token);
    await upload(token, order.id, JPEG);
    const first = await paymentRow(order.id);
    const marker = h.events.length;

    const res = await upload(token, order.id, PNG, 'image/png');
    expect(res.statusCode).toBe(200);
    const second = await paymentRow(order.id);
    expect(second?.status).toBe('claimed');
    expect(second?.slip_image_key).not.toBe(first?.slip_image_key);
    expect(await store.get(first?.slip_image_key as string)).toBeNull();
    expect(await store.get(second?.slip_image_key as string)).toEqual(PNG);
    expect(store.keys().filter((k) => k === second?.slip_image_key)).toHaveLength(1);
    // The change is a new version and rev, and every device hears of it.
    expect(Number(second?.version)).toBeGreaterThan(Number(first?.version));
    expect(Number(second?.rev)).toBeGreaterThan(Number(first?.rev));
    expect(h.events.slice(marker).some((e) => e.type === 'payment.upserted')).toBe(true);
  });

  test('a cash order, and a payment staff already confirmed, take no slip and leave no file', async () => {
    const token = await customer();
    const cash = await place(token, 'cash');
    const before = store.keys().length;
    const refused = await upload(token, cash.id, JPEG);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('NO_PAYMENT_TO_CLAIM');

    const order = await place(token);
    await upload(token, order.id, JPEG);
    await h.client.query(
      "update payments set status = 'confirmed', confirmed_by_staff_id = $2, confirmed_at = now() where order_id = $1",
      [order.id, owner.staffId],
    );
    const keys = store.keys().length;
    expect((await upload(token, order.id, PNG, 'image/png')).statusCode).toBe(409);
    expect(store.keys().length).toBe(keys);
    expect(keys).toBe(before + 1);
  });

  test('is rate limited per customer', async () => {
    const token = await customer();
    const order = await place(token);
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await upload(token, order.id, JPEG)).statusCode);
    expect(codes.slice(0, 6).every((c) => c === 200)).toBe(true);
    expect(codes).toContain(429);
  });
});

describe('staff look at a slip', () => {
  async function claimedWithSlip() {
    const token = await customer();
    const order = await place(token);
    await upload(token, order.id, PNG, 'image/png');
    return {
      order,
      payment: (await paymentRow(order.id)) as NonNullable<Awaited<ReturnType<typeof paymentRow>>>,
    };
  }

  test('payment.record holders get the picture with its real type and strict headers; every look is audited', async () => {
    const { payment } = await claimedWithSlip();
    for (const token of [staffToken, cashierToken]) {
      const res = await call('GET', `/v1/payments/${payment.id}/slip`, token);
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload).toEqual(PNG);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    }
    const audit = (await h.auditRows(payment.id)).filter((r) => r.action === 'payment.slip.view');
    expect(audit).toHaveLength(2);
    expect(audit[0]?.actorType).toBe('staff');
    expect(JSON.stringify(audit)).not.toContain(payment.slip_image_key as string);
  });

  test('kitchen staff, no session and a customer session are refused', async () => {
    const { payment } = await claimedWithSlip();
    const customerToken = await customer();
    expect((await call('GET', `/v1/payments/${payment.id}/slip`, kitchenToken)).statusCode).toBe(
      403,
    );
    expect((await call('GET', `/v1/payments/${payment.id}/slip`, undefined)).statusCode).toBe(401);
    expect((await call('GET', `/v1/payments/${payment.id}/slip`, customerToken)).statusCode).toBe(
      401,
    );
  });

  test('the staff view is rate limited per staff member (30 a minute), with the usual error shape', async () => {
    const { payment } = await claimedWithSlip();
    const device = await h.newDevice('ipad');
    const staff = await h.newStaff('cashier', '8642');
    const token = await h.pinSession(device.token, staff.id, '8642');
    const statuses: number[] = [];
    for (let i = 0; i < 33; i++) {
      statuses.push((await call('GET', `/v1/payments/${payment.id}/slip`, token)).statusCode);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    const limited = await call('GET', `/v1/payments/${payment.id}/slip`, token);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('RATE_LIMITED');
    // Another staff member is not affected.
    expect((await call('GET', `/v1/payments/${payment.id}/slip`, staffToken)).statusCode).toBe(200);
  });

  test('a payment with no slip, an unknown payment and a lost file are 404 with the usual error shape', async () => {
    const token = await customer();
    const order = await place(token);
    const bare = await paymentRow(order.id);
    const none = await call('GET', `/v1/payments/${bare?.id}/slip`, staffToken);
    expect(none.statusCode).toBe(404);
    expect(none.json()).toMatchObject({ code: 'SLIP_NOT_FOUND' });
    expect(
      (await call('GET', `/v1/payments/${crypto.randomUUID()}/slip`, staffToken)).statusCode,
    ).toBe(404);

    const { payment } = await claimedWithSlip();
    await store.delete(payment.slip_image_key as string);
    expect((await call('GET', `/v1/payments/${payment.id}/slip`, staffToken)).statusCode).toBe(404);
  });

  test('the staff payment list says which payments have a slip, by id, and never shows a key', async () => {
    const { order, payment } = await claimedWithSlip();
    const res = await call('GET', `/v1/orders/${order.id}/payments`, staffToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().slipPaymentIds).toEqual([payment.id]);
    expect(res.body).not.toContain(payment.slip_image_key as string);
    expect(JSON.stringify(res.json().payments)).not.toMatch(/slip/i);
  });
});

describe('the routes are guarded', () => {
  test('the upload runs the customer guard and the staff view runs the staff guard', () => {
    const upload = h.routes.find((r) => r.url === '/v1/app/orders/:id/slip' && r.method === 'POST');
    expect(upload).toMatchObject({ customerGuarded: true });
    const view = h.routes.find((r) => r.url === '/v1/payments/:id/slip' && r.method === 'GET');
    expect(view).toMatchObject({ guarded: true });
  });
});

describe('the files on disk', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sds-slips-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('put, get and delete; a missing file is null and deleting it twice is fine', async () => {
    const disk = createFsSlipStore(join(dir, 'nested', 'slips'));
    const key = 'A'.repeat(32);
    expect(await disk.get(key)).toBeNull();
    await disk.put(key, JPEG);
    expect(await disk.get(key)).toEqual(JPEG);
    await disk.put(key, PNG);
    expect(await disk.get(key)).toEqual(PNG);
    await disk.delete(key);
    await disk.delete(key);
    expect(await disk.get(key)).toBeNull();
    // No temporary files left behind.
    expect(await readdir(join(dir, 'nested', 'slips'))).toEqual([]);
  });

  test('a key that is not one of ours can never name a path', async () => {
    const disk = createFsSlipStore(join(dir, 'safe'));
    for (const key of ['../x', 'a/b', '..\\x', '', 'short', `${'A'.repeat(31)}.`]) {
      await expect(disk.put(key, JPEG), key).rejects.toThrow();
      await expect(disk.get(key), key).rejects.toThrow();
      await expect(disk.delete(key), key).rejects.toThrow();
    }
  });
});

describe('the 90-day purge', () => {
  const DAY = 86_400_000;
  const depsAt = (at: Date, slips: SlipStore) => ({
    db: h.db,
    events: h.bus,
    now: () => at,
    line: createLineRuntime({ channelSecret: undefined, channelAccessToken: undefined }),
    slips,
  });

  async function slipPayment(status: 'confirmed' | 'claimed' | 'cancelled') {
    const token = await customer();
    const order = await place(token);
    await upload(token, order.id, JPEG);
    const row = await paymentRow(order.id);
    if (status === 'confirmed') {
      await h.client.query(
        "update payments set status = 'confirmed', confirmed_by_staff_id = $2, confirmed_at = $3 where id = $1",
        [row?.id, owner.staffId, h.clock.now().toISOString()],
      );
    } else if (status === 'cancelled') {
      await h.client.query(
        "update payments set status = 'cancelled', void_reason = 'x' where id = $1",
        [row?.id],
      );
    }
    return (await paymentRow(order.id)) as NonNullable<Awaited<ReturnType<typeof paymentRow>>>;
  }
  const keyOf = async (id: string) =>
    (
      await h.client.query<{ k: string | null }>(
        'select slip_image_key as k from payments where id = $1',
        [id],
      )
    ).rows[0]?.k;

  // Slips from the tests above must not count here: start each test with none.
  beforeEach(async () => {
    for (const key of store.keys()) await store.delete(key);
    await h.client.query(
      'update payments set slip_image_key = null where slip_image_key is not null',
    );
  });

  test('the retention period is 90 days', () => {
    expect(RETENTION_DAYS.slipImages).toBe(90);
  });

  test('deletes the file and clears the key 90 days after confirmation, and not a day before', async () => {
    const confirmedAt = h.clock.now().getTime();
    const p = await slipPayment('confirmed');
    const key = p.slip_image_key as string;

    const early = await purgeSlips(depsAt(new Date(confirmedAt + 89 * DAY), store));
    expect(early).toEqual({ deleted: 0, failed: 0 });
    expect(await store.get(key)).toEqual(JPEG);
    expect(await keyOf(p.id)).toBe(key);

    const due = await purgeSlips(depsAt(new Date(confirmedAt + 91 * DAY), store));
    expect(due.deleted).toBeGreaterThanOrEqual(1);
    expect(await store.get(key)).toBeNull();
    expect(await keyOf(p.id)).toBeNull();
    // One audit row with counts, never a key.
    const audit = await h.client.query<{ after: unknown }>(
      "select after from audit_log where action = 'retention.slips.delete'",
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audit.rows)).not.toContain(key);
    // A second run changes nothing.
    expect(await purgeSlips(depsAt(new Date(confirmedAt + 92 * DAY), store))).toEqual({
      deleted: 0,
      failed: 0,
    });
  });

  test('a cancelled payment is purged too; a claimed one keeps its slip for 90 days, then loses it, still claimed', async () => {
    const waiting = await slipPayment('claimed');
    const cancelled = await slipPayment('cancelled');
    // The database stamps updated_at with the real time, not the test clock.
    await purgeSlips(depsAt(new Date(Date.now() + 89 * DAY), store));
    expect(await keyOf(waiting.id)).toBe(waiting.slip_image_key);
    expect(await store.get(waiting.slip_image_key as string)).toEqual(JPEG);

    await purgeSlips(depsAt(new Date(Date.now() + 120 * DAY), store));
    expect(await keyOf(cancelled.id)).toBeNull();
    expect(await store.get(cancelled.slip_image_key as string)).toBeNull();
    expect(await keyOf(waiting.id)).toBeNull();
    expect(await store.get(waiting.slip_image_key as string)).toBeNull();
    // Nothing about the money changed.
    const after = await h.client.query<{ status: string }>(
      'select status from payments where id = $1',
      [waiting.id],
    );
    expect(after.rows[0]?.status).toBe('claimed');
  });

  describe('orphan sweep', () => {
    const put = async () => {
      const key = newSlipKey();
      await store.put(key, JPEG);
      return key;
    };
    const tomorrow = () => new Date(Date.now() + 2 * DAY);

    test('deletes a file no payment points to, and keeps every file a payment points to', async () => {
      const kept = await slipPayment('claimed');
      const orphan = await put();
      const result = await sweepOrphanSlips(depsAt(tomorrow(), store));
      expect(result).toEqual({ deleted: 1, failed: 0 });
      expect(await store.get(orphan)).toBeNull();
      expect(await store.get(kept.slip_image_key as string)).toEqual(JPEG);
      expect(await sweepOrphanSlips(depsAt(tomorrow(), store))).toEqual({ deleted: 0, failed: 0 });
    });

    test('leaves a young file alone: its payment row may be about to point to it', async () => {
      const young = await put();
      expect(await sweepOrphanSlips(depsAt(new Date(), store))).toEqual({ deleted: 0, failed: 0 });
      expect(await store.get(young)).toEqual(JPEG);
    });

    test('a file that cannot be deleted is counted and the rest still goes', async () => {
      const stuck = await put();
      const other = await put();
      const flaky: SlipStore = {
        put: (k, b) => store.put(k, b),
        get: (k) => store.get(k),
        list: () => store.list(),
        delete: async (k) => {
          if (k === stuck) throw new Error('disk error');
          await store.delete(k);
        },
      };
      expect(await sweepOrphanSlips(depsAt(tomorrow(), flaky))).toEqual({ deleted: 1, failed: 1 });
      expect(await store.get(other)).toBeNull();
      expect(await store.get(stuck)).toEqual(JPEG);
    });

    test('the nightly job list carries it', () => {
      expect(JOBS.map((j) => j.name)).toContain('retention-slip-orphans');
    });
  });

  test('a file that cannot be deleted keeps its key, so the next run tries again', async () => {
    const p = await slipPayment('confirmed');
    const key = p.slip_image_key as string;
    let broken = true;
    const flaky: SlipStore = {
      put: (k, b) => store.put(k, b),
      get: (k) => store.get(k),
      list: () => store.list(),
      delete: async (k) => {
        if (broken) throw new Error('disk error');
        await store.delete(k);
      },
    };
    const at = new Date(h.clock.now().getTime() + 100 * DAY);
    const failed = await purgeSlips(depsAt(at, flaky));
    expect(failed.failed).toBe(1);
    expect(await keyOf(p.id)).toBe(key);
    expect(await store.get(key)).toEqual(JPEG);

    broken = false;
    const retried = await purgeSlips(depsAt(at, flaky));
    expect(retried.deleted).toBe(1);
    expect(await keyOf(p.id)).toBeNull();
    expect(await store.get(key)).toBeNull();
  });
});
