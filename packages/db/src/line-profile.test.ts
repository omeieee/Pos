import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as customersRepo from './customers.ts';
import * as lineRepo from './line.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import * as retention from './retention.ts';
import { SYNC_POLICY } from './sync.ts';

let db: PgliteDb;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
}, 60_000);
afterAll(async () => {
  await client.close();
});

// Made-up people only: no real customer data in tests.
const T0 = new Date(Date.UTC(2026, 9, 12, 3, 0, 0));
const DAY = 86_400_000;
const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await client.query<T>(sql, params)).rows;

const lineId = () => `U${crypto.randomUUID().replaceAll('-', '')}`;
const PROFILE = { displayName: 'Tee Test', pictureUrl: 'https://profile.line-scdn.net/test/p' };

describe('the LINE profile on a customer', () => {
  test('is saved once, read back, and kept for a week before LINE is believed again', async () => {
    const userId = lineId();
    const { id } = await lineRepo.upsertLiffCustomer(db, userId);
    expect(await lineRepo.getLineProfile(db, id)).toEqual({ displayName: null, pictureUrl: null });

    await lineRepo.saveLineProfile(db, userId, PROFILE, T0);
    expect(await lineRepo.getLineProfile(db, id)).toEqual(PROFILE);

    const [first] = await q<{ version: number }>('select version from customers where id = $1', [
      id,
    ]);
    // Within the week nothing is written, even when LINE says something else.
    await lineRepo.saveLineProfile(
      db,
      userId,
      { displayName: 'New Name', pictureUrl: null },
      new Date(T0.getTime() + 2 * DAY),
    );
    expect(await lineRepo.getLineProfile(db, id)).toEqual(PROFILE);
    const [second] = await q<{ version: number }>('select version from customers where id = $1', [
      id,
    ]);
    expect(second?.version).toBe(first?.version);

    // After the week it is refreshed.
    await lineRepo.saveLineProfile(
      db,
      userId,
      { displayName: 'New Name', pictureUrl: null },
      new Date(T0.getTime() + 8 * DAY),
    );
    expect(await lineRepo.getLineProfile(db, id)).toEqual({
      displayName: 'New Name',
      pictureUrl: null,
    });
  });

  test('a name that is empty or a picture that is not https is not stored', async () => {
    const userId = lineId();
    const { id } = await lineRepo.upsertLiffCustomer(db, userId);
    await lineRepo.saveLineProfile(
      db,
      userId,
      { displayName: '   ', pictureUrl: 'http://example.test/p' },
      T0,
    );
    expect(await lineRepo.getLineProfile(db, id)).toEqual({ displayName: null, pictureUrl: null });
  });

  test('an erased customer is never given a profile again', async () => {
    const userId = lineId();
    const { id } = await lineRepo.upsertLiffCustomer(db, userId);
    await customersRepo.anonymizeCustomer(db, id, T0);
    await lineRepo.saveLineProfile(db, userId, PROFILE, T0);
    expect(await lineRepo.getLineProfile(db, id)).toEqual({ displayName: null, pictureUrl: null });
  });

  test('the sync feed of customers keeps the picture and the refresh time to itself', () => {
    expect(SYNC_POLICY.customers.deny).toContain('pictureUrl');
    expect(SYNC_POLICY.customers.deny).toContain('lineProfileAt');
  });
});

let seq = 0;
async function finishedOrder(customerId: string): Promise<string> {
  const [row] = await q<{ id: string }>(
    `insert into orders (order_no, business_date, channel, fulfillment, customer_id,
       line_display_name, line_picture_url, status, subtotal_satang, total_satang,
       client_request_id, completed_at)
     values ($1, '2026-09-01', 'line', 'pickup', $2, 'Tee Test', 'https://profile.line-scdn.net/p',
       'completed', 6500, 6500, gen_random_uuid(), $3)
     returning id`,
    [`LP-${++seq}`, customerId, new Date(T0.getTime() - 40 * DAY).toISOString()],
  );
  return row?.id as string;
}
const lineOf = async (orderId: string) =>
  (
    await q<{ a: string | null; b: string | null }>(
      'select line_display_name a, line_picture_url b from orders where id = $1',
      [orderId],
    )
  )[0];

describe('the LINE profile on an order', () => {
  test('erasing the customer clears the name and picture on the customer and on every order', async () => {
    const userId = lineId();
    const { id } = await lineRepo.upsertLiffCustomer(db, userId);
    await lineRepo.saveLineProfile(db, userId, PROFILE, T0);
    const orderId = await finishedOrder(id);
    await customersRepo.anonymizeCustomer(db, id, T0);
    expect(await lineOf(orderId)).toEqual({ a: null, b: null });
    const [row] = await q<{ d: string | null; p: string | null; at: Date | null }>(
      'select display_name d, picture_url p, line_profile_at at from customers where id = $1',
      [id],
    );
    expect(row).toEqual({ d: null, p: null, at: null });
  });

  test('the 30-day retention clears them on a finished order; a second run writes nothing', async () => {
    const { id } = await lineRepo.upsertLiffCustomer(db, lineId());
    const orderId = await finishedOrder(id);
    const before = new Date(T0.getTime() - 30 * DAY);
    const first = await retention.anonymizeOrderSnapshotsBatch(db, {
      before,
      limit: 100,
      now: T0,
    });
    expect(first.anonymized).toBeGreaterThanOrEqual(1);
    expect(await lineOf(orderId)).toEqual({ a: null, b: null });
    expect(
      (await retention.anonymizeOrderSnapshotsBatch(db, { before, limit: 100, now: T0 }))
        .anonymized,
    ).toBe(0);
  });
});
