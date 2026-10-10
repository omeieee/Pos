import type { PGlite } from '@electric-sql/pglite';
import { ANONYMIZED_BUILDING, ANONYMIZED_RECIPIENT_NAME } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as customersRepo from './customers.ts';
import * as lineRepo from './line.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import * as retention from './retention.ts';

let db: PgliteDb;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
}, 60_000);
afterAll(async () => {
  await client.close();
});

// Made-up people only: no real customer data in tests.
const NOW = new Date(Date.UTC(2026, 10, 20, 3, 30, 0));
const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await client.query<T>(sql, params)).rows;

const PROFILE = {
  fullName: 'Test Person',
  nickname: 'Tee',
  building: 'B1',
  phone: '0812345678',
};

async function customer(): Promise<string> {
  const [row] = await q<{ id: string }>(
    `insert into customers (line_user_id) values ('U' || gen_random_uuid()::text) returning id`,
  );
  return row?.id as string;
}

let seq = 0;
async function finishedOrder(customerId: string, o: { erasedName: boolean }): Promise<string> {
  const [row] = await q<{ id: string }>(
    `insert into orders (order_no, business_date, channel, fulfillment, delivery_building, recipient_name,
       customer_id, member_full_name, member_nickname, member_building, member_phone, status,
       subtotal_satang, total_satang, client_request_id, completed_at)
     values ($1, '2026-10-01', 'line', 'entrance_delivery', $2, $3, $4, 'Test Person', 'Tee', 'B1',
       '0812345678', 'completed', 6500, 6500, gen_random_uuid(), $5)
     returning id`,
    [
      `M-${++seq}`,
      o.erasedName ? ANONYMIZED_BUILDING : 'B1',
      o.erasedName ? ANONYMIZED_RECIPIENT_NAME : 'Test Person',
      customerId,
      new Date(NOW.getTime() - 40 * 86_400_000).toISOString(),
    ],
  );
  return row?.id as string;
}
const memberOf = async (orderId: string) =>
  (
    await q<{ a: string | null; b: string | null; c: string | null; d: string | null }>(
      'select member_full_name a, member_nickname b, member_building c, member_phone d from orders where id = $1',
      [orderId],
    )
  )[0];

describe('the member profile on a customer', () => {
  test('is saved, read back, and a repeat write changes nothing', async () => {
    const id = await customer();
    expect(await customersRepo.getMemberProfile(db, id)).toEqual({
      fullName: null,
      nickname: null,
      building: null,
      phone: null,
    });
    await customersRepo.saveMemberProfile(db, id, PROFILE);
    expect(await customersRepo.getMemberProfile(db, id)).toEqual(PROFILE);
    const [first] = await q<{ version: number }>('select version from customers where id = $1', [
      id,
    ]);
    await customersRepo.saveMemberProfile(db, id, PROFILE);
    const [second] = await q<{ version: number }>('select version from customers where id = $1', [
      id,
    ]);
    expect(second?.version).toBe(first?.version);
  });

  test('erasing the customer clears the profile and the snapshot on every order', async () => {
    const id = await customer();
    await customersRepo.saveMemberProfile(db, id, PROFILE);
    const orderId = await finishedOrder(id, { erasedName: false });

    const result = await customersRepo.anonymizeCustomer(db, id, NOW);
    expect(result.found && result.changed).toBe(true);
    expect(await customersRepo.getMemberProfile(db, id)).toEqual({
      fullName: null,
      nickname: null,
      building: null,
      phone: null,
    });
    expect(await memberOf(orderId)).toEqual({ a: null, b: null, c: null, d: null });
  });

  test('erasing also reaches an order whose recipient name was already erased but still holds a phone', async () => {
    const id = await customer();
    const orderId = await finishedOrder(id, { erasedName: true });
    await customersRepo.anonymizeCustomer(db, id, NOW);
    expect(await memberOf(orderId)).toEqual({ a: null, b: null, c: null, d: null });
  });
});

describe('the 30-day retention of the member snapshot', () => {
  test('clears it on a finished order, including one whose name was already erased; a second run writes nothing', async () => {
    const id = await customer();
    const plain = await finishedOrder(id, { erasedName: false });
    const half = await finishedOrder(id, { erasedName: true });
    const before = new Date(NOW.getTime() - 30 * 86_400_000);

    const first = await retention.anonymizeOrderSnapshotsBatch(db, {
      before,
      limit: 100,
      now: NOW,
    });
    expect(first).toBeGreaterThanOrEqual(2);
    for (const orderId of [plain, half]) {
      expect(await memberOf(orderId)).toEqual({ a: null, b: null, c: null, d: null });
    }
    const second = await retention.anonymizeOrderSnapshotsBatch(db, {
      before,
      limit: 100,
      now: NOW,
    });
    expect(second).toBe(0);
  });
});

describe('chat-button replies', () => {
  test('the first claim of a customer, button and day wins; others lose until released or the next day', async () => {
    const id = await customer();
    expect(await lineRepo.claimButtonReply(db, id, 'status', '2026-11-20')).toBe(true);
    expect(await lineRepo.claimButtonReply(db, id, 'status', '2026-11-20')).toBe(false);
    expect(await lineRepo.claimButtonReply(db, id, 'menu', '2026-11-20')).toBe(true);
    expect(await lineRepo.claimButtonReply(db, id, 'status', '2026-11-21')).toBe(true);
    await lineRepo.releaseButtonReply(db, id, 'status', '2026-11-20');
    expect(await lineRepo.claimButtonReply(db, id, 'status', '2026-11-20')).toBe(true);
  });

  test('old marks are purged and today stays', async () => {
    const id = await customer();
    await lineRepo.claimButtonReply(db, id, 'hours', '2026-01-01');
    await lineRepo.claimButtonReply(db, id, 'hours', '2026-11-20');
    const deleted = await retention.purgeButtonRepliesBatch(db, {
      beforeDate: '2026-11-13',
      limit: 100,
    });
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await lineRepo.claimButtonReply(db, id, 'hours', '2026-11-20')).toBe(false);
    expect(await lineRepo.claimButtonReply(db, id, 'hours', '2026-01-01')).toBe(true);
  });
});
