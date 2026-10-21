import type { ExpenseDto } from '@sds/shared';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { sweepOrphanSlips } from '../jobs/retention.ts';
import { createLineRuntime } from '../line/runtime.ts';
import { imageSize } from '../slips/image.ts';
import { createMemorySlipStore, type MemorySlipStore, newSlipKey } from '../slips/store.ts';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';

let h: Harness;
let owner: OwnerFixture;
let device: { id: string; token: string };
let manager: string;
let cashier: string;
let receipts: MemorySlipStore;
let slips: MemorySlipStore;
beforeAll(async () => {
  receipts = createMemorySlipStore();
  slips = createMemorySlipStore();
  h = await createHarness({ receipts, slips });
  owner = await h.newOwner();
  device = await h.newDevice();
  manager = await staff('manager');
  cashier = await staff('cashier');
}, 60_000);
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.events.length = 0;
});

async function staff(role: 'manager' | 'cashier' | 'kitchen') {
  const s = await h.newStaff(role, '4821');
  return h.pinSession(device.token, s.id, '4821');
}

const photo = (width = 1800, height = 1200, shade = 200) => {
  const data = Buffer.alloc(width * height * 4, shade);
  return Buffer.from(jpeg.encode({ data, width, height }, 80).data);
};

function send(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  token: string | undefined,
  options: { body?: Buffer; type?: string; key?: string | null } = {},
) {
  const key = options.key === undefined ? crypto.randomUUID() : options.key;
  return h.app.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'content-type': options.type ?? 'image/jpeg' } : {}),
      ...(method === 'POST' && key ? { 'idempotency-key': key } : {}),
    },
    ...(options.body ? { payload: options.body } : {}),
    remoteAddress: h.nextIp(),
  });
}

async function newExpense(): Promise<ExpenseDto> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/expenses',
    headers: { authorization: `Bearer ${manager}` },
    payload: { category: 'gas', amountSatang: 25000 },
    remoteAddress: h.nextIp(),
  });
  return res.json() as ExpenseDto;
}
const upload = (e: ExpenseDto, body = photo(), extra: { key?: string | null; v?: number } = {}) =>
  send('POST', `/v1/expenses/${e.id}/receipt?expectedVersion=${extra.v ?? e.version}`, manager, {
    body,
    key: extra.key === undefined ? crypto.randomUUID() : extra.key,
  });
const actions = async (id: string) => (await h.auditRows(id)).map((a) => a.action);

