import type { PGlite } from '@electric-sql/pglite';
import {
  ANONYMIZED_BUILDING,
  ANONYMIZED_RECIPIENT_NAME,
  ANONYMIZED_ROOM_NO,
  RETENTION_DAYS,
} from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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

// Made-up people and buildings only: no real customer data in tests.
const NOW = new Date(Date.UTC(2026, 10, 20, 3, 30, 0));
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await client.query<T>(sql, params)).rows;

let seq = 0;
async function order(args: {
  status?: string;
  completedDaysAgo?: number;
  cancelledDaysAgo?: number;
  fulfillment?: string;
  recipient?: string | null;
  building?: string | null;
  note?: string | null;
  roomNo?: string | null;
  customerId?: string | null;
  totalSatang?: number;
}) {
  const status = args.status ?? 'completed';
  const fulfillment = args.fulfillment ?? 'entrance_delivery';
  const total = args.totalSatang ?? 6500;
  const [row] = await q<{ id: string }>(
    `insert into orders (order_no, business_date, channel, fulfillment, room_no, delivery_building, recipient_name,
       delivery_note, customer_id, status, subtotal_satang, total_satang, client_request_id, completed_at, cancelled_at)
     values ($1, '2026-10-01', 'storefront', $2, $3, $4, $5, $6, $7, $8, $9, $9, gen_random_uuid(), $10, $11)
     returning id`,
    [
      `R-${++seq}`,
      fulfillment,
      args.roomNo ?? null,
      args.building === undefined
        ? fulfillment === 'entrance_delivery'
          ? 'B1'
          : null
        : args.building,
      args.recipient === undefined
        ? fulfillment === 'entrance_delivery'
          ? 'Test Person'
          : null
        : args.recipient,
      args.note ?? null,
      args.customerId ?? null,
      status,
      total,
      args.completedDaysAgo === undefined ? null : daysAgo(args.completedDaysAgo),
      args.cancelledDaysAgo === undefined ? null : daysAgo(args.cancelledDaysAgo),
    ],
  );
  return row?.id as string;
}
const orderRow = async (id: string) =>
  (
    await q<{
      recipient_name: string | null;
      delivery_building: string | null;
      delivery_note: string | null;
      room_no: string | null;
      total_satang: string;
      subtotal_satang: string;
      version: number;
      rev: string;
    }>(
      'select recipient_name, delivery_building, delivery_note, room_no, total_satang, subtotal_satang, version, rev from orders where id = $1',
      [id],
    )
  )[0];

describe('retention days', () => {
  test('the owner decided 30 days for each of the three', () => {
    expect(RETENTION_DAYS).toEqual({ lineEvents: 30, orderPersonalData: 30, recipientBook: 30 });
  });
});

