import type { PGlite } from '@electric-sql/pglite';
import { recipientKey } from '@sds/shared';
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

describe('recordRecipientOrder: a customer id from the client', () => {
  test('a customer without recipient details gets them, and the count', async () => {
    const [row] = (
      await client.query<{ id: string }>(
        "insert into customers (display_name, phone) values ('Test Person', '0800000000') returning id",
      )
    ).rows;
    const id = await repo.recordRecipientOrder(db, details('B1', 'Test Theta'), at(1), row?.id);
    expect(id).toBe(row?.id);
    expect(await one(id)).toMatchObject({
      building: 'B1',
      recipient_name: 'Test Theta',
      order_count: 1,
      phone: '0800000000', // other fields untouched
    });
  });

  test('a LINE customer is only updated, never matched by name', async () => {
    const [line] = (
      await client.query<{ id: string }>(
        "insert into customers (line_user_id, display_name) values ('U-test-line-1', 'Test Line') returning id",
      )
    ).rows;
    const lineId = line?.id;
    // Same building and name as an existing counter customer: still its own row.
    const counter = await repo.recordRecipientOrder(db, details('C2', 'Test Iota'), at(1));
    const used = await repo.recordRecipientOrder(db, details('C2', 'Test Iota'), at(2), lineId);
    expect(used).toBe(lineId);
    expect(used).not.toBe(counter);
    expect(await one(counter)).toMatchObject({ order_count: 1 });
    expect(await one(lineId ?? '')).toMatchObject({
      building: 'C2',
      recipient_name: 'Test Iota',
      order_count: 1,
      line_user_id: 'U-test-line-1',
    });
    // Without its id, a new order for that name goes to the counter customer, not the LINE one.
    const next = await repo.recordRecipientOrder(db, details('C2', 'Test Iota'), at(3));
    expect(next).toBe(counter);
  });

  test('a counter customer renamed to a name another customer already has: the order goes to that customer', async () => {
    const a = await repo.recordRecipientOrder(db, details('D2', 'Test Kappa'), at(1));
    const b = await repo.recordRecipientOrder(db, details('D2', 'Test Lambda'), at(1));
    const used = await repo.recordRecipientOrder(db, details('D2', 'Test Kappa'), at(2), b);
    expect(used).toBe(a);
    expect(await one(a)).toMatchObject({ order_count: 2 });
    expect(await one(b)).toMatchObject({ recipient_name: 'Test Lambda', order_count: 1 });
  });

  test('a counter customer renamed to a free name is renamed (last used)', async () => {
    const a = await repo.recordRecipientOrder(db, details('A1', 'Test Mu'), at(1));
    const used = await repo.recordRecipientOrder(db, details('A1', 'Test Mu Two'), at(2), a);
    expect(used).toBe(a);
    expect(await one(a)).toMatchObject({
      recipient_name: 'Test Mu Two',
      recipient_key: 'test mu two',
      order_count: 2,
    });
  });

  test('an anonymised customer is never reused', async () => {
    const [gone] = (
      await client.query<{ id: string }>(
        'insert into customers (anonymized_at) values (now()) returning id',
      )
    ).rows;
    const used = await repo.recordRecipientOrder(db, details('B2', 'Test Nu'), at(1), gone?.id);
    expect(used).not.toBe(gone?.id);
    expect(await one(gone?.id ?? '')).toMatchObject({ building: null, order_count: 0 });
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