describe('upload', () => {
  test('stores a shrunk JPEG, sets the flag and the version, audits without the key', async () => {
    const e = await newExpense();
    expect(e.hasReceipt).toBe(false);
    const before = receipts.keys().length;
    const res = await upload(e);
    expect(res.statusCode).toBe(201);
    const dto = res.json() as ExpenseDto;
    expect(dto).toMatchObject({ id: e.id, hasReceipt: true, version: e.version + 1 });
    expect(JSON.stringify(dto)).not.toContain(receipts.keys().at(-1) as string);

    expect(receipts.keys().length).toBe(before + 1);
    const stored = (await receipts.get(receipts.keys().at(-1) as string)) as Buffer;
    expect(imageSize(stored)).toEqual({ width: 1280, height: 853 });
    expect(stored.includes(Buffer.from('Exif'))).toBe(false);

    expect(await actions(e.id)).toContain('expense.receipt.attach');
    const audit = (await h.auditRows(e.id)).find((a) => a.action === 'expense.receipt.attach');
    expect(JSON.stringify(audit)).not.toContain(receipts.keys().at(-1) as string);
    // One event for the create and one for the photo.
    expect(h.events.filter((x) => x.type === 'expense.upserted')).toHaveLength(2);
  });

  test('owner may upload; cashier and no session may not', async () => {
    const e = await newExpense();
    h.clock.advanceSeconds(90);
    const ownerToken = await h.ownerSession(owner);
    const ok = await send(
      'POST',
      `/v1/expenses/${e.id}/receipt?expectedVersion=${e.version}`,
      ownerToken,
      {
        body: photo(300, 200),
      },
    );
    expect(ok.statusCode).toBe(201);
    const e2 = await newExpense();
    const url = `/v1/expenses/${e2.id}/receipt?expectedVersion=${e2.version}`;
    expect((await send('POST', url, cashier, { body: photo(300, 200) })).statusCode).toBe(403);
    expect((await send('POST', url, undefined, { body: photo(300, 200) })).statusCode).toBe(401);
  });

  test('the same Idempotency-Key and picture is a replay: 200, nothing new, even after the version moved on', async () => {
    const e = await newExpense();
    const key = crypto.randomUUID();
    const body = photo(600, 400);
    const first = await upload(e, body, { key });
    expect(first.statusCode).toBe(201);
    const files = receipts.keys().length;
    const second = await upload(e, body, { key }); // the old expectedVersion: the retry of a lost answer
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(receipts.keys().length).toBe(files);
    expect((await actions(e.id)).filter((a) => a === 'expense.receipt.attach')).toHaveLength(1);

    const other = await upload(e, photo(600, 401), { key });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  test('a stale version is 409 and leaves no file behind', async () => {
    const e = await newExpense();
    const files = receipts.keys().length;
    const res = await upload(e, photo(400, 300), { v: e.version + 5 });
    expect(res.statusCode).toBe(409);
    expect(receipts.keys().length).toBe(files);
    expect(await actions(e.id)).not.toContain('expense.receipt.attach');
  });

  test('a second photo replaces the first and the old file is deleted', async () => {
    const e = await newExpense();
    const first = (await upload(e, photo(400, 300))).json() as ExpenseDto;
    const oldKey = receipts.keys().at(-1) as string;
    const files = receipts.keys().length;
    const second = await upload(first, photo(500, 300, 90));
    expect(second.statusCode).toBe(201);
    expect(receipts.keys().length).toBe(files);
    expect(await receipts.get(oldKey)).toBeNull();
  });

  test('refuses a missing or bad Idempotency-Key, no version, WebP, text, a lie and a huge picture', async () => {
    const e = await newExpense();
    const url = `/v1/expenses/${e.id}/receipt?expectedVersion=${e.version}`;
    const files = receipts.keys().length;
    expect(
      (await send('POST', url, manager, { body: photo(300, 200), key: null })).statusCode,
    ).toBe(400);
    expect(
      (await send('POST', url, manager, { body: photo(300, 200), key: 'nope' })).statusCode,
    ).toBe(400);
    expect(
      (await send('POST', `/v1/expenses/${e.id}/receipt`, manager, { body: photo(300, 200) }))
        .statusCode,
    ).toBe(400);

    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([40, 0, 0, 0]),
      Buffer.from('WEBP'),
      Buffer.alloc(40),
    ]);
    const asWebp = await send('POST', url, manager, { body: webp, type: 'image/webp' });
    expect(asWebp.statusCode).toBe(415);
    expect(asWebp.json()).toMatchObject({ code: 'RECEIPT_TYPE_UNSUPPORTED' });
    expect(
      (await send('POST', url, manager, { body: Buffer.from('{"a":1}'), type: 'application/json' }))
        .statusCode,
    ).toBe(415);
    // HTML sent as image/jpeg: the bytes decide.
    const html = await send('POST', url, manager, {
      body: Buffer.from('<html>some text that is long</html>'),
    });
    expect(html.statusCode).toBe(415);
    // JPEG magic over garbage: cannot be read.
    const junk = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
    expect((await send('POST', url, manager, { body: junk })).statusCode).toBe(422);
    // A PNG header promising 20000 x 20000 pixels.
    const big = PNG.sync.write(new PNG({ width: 4, height: 4 }));
    big.writeUInt32BE(20_000, 16);
    big.writeUInt32BE(20_000, 20);
    const huge = await send('POST', url, manager, { body: big, type: 'image/png' });
    expect(huge.statusCode).toBe(413);
    // More bytes than the cap.
    const over = await send('POST', url, manager, { body: Buffer.alloc(11 * 1024 * 1024, 1) });
    expect(over.statusCode).toBe(413);
    expect(receipts.keys().length).toBe(files);
  });

  test('a voided expense keeps its record: no new photo; an unknown expense is 404', async () => {
    const e = await newExpense();
    const withPhoto = (await upload(e, photo(300, 200))).json() as ExpenseDto;
    const v = await h.app.inject({
      method: 'POST',
      url: `/v1/expenses/${e.id}/void`,
      headers: { authorization: `Bearer ${manager}` },
      payload: { expectedVersion: withPhoto.version, reason: 'duplicate' },
      remoteAddress: h.nextIp(),
    });
    const voided = v.json() as ExpenseDto;
    expect((await upload(voided, photo(300, 200))).statusCode).toBe(409);
    expect((await send('GET', `/v1/expenses/${e.id}/receipt`, manager)).statusCode).toBe(200);
    const missing = `/v1/expenses/${crypto.randomUUID()}/receipt?expectedVersion=1`;
    expect((await send('POST', missing, manager, { body: photo(300, 200) })).statusCode).toBe(404);
  });

  test('a failing store fails the request and changes nothing', async () => {
    const e = await newExpense();
    const broken = receipts.put.bind(receipts);
    receipts.put = async () => {
      throw new Error('R2 put failed with status 500');
    };
    try {
      const res = await upload(e, photo(300, 200));
      expect(res.statusCode).toBe(500);
    } finally {
      receipts.put = broken;
    }
    const after = await send('GET', `/v1/expenses/${e.id}/receipt`, manager);
    expect(after.statusCode).toBe(404);
  });
});