describe('purgeLineEventsBatch', () => {
  const event = (id: string, ageDays: number) =>
    client.query(
      `insert into line_events (webhook_event_id, type, user_id, route, received_at)
       values ($1, 'follow', 'Utest-ret', '{"kind":"follow","userId":"Utest-ret"}'::jsonb, $2)`,
      [id, daysAgo(ageDays)],
    );
  const left = async () =>
    (
      await q<{ webhook_event_id: string }>(
        "select webhook_event_id from line_events where webhook_event_id like 'ret-%' order by 1",
      )
    ).map((r) => r.webhook_event_id);

  test('deletes rows older than the cutoff, a bounded batch at a time, and writes a counts-only audit row', async () => {
    await event('ret-a', 31);
    await event('ret-b', 45);
    await event('ret-c', 40);
    await event('ret-keep', 29);
    const before = new Date(NOW.getTime() - RETENTION_DAYS.lineEvents * 86_400_000);

    expect(await retention.purgeLineEventsBatch(db, { before, limit: 2, now: NOW })).toBe(2);
    expect(await left()).toHaveLength(2); // one old row and the recent one
    expect(await retention.purgeLineEventsBatch(db, { before, limit: 2, now: NOW })).toBe(1);
    expect(await left()).toEqual(['ret-keep']);
    // Nothing left to do: no change and no audit row.
    expect(await retention.purgeLineEventsBatch(db, { before, limit: 2, now: NOW })).toBe(0);

    const audit = await q<{
      actor_type: string;
      action: string;
      after: unknown;
      entity_id: string | null;
    }>(
      "select actor_type, action, after, entity_id from audit_log where action = 'retention.line_events.purge' order by at",
    );
    expect(audit.map((a) => a.after)).toEqual([
      { deleted: 2, olderThanDays: 30 },
      { deleted: 1, olderThanDays: 30 },
    ]);
    expect(audit.every((a) => a.actor_type === 'system')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('Utest-ret');
  });
});

describe('anonymizeOrderSnapshotsBatch', () => {
  const cutoff = () => new Date(NOW.getTime() - RETENTION_DAYS.orderPersonalData * 86_400_000);
  const run = (limit = 100) =>
    retention.anonymizeOrderSnapshotsBatch(db, { before: cutoff(), limit, now: NOW });

  test('replaces name and building 30 days after completion and keeps amounts', async () => {
    const old = await order({ completedDaysAgo: 31, note: 'leave at the desk, room 12' });
    const recent = await order({ completedDaysAgo: 29, note: 'keep me' });
    const before = await orderRow(old);

    expect(await run()).toBeGreaterThanOrEqual(1);

    const after = await orderRow(old);
    expect(after).toMatchObject({
      recipient_name: ANONYMIZED_RECIPIENT_NAME,
      delivery_building: ANONYMIZED_BUILDING,
      delivery_note: null,
      total_satang: before?.total_satang,
      subtotal_satang: before?.subtotal_satang,
    });
    // The synced columns moved, so devices catch the change up.
    expect(Number(after?.version)).toBe(Number(before?.version) + 1);
    expect(BigInt(after?.rev ?? 0)).toBeGreaterThan(BigInt(before?.rev ?? 0));
    expect(await orderRow(recent)).toMatchObject({
      recipient_name: 'Test Person',
      delivery_building: 'B1',
      delivery_note: 'keep me',
    });
  });

  test('a cancelled order counts from its cancellation; an open order is never touched', async () => {
    const cancelled = await order({ status: 'cancelled', cancelledDaysAgo: 35 });
    const open = await order({ status: 'new' });
    await run();
    expect((await orderRow(cancelled))?.recipient_name).toBe(ANONYMIZED_RECIPIENT_NAME);
    expect((await orderRow(open))?.recipient_name).toBe('Test Person');
  });

  test('a legacy room delivery loses the name, the building and the room number', async () => {
    const id = await order({
      completedDaysAgo: 40,
      fulfillment: 'room_delivery',
      roomNo: '1203',
      recipient: 'Legacy Person',
      building: 'C2',
    });
    await run();
    expect(await orderRow(id)).toMatchObject({
      recipient_name: null,
      delivery_building: null,
      room_no: ANONYMIZED_ROOM_NO,
    });
  });

  test('is idempotent: a second run changes nothing and bumps no version', async () => {
    const id = await order({ completedDaysAgo: 50 });
    await run();
    const first = await orderRow(id);
    expect(await run()).toBe(0);
    expect(await orderRow(id)).toEqual(first);
  });

  test('works in bounded batches and audits counts only', async () => {
    for (let i = 0; i < 3; i++) await order({ completedDaysAgo: 60 + i, recipient: `Batch ${i}` });
    const first = await run(2);
    expect(first).toBe(2);
    expect(await run(2)).toBe(1);
    expect(await run(2)).toBe(0);
    const audit = await q<{ after: Record<string, unknown> }>(
      "select after from audit_log where action = 'retention.orders.anonymize' and after = $1::jsonb",
      [JSON.stringify({ anonymized: 2, afterDays: 30 })],
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const everyAudit = JSON.stringify(
      await q("select after, before, entity_id from audit_log where action like 'retention.%'"),
    );
    expect(everyAudit).not.toContain('Batch');
    expect(everyAudit).not.toContain('Test Person');
  });
});

describe('expireRecipientsBatch', () => {
  const cutoff = () => new Date(NOW.getTime() - RETENTION_DAYS.recipientBook * 86_400_000);
  const run = (limit = 100) =>
    retention.expireRecipientsBatch(db, { before: cutoff(), limit, now: NOW });
  let n = 0;
  async function recipient(args: {
    lastOrderDaysAgo?: number | null;
    firstSeenDaysAgo?: number;
    lineUserId?: string;
    phoneOnly?: boolean;
  }) {
    const i = ++n;
    const [row] = await q<{ id: string }>(
      `insert into customers (line_user_id, building, recipient_name, recipient_key, phone, delivery_note, last_order_at, first_seen_at, order_count)
       values ($1, $2, $3, $4, $5, 'note', $6, $7, 1) returning id`,
      [
        args.lineUserId ?? null,
        args.phoneOnly ? null : 'A1',
        args.phoneOnly ? null : `Recipient ${i}`,
        args.phoneOnly ? null : `recipient ${i}`,
        '0800000000',
        args.lastOrderDaysAgo === null || args.lastOrderDaysAgo === undefined
          ? null
          : daysAgo(args.lastOrderDaysAgo),
        daysAgo(args.firstSeenDaysAgo ?? 100),
      ],
    );
    return row?.id as string;
  }
  const cust = async (id: string) =>
    (
      await q<{
        anonymized_at: Date | null;
        recipient_name: string | null;
        building: string | null;
        phone: string | null;
        delivery_note: string | null;
        line_user_id: string | null;
      }>(
        'select anonymized_at, recipient_name, building, phone, delivery_note, line_user_id from customers where id = $1',
        [id],
      )
    )[0];

  test('erases a recipient 30 days after their last order, and their orders lose the name too', async () => {
    const id = await recipient({ lastOrderDaysAgo: 31 });
    const o = await order({ customerId: id, completedDaysAgo: 31 });
    const kept = await recipient({ lastOrderDaysAgo: 29 });

    const result = await run();
    expect(result).toMatchObject({ customers: expect.any(Number) });
    expect(result.customers).toBeGreaterThanOrEqual(1);

    expect(await cust(id)).toMatchObject({
      recipient_name: null,
      building: null,
      phone: null,
      delivery_note: null,
    });
    expect((await cust(id))?.anonymized_at).not.toBeNull();
    expect((await orderRow(o))?.recipient_name).toBe(ANONYMIZED_RECIPIENT_NAME);
    expect((await cust(kept))?.anonymized_at).toBeNull();
    expect((await cust(kept))?.recipient_name).not.toBeNull();
  });

  test('a recipient with a newer order is kept (the clock is the last order)', async () => {
    const id = await recipient({ lastOrderDaysAgo: 3, firstSeenDaysAgo: 200 });
    await run();
    expect((await cust(id))?.anonymized_at).toBeNull();
  });

  test('a recipient who never ordered counts from the day they were saved', async () => {
    const stale = await recipient({ lastOrderDaysAgo: null, firstSeenDaysAgo: 45 });
    const fresh = await recipient({ lastOrderDaysAgo: null, firstSeenDaysAgo: 5 });
    await run();
    expect((await cust(stale))?.anonymized_at).not.toBeNull();
    expect((await cust(fresh))?.anonymized_at).toBeNull();
  });

  test('leaves LINE customers, customers with no recipient, and customers with an open order', async () => {
    const line = await recipient({ lastOrderDaysAgo: 60, lineUserId: 'Utest-ret-line' });
    const phone = await recipient({ lastOrderDaysAgo: 60, phoneOnly: true });
    const busy = await recipient({ lastOrderDaysAgo: 60 });
    await order({ customerId: busy, status: 'preparing' });
    await run();
    expect((await cust(line))?.anonymized_at).toBeNull();
    expect((await cust(line))?.line_user_id).toBe('Utest-ret-line');
    expect((await cust(phone))?.anonymized_at).toBeNull();
    expect((await cust(phone))?.phone).toBe('0800000000');
    expect((await cust(busy))?.anonymized_at).toBeNull();
  });

  test('is idempotent and bounded, and audits counts only', async () => {
    const ids = [
      await recipient({ lastOrderDaysAgo: 70 }),
      await recipient({ lastOrderDaysAgo: 71 }),
      await recipient({ lastOrderDaysAgo: 72 }),
    ];
    const total = (await run(2)).customers + (await run(2)).customers;
    expect(total).toBeGreaterThanOrEqual(3);
    expect(await run(2)).toEqual({ customers: 0, orders: 0 });
    for (const id of ids) expect((await cust(id))?.anonymized_at).not.toBeNull();
    const audits = JSON.stringify(
      await q(
        "select after, before, entity_id from audit_log where action = 'retention.recipients.expire'",
      ),
    );
    expect(audits).not.toContain('Recipient ');
    expect(audits).not.toContain('0800000000');
    for (const id of ids) expect(audits).not.toContain(id);
  });
});
