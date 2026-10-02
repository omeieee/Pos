import type { PGlite } from '@electric-sql/pglite';
import { ANONYMIZED_RECIPIENT_NAME, recipientKey } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as repo from './customers.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';

let db: PgliteDb;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
}, 60_000);
afterAll(async () => {
  await client.close();
});

// Made-up recipients only: no real customer data in tests.
const at = (minute: number) => new Date(Date.UTC(2026, 9, 2, 3, minute, 0));
const details = (
  building: string,
  recipientName: string,
  deliveryNote: string | null = null,
): repo.RecipientDetails => ({
  building,
  recipientName,
  recipientKey: recipientKey(recipientName),
  deliveryNote,
});
const one = async (id: string) =>
  (await client.query<Record<string, unknown>>('select * from customers where id = $1', [id]))
    .rows[0];
const one2 = async (table: string, id: string) =>
  (await client.query<Record<string, unknown>>(`select * from ${table} where id = $1`, [id]))
    .rows[0];
const count = async () =>
  Number(
    (await client.query<{ n: number }>('select count(*)::int as n from customers')).rows[0]?.n,
  );

describe('recordRecipientOrder: find or create by building and name', () => {
  test('creates the customer on the first order, with the count and the last-order time', async () => {
    const id = await repo.recordRecipientOrder(db, details('B1', 'Test Alpha', 'ชั้น 3'), at(1));
    expect(await one(id)).toMatchObject({
      building: 'B1',
      recipient_name: 'Test Alpha',
      recipient_key: 'test alpha',
      delivery_note: 'ชั้น 3',
      line_user_id: null,
      order_count: 1,
      total_spent_satang: 0, // left for P6
    });
    expect(new Date(String((await one(id))?.last_order_at)).toISOString()).toBe(
      at(1).toISOString(),
    );
  });

  test('the same building and name, however it is typed, is the same customer', async () => {
    const first = await repo.recordRecipientOrder(db, details('B2', 'Test Beta'), at(1));
    const second = await repo.recordRecipientOrder(db, details('B2', '  test   BETA '), at(2));
    expect(second).toBe(first);
    expect(await one(first)).toMatchObject({ order_count: 2 });
  });

  test('another building, or another name, is another customer', async () => {
    const a = await repo.recordRecipientOrder(db, details('C1', 'Test Gamma'), at(1));
    const b = await repo.recordRecipientOrder(db, details('C2', 'Test Gamma'), at(1));
    const c = await repo.recordRecipientOrder(db, details('C1', 'Test Delta'), at(1));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test('the last used spelling and note replace the old ones; no note clears it', async () => {
    const id = await repo.recordRecipientOrder(db, details('D1', 'test epsilon', 'ห้อง 1'), at(1));
    await repo.recordRecipientOrder(db, details('D1', 'Test Epsilon', 'ห้อง 2'), at(2));
    expect(await one(id)).toMatchObject({
      recipient_name: 'Test Epsilon',
      delivery_note: 'ห้อง 2',
      order_count: 2,
    });
    await repo.recordRecipientOrder(db, details('D1', 'Test Epsilon'), at(3));
    expect(await one(id)).toMatchObject({ delivery_note: null, order_count: 3 });
  });

  test('simultaneous first orders for one new recipient make one customer and count both', async () => {
    const before = await count();
    const ids = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        db.transaction((tx) => repo.recordRecipientOrder(tx, details('A1', 'Test Zeta'), at(i))),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    expect(await count()).toBe(before + 1);
    expect(await one(ids[0] ?? '')).toMatchObject({ order_count: 4 });
  });

  test('a rolled-back order leaves no customer and no count behind', async () => {
    const before = await count();
    await db
      .transaction(async (tx) => {
        await repo.recordRecipientOrder(tx, details('A2', 'Test Eta'), at(1));
        throw new Error('the order failed');
      })
      .catch(() => undefined);
    expect(await count()).toBe(before);
  });
});

describe('recordRecipientOrder: a customer id from the client is only a hint', () => {
  const insertId = async (sql: string) =>
    String((await client.query<{ id: string }>(sql)).rows[0]?.id);

  test('the same recipient: the saved customer is used, spelling and note refreshed, counted', async () => {
    const a = await repo.recordRecipientOrder(db, details('A1', 'Test Mu', 'old'), at(1));
    const used = await repo.recordRecipientOrder(db, details('A1', 'test MU', 'new'), at(2), a);
    expect(used).toBe(a);
    expect(await one(a)).toMatchObject({
      building: 'A1',
      recipient_name: 'test MU',
      recipient_key: 'test mu',
      delivery_note: 'new',
      order_count: 2,
    });
  });

  test('a LINE customer is only linked: counted, and no recipient field is written onto it', async () => {
    const lineId = await insertId(
      "insert into customers (line_user_id, display_name) values ('U-test-line-1', 'Test Line') returning id",
    );
    const counter = await repo.recordRecipientOrder(db, details('C2', 'Test Iota'), at(1));
    const used = await repo.recordRecipientOrder(
      db,
      details('C2', 'Test Iota', 'x'),
      at(2),
      lineId,
    );
    expect(used).toBe(lineId);
    expect(used).not.toBe(counter);
    expect(await one(counter)).toMatchObject({ order_count: 1 });
    expect(await one(lineId)).toMatchObject({
      building: null,
      recipient_name: null,
      recipient_key: null,
      delivery_note: null,
      line_user_id: 'U-test-line-1',
      display_name: 'Test Line',
      order_count: 1,
    });
    expect(new Date(String((await one(lineId))?.last_order_at)).toISOString()).toBe(
      at(2).toISOString(),
    );
    // Without its id, a new order for that name goes to the counter customer, not the LINE one.
    expect(await repo.recordRecipientOrder(db, details('C2', 'Test Iota'), at(3))).toBe(counter);
  });

  test('a LINE customer that already holds recipient details (written before the fix) keeps them untouched', async () => {
    const lineId = await insertId(
      "insert into customers (line_user_id, building, recipient_name, recipient_key) values ('U-test-line-3', 'B9', 'Test Old', 'test old') returning id",
    );
    await repo.recordRecipientOrder(db, details('B9', 'Someone Else'), at(1), lineId);
    expect(await one(lineId)).toMatchObject({
      recipient_name: 'Test Old',
      recipient_key: 'test old',
    });
  });

  test('a saved recipient is never renamed: another name means the customer for that name', async () => {
    const a = await repo.recordRecipientOrder(db, details('A3', 'Test Mu'), at(1));
    const used = await repo.recordRecipientOrder(db, details('A3', 'Test Mu Two'), at(2), a);
    expect(used).not.toBe(a);
    expect(await one(a)).toMatchObject({
      recipient_name: 'Test Mu',
      recipient_key: 'test mu',
      order_count: 1,
    });
    expect(await one(used)).toMatchObject({ recipient_name: 'Test Mu Two', order_count: 1 });
  });

  test("another building is another customer too, and the id's owner is unchanged", async () => {
    const a = await repo.recordRecipientOrder(db, details('A4', 'Test Rho', 'ชั้น 1'), at(1));
    const used = await repo.recordRecipientOrder(db, details('B4', 'Test Rho'), at(2), a);
    expect(used).not.toBe(a);
    expect(await one(a)).toMatchObject({ building: 'A4', delivery_note: 'ชั้น 1', order_count: 1 });
  });

  test("a name another customer already has: the order goes to that customer, the id's owner is unchanged (the old 'taken' race)", async () => {
    const a = await repo.recordRecipientOrder(db, details('D2', 'Test Kappa'), at(1));
    const b = await repo.recordRecipientOrder(db, details('D2', 'Test Lambda'), at(1));
    const used = await repo.recordRecipientOrder(db, details('D2', 'Test Kappa'), at(2), b);
    expect(used).toBe(a);
    expect(await one(a)).toMatchObject({ order_count: 2 });
    expect(await one(b)).toMatchObject({ recipient_name: 'Test Lambda', order_count: 1 });
  });

  test('simultaneous orders that name the same customer id and a new recipient make one row and fail none', async () => {
    const a = await repo.recordRecipientOrder(db, details('E1', 'Test Sigma'), at(1));
    const before = await count();
    const ids = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        db.transaction((tx) => repo.recordRecipientOrder(tx, details('E2', 'Test Tau'), at(i), a)),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe(a);
    expect(await count()).toBe(before + 1);
    expect(await one(a)).toMatchObject({ order_count: 1 });
    expect(await one(ids[0] ?? '')).toMatchObject({ order_count: 3 });
  });

  test('a customer with no recipient yet is not given one by id; the order goes to the recipient customer', async () => {
    const id = await insertId(
      "insert into customers (display_name, phone) values ('Test Person', '0800000000') returning id",
    );
    const used = await repo.recordRecipientOrder(db, details('B1', 'Test Theta'), at(1), id);
    expect(used).not.toBe(id);
    expect(await one(id)).toMatchObject({ building: null, order_count: 0, phone: '0800000000' });
  });

  test('an anonymised customer is never reused', async () => {
    const gone = await insertId(
      'insert into customers (anonymized_at) values (now()) returning id',
    );
    const used = await repo.recordRecipientOrder(db, details('B2', 'Test Nu'), at(1), gone);
    expect(used).not.toBe(gone);
    expect(await one(gone)).toMatchObject({ building: null, order_count: 0 });
  });
});

describe('the unique index', () => {
  test('two counter customers cannot share a building and name key; LINE customers may', async () => {
    await client.query(
      "insert into customers (building, recipient_name, recipient_key) values ('B1', 'Test Xi', 'test xi')",
    );
    await expect(
      client.query(
        "insert into customers (building, recipient_name, recipient_key) values ('B1', 'TEST XI', 'test xi')",
      ),
    ).rejects.toThrow(/customers_recipient_key/);
    await client.query(
      "insert into customers (line_user_id, building, recipient_name, recipient_key) values ('U-test-line-2', 'B1', 'Test Xi', 'test xi')",
    );
  });
});

describe('listRecipients', () => {
  const seedRecipients = async () => {
    await client.query('delete from customers');
    await repo.recordRecipientOrder(db, details('B1', 'List Anna', 'note a'), at(1));
    await repo.recordRecipientOrder(db, details('B1', 'List Bella'), at(5));
    await repo.recordRecipientOrder(db, details('C2', 'Other Anna'), at(3));
    await client.query(
      "insert into customers (display_name, phone) values ('No Recipient', '0811111111')",
    );
    await client.query(
      "insert into customers (building, recipient_name, recipient_key, anonymized_at) values ('B1', 'List Gone', 'list gone', now())",
    );
  };

  test('most recent first, only customers with recipient details, not anonymised', async () => {
    await seedRecipients();
    const rows = await repo.listRecipients(db, { limit: 8 });
    expect(rows.map((r) => r.recipientName)).toEqual(['List Bella', 'Other Anna', 'List Anna']);
  });

  test('returns only the five fields staff need', async () => {
    await seedRecipients();
    const [first] = await repo.listRecipients(db, { limit: 1 });
    expect(Object.keys(first ?? {}).sort()).toEqual(
      ['building', 'deliveryNote', 'id', 'lastOrderAt', 'recipientName'].sort(),
    );
  });

  test('filters by building and by name (case insensitive, contains)', async () => {
    await seedRecipients();
    expect(
      (await repo.listRecipients(db, { building: 'B1', limit: 8 })).map((r) => r.recipientName),
    ).toEqual(['List Bella', 'List Anna']);
    expect(
      (await repo.listRecipients(db, { nameKey: recipientKey(' ANNA'), limit: 8 })).map(
        (r) => r.recipientName,
      ),
    ).toEqual(['Other Anna', 'List Anna']);
    expect(
      (await repo.listRecipients(db, { nameKey: 'list', building: 'B1', limit: 8 })).length,
    ).toBe(2);
  });

  test('a wildcard in the search text is a plain character', async () => {
    await seedRecipients();
    expect(await repo.listRecipients(db, { nameKey: '%', limit: 8 })).toEqual([]);
    expect(await repo.listRecipients(db, { nameKey: '_', limit: 8 })).toEqual([]);
    expect(await repo.listRecipients(db, { nameKey: '\\', limit: 8 })).toEqual([]);
  });

  test('honours the limit', async () => {
    await seedRecipients();
    expect(await repo.listRecipients(db, { limit: 2 })).toHaveLength(2);
  });
});
describe('anonymizeCustomer (PDPA erasure)', () => {
  const at2 = new Date(Date.UTC(2026, 9, 2, 6, 0, 0));
  const seedCustomer = async (lineUserId: string | null) =>
    String(
      (
        await client.query<{ id: string }>(
          `insert into customers (line_user_id, display_name, picture_url, nickname, phone, room_no, note,
             building, recipient_name, delivery_note, recipient_key, order_count, total_spent_satang, last_order_at)
           values ($1, 'Test Name', 'https://img.example.test/p.jpg', 'Nick', '0800000000', '101', 'allergy',
             'B1', 'Test Erase', 'ชั้น 2', $2, 4, 12000, now()) returning id`,
          [lineUserId, `test erase ${Math.random()}`],
        )
      ).rows[0]?.id,
    );
  const seedOrder = async (
    customerId: string,
    fulfillment: string,
    over: { recipient?: string | null; note?: string | null } = {},
  ) => {
    const suffix = Math.floor(Math.random() * 1e9);
    return String(
      (
        await client.query<{ id: string }>(
          `insert into orders (order_no, business_date, channel, fulfillment, delivery_building, recipient_name,
             delivery_note, customer_id, status, subtotal_satang, total_satang, client_request_id, note)
           values ($1, '2026-10-02', 'storefront', $2, $3, $4, $5, $6, 'completed', 5000, 5000, gen_random_uuid(), 'kitchen note')
           returning id`,
          [
            `T-${suffix}`,
            fulfillment,
            fulfillment === 'entrance_delivery' ? 'B1' : null,
            over.recipient === undefined ? 'Test Erase' : over.recipient,
            over.note === undefined ? 'ชั้น 2' : over.note,
            customerId,
          ],
        )
      ).rows[0]?.id,
    );
  };

  test('clears every personal field, keeps the row and the counters, and bumps rev and version', async () => {
    const id = await seedCustomer('U-test-erase-1');
    const before = await one(id);
    const result = await repo.anonymizeCustomer(db, id, at2);
    expect(result).toMatchObject({ found: true, changed: true });
    const row = await one(id);
    expect(row).toMatchObject({
      line_user_id: null,
      display_name: null,
      picture_url: null,
      nickname: null,
      phone: null,
      room_no: null,
      note: null,
      building: null,
      recipient_name: null,
      delivery_note: null,
      recipient_key: null,
      order_count: 4,
      total_spent_satang: 12000,
    });
    expect(new Date(String(row?.anonymized_at)).toISOString()).toBe(at2.toISOString());
    expect(Number(row?.version)).toBe(Number(before?.version) + 1);
    expect(Number(row?.rev)).toBeGreaterThan(Number(before?.rev));
  });

  test("the customer's orders keep their building, totals and kitchen note; the name becomes the erased text and the note is cleared", async () => {
    const id = await seedCustomer(null);
    const entrance = await seedOrder(id, 'entrance_delivery');
    const platform = await seedOrder(id, 'platform_delivery', { recipient: null, note: 'x' });
    const other = await seedOrder(await seedCustomer(null), 'entrance_delivery');
    const orderBefore = await one2('orders', entrance);
    const result = await repo.anonymizeCustomer(db, id, at2);
    expect([...(result.found ? result.orderIds : [])].sort()).toEqual([entrance, platform].sort());
    const e = await one2('orders', entrance);
    expect(e).toMatchObject({
      recipient_name: ANONYMIZED_RECIPIENT_NAME,
      delivery_note: null,
      delivery_building: 'B1',
      total_satang: 5000,
      note: 'kitchen note',
      customer_id: id,
    });
    expect(Number(e?.version)).toBe(Number(orderBefore?.version) + 1);
    expect(Number(e?.rev)).toBeGreaterThan(Number(orderBefore?.rev));
    expect(await one2('orders', platform)).toMatchObject({
      recipient_name: null,
      delivery_note: null,
    });
    expect(await one2('orders', other)).toMatchObject({
      recipient_name: 'Test Erase',
      delivery_note: 'ชั้น 2',
    });
  });

  test('an order with nothing personal on it is left alone (no needless rev)', async () => {
    const id = await seedCustomer(null);
    const plain = await seedOrder(id, 'platform_delivery', { recipient: null, note: null });
    const before = await one2('orders', plain);
    const result = await repo.anonymizeCustomer(db, id, at2);
    expect(result).toMatchObject({ found: true, orderIds: [] });
    expect(await one2('orders', plain)).toMatchObject({
      rev: before?.rev,
      version: before?.version,
    });
  });

  test('already anonymised: nothing changes and nothing is bumped', async () => {
    const id = await seedCustomer(null);
    await repo.anonymizeCustomer(db, id, at2);
    const before = await one(id);
    const again = await repo.anonymizeCustomer(db, id, new Date(at2.getTime() + 60_000));
    expect(again).toMatchObject({ found: true, changed: false });
    expect(await one(id)).toEqual(before);
  });

  test('an unknown id is not found', async () => {
    expect(await repo.anonymizeCustomer(db, '0192f3a0-0000-7000-8000-00000000dead', at2)).toEqual({
      found: false,
    });
  });

  test('it frees the recipient name: a new order for that building and name makes a fresh customer', async () => {
    const id = await repo.recordRecipientOrder(db, details('A2', 'Test Free'), at(1));
    await repo.anonymizeCustomer(db, id, at2);
    const next = await repo.recordRecipientOrder(db, details('A2', 'Test Free'), at(2));
    expect(next).not.toBe(id);
    expect(await one(next)).toMatchObject({ order_count: 1 });
    expect(await repo.listRecipients(db, { nameKey: 'test free', limit: 8 })).toHaveLength(1);
  });
});