describe('view and delete', () => {
  test('owner and manager see the photo (audited, never cached); a cashier does not', async () => {
    const e = await newExpense();
    await upload(e, photo(300, 200));
    const res = await send('GET', `/v1/expenses/${e.id}/receipt`, manager);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(imageSize(res.rawPayload)).toEqual({ width: 300, height: 200 });
    expect(await actions(e.id)).toContain('expense.receipt.view');

    h.clock.advanceSeconds(90);
    const ownerToken = await h.ownerSession(owner);
    expect((await send('GET', `/v1/expenses/${e.id}/receipt`, ownerToken)).statusCode).toBe(200);
    expect((await send('GET', `/v1/expenses/${e.id}/receipt`, cashier)).statusCode).toBe(403);
    expect((await send('GET', `/v1/expenses/${e.id}/receipt`, undefined)).statusCode).toBe(401);
  });

  test('an expense without a photo is 404', async () => {
    const e = await newExpense();
    expect((await send('GET', `/v1/expenses/${e.id}/receipt`, manager)).statusCode).toBe(404);
    expect(
      (await send('DELETE', `/v1/expenses/${e.id}/receipt?expectedVersion=${e.version}`, manager))
        .statusCode,
    ).toBe(404);
  });

  test('delete clears the flag, removes the file, audits, and needs the current version', async () => {
    const e = await newExpense();
    const withPhoto = (await upload(e, photo(300, 200))).json() as ExpenseDto;
    const key = receipts.keys().at(-1) as string;
    const stale = await send(
      'DELETE',
      `/v1/expenses/${e.id}/receipt?expectedVersion=${e.version}`,
      manager,
    );
    expect(stale.statusCode).toBe(409);
    expect(await receipts.get(key)).not.toBeNull();

    const res = await send(
      'DELETE',
      `/v1/expenses/${e.id}/receipt?expectedVersion=${withPhoto.version}`,
      manager,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasReceipt: false, version: withPhoto.version + 1 });
    expect(await receipts.get(key)).toBeNull();
    expect(await actions(e.id)).toContain('expense.receipt.delete');
    expect((await send('GET', `/v1/expenses/${e.id}/receipt`, manager)).statusCode).toBe(404);
  });

  test('PATCH cannot set the receipt key', async () => {
    const e = await newExpense();
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/v1/expenses/${e.id}`,
      headers: { authorization: `Bearer ${manager}` },
      payload: { expectedVersion: e.version, receiptImageKey: newSlipKey() },
      remoteAddress: h.nextIp(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('retention never touches receipts', () => {
  test('the orphan sweep keeps a receipt photo even when it shares a store with slips', async () => {
    const shared = createMemorySlipStore();
    const e = await newExpense();
    const key = newSlipKey();
    await shared.put(key, photo(100, 100));
    await h.client.query('update expenses set receipt_image_key = $2 where id = $1', [e.id, key]);
    const orphan = newSlipKey();
    await shared.put(orphan, photo(100, 100));
    const later = new Date(Date.now() + 3 * 86_400_000);
    const deps = {
      db: h.db,
      events: h.bus,
      now: () => later,
      line: createLineRuntime({ channelSecret: undefined, channelAccessToken: undefined }),
      slips: shared,
    };
    // The files are "old" for the sweep: their write time is now, the clock is 3 days on.
    expect(await sweepOrphanSlips(deps)).toEqual({ deleted: 1, failed: 0 });
    expect(await shared.get(key)).not.toBeNull();
    expect(await shared.get(orphan)).toBeNull();
  });

  test('the slip sweep only sees the slips store: receipts are listed nowhere it looks', async () => {
    expect(slips.keys().some((k) => receipts.keys().includes(k))).toBe(false);
  });
});

describe('without R2', () => {
  test('every receipt route answers 503 and the rest of the expense still works', async () => {
    const bare = await createHarness({ receipts: null });
    try {
      await bare.newOwner();
      const dev = await bare.newDevice();
      const m = await bare.newStaff('manager', '4821');
      const token = await bare.pinSession(dev.token, m.id, '4821');
      const created = await bare.app.inject({
        method: 'POST',
        url: '/v1/expenses',
        headers: { authorization: `Bearer ${token}` },
        payload: { category: 'gas', amountSatang: 25000 },
        remoteAddress: bare.nextIp(),
      });
      expect(created.statusCode).toBe(201);
      const e = created.json() as ExpenseDto;
      const call = (method: 'GET' | 'POST' | 'DELETE') =>
        bare.app.inject({
          method,
          url: `/v1/expenses/${e.id}/receipt?expectedVersion=${e.version}`,
          headers: {
            authorization: `Bearer ${token}`,
            ...(method === 'POST'
              ? { 'content-type': 'image/jpeg', 'idempotency-key': crypto.randomUUID() }
              : {}),
          },
          ...(method === 'POST' ? { payload: photo() } : {}),
          remoteAddress: bare.nextIp(),
        });
      for (const method of ['GET', 'POST', 'DELETE'] as const) {
        const res = await call(method);
        expect(res.statusCode).toBe(503);
        expect(res.json().code).toBe('RECEIPT_STORAGE_UNAVAILABLE');
      }
    } finally {
      await bare.close();
    }
  }, 60_000);
});
