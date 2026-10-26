import {
  ANONYMIZED_BUILDING,
  ANONYMIZED_RECIPIENT_NAME,
  customerDtoSchema,
  orderDtoSchema,
} from '@sds/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { AppEvent } from '../events.ts';
import { createLineRuntime } from '../line/runtime.ts';
import {
  type AccountInfoResult,
  installSlipVerifier,
  type SlipVerifier,
} from '../slips/slip2go.ts';
import { createMemorySlipStore } from '../slips/store.ts';
import { withFailingWrite } from '../test-support/fail-trigger.ts';
import { createHarness, type Harness } from '../test-support/harness.ts';
import { JOBS, type JobDeps } from './jobs.ts';
import { purgeLineEvents, purgeStaffInvites, RETENTION_BATCH } from './retention.ts';

let h: Harness;
let deps: JobDeps;
const slips = createMemorySlipStore();
beforeAll(async () => {
  h = await createHarness();
  deps = {
    db: h.db,
    events: h.bus,
    now: h.clock.now,
    line: createLineRuntime({ channelSecret: undefined, channelAccessToken: undefined }),
    slips,
  };
}, 60_000);
afterAll(async () => {
  await h.close();
});

const daysAgo = (days: number) =>
  new Date(h.clock.now().getTime() - days * 86_400_000).toISOString();
const job = (name: string) => {
  const found = JOBS.find((j) => j.name === name);
  if (!found) throw new Error(`no job ${name}`);
  return found;
};

describe('the job list', () => {
  test('has unique names and a five-field cron each, and covers the retention jobs and the sweep', () => {
    const names = JOBS.map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'line-events-retry',
        'retention-line-events',
        'retention-orders',
        'retention-recipients',
        'retention-line-customers',
        'retention-staff-invites',
        'retention-button-replies',
        'retention-member-profiles',
        'slip2go-account-check',
      ]),
    );
    for (const j of JOBS) expect(j.cron.trim().split(/\s+/)).toHaveLength(5);
  });
});

describe('retention jobs', () => {
  test('delete invites that were accepted, revoked or expired more than 30 days ago, and no others', async () => {
    const owner = await h.newOwner();
    const insert = async (
      tag: string,
      o: { created: number; expires: number; accepted?: number; revoked?: number },
    ) => {
      await h.client.query(
        `insert into staff_invites (email, role, token_hash, created_by, created_at, expires_at, accepted_at, revoked_at)
         values ($1, 'cashier', $2, $3, $4, $5, $6, $7)`,
        [
          `${tag}@example.test`,
          `hash-${tag}`,
          owner.staffId,
          daysAgo(o.created),
          daysAgo(o.expires),
          o.accepted === undefined ? null : daysAgo(o.accepted),
          o.revoked === undefined ? null : daysAgo(o.revoked),
        ],
      );
    };
    await insert('old-accepted', { created: 50, expires: 47, accepted: 45 });
    await insert('old-revoked', { created: 50, expires: 47, revoked: 40 });
    await insert('old-expired', { created: 50, expires: 35 });
    await insert('recent-accepted', { created: 10, expires: 7, accepted: 5 });
    await insert('recent-revoked', { created: 10, expires: 7, revoked: 5 });
    await insert('recent-expired', { created: 33, expires: 29 });
    await insert('open', { created: 1, expires: -2 });

    expect(await purgeStaffInvites(deps, { batchSize: 2, maxBatches: 5 })).toEqual({ deleted: 3 });
    const left = (await h.client.query<{ email: string }>('select email from staff_invites')).rows
      .map((r) => r.email.split('@')[0])
      .sort();
    expect(left).toEqual(['open', 'recent-accepted', 'recent-expired', 'recent-revoked']);
    expect(await job('retention-staff-invites').run(deps)).toEqual({ deleted: 0 });
    const audit = (
      await h.client.query<{ after: unknown }>(
        "select after from audit_log where action = 'retention.staff_invites.purge'",
      )
    ).rows;
    expect(JSON.stringify(audit)).not.toContain('@');
  });

  test('delete old line events in bounded runs: at most batch size times max batches a run', async () => {
    for (let i = 0; i < 5; i++) {
      await h.client.query(
        `insert into line_events (webhook_event_id, type, user_id, route, received_at)
         values ($1, 'follow', 'Utest-job', '{"kind":"ignore"}'::jsonb, $2)`,
        [`job-ev-${i}`, daysAgo(40 + i)],
      );
    }
    const first = await purgeLineEvents(deps, { batchSize: 2, maxBatches: 2 });
    expect(first).toEqual({ deleted: 4 });
    expect(await purgeLineEvents(deps, { batchSize: 2, maxBatches: 2 })).toEqual({ deleted: 1 });
    expect(await purgeLineEvents(deps)).toEqual({ deleted: 0 });
    // The scheduled job is the same function with the default bounds.
    expect(await job('retention-line-events').run(deps)).toEqual({ deleted: 0 });
  });

  test('anonymise finished orders and expire recipients; a second run does nothing', async () => {
    const [cust] = (
      await h.client.query<{ id: string }>(
        `insert into customers (building, recipient_name, recipient_key, last_order_at, order_count)
         values ('D2', 'Job Person', 'job person', $1, 1) returning id`,
        [daysAgo(33)],
      )
    ).rows;
    const [ord] = (
      await h.client.query<{ id: string }>(
        `insert into orders (order_no, business_date, channel, fulfillment, delivery_building, recipient_name,
           delivery_note, customer_id, status, subtotal_satang, total_satang, client_request_id, completed_at)
         values ('J-1', '2026-09-10', 'storefront', 'entrance_delivery', 'D2', 'Job Person', 'ring twice', $1,
           'completed', 8000, 8000, gen_random_uuid(), $2) returning id`,
        [cust?.id, daysAgo(33)],
      )
    ).rows;

    expect(await job('retention-orders').run(deps)).toEqual({ anonymized: 1 });
    const order = (
      await h.client.query<{
        recipient_name: string;
        delivery_building: string;
        delivery_note: string | null;
        total_satang: number;
      }>(
        'select recipient_name, delivery_building, delivery_note, total_satang from orders where id = $1',
        [ord?.id],
      )
    ).rows[0];
    expect(order).toMatchObject({
      recipient_name: ANONYMIZED_RECIPIENT_NAME,
      delivery_building: ANONYMIZED_BUILDING,
      delivery_note: null,
      total_satang: 8000,
    });

    expect(await job('retention-recipients').run(deps)).toEqual({ customers: 1, orders: 0 });
    const c = (
      await h.client.query<{ anonymized_at: Date | null; recipient_name: string | null }>(
        'select anonymized_at, recipient_name from customers where id = $1',
        [cust?.id],
      )
    ).rows[0];
    expect(c?.anonymized_at).not.toBeNull();
    expect(c?.recipient_name).toBeNull();

    // An app visitor who never ordered or acknowledged is erased by the line-customers job.
    const visitor = await h.client.query<{ id: string }>(
      "insert into customers (line_user_id, first_seen_at) values ('Utest-job-visitor', $1) returning id",
      [new Date(deps.now().getTime() - 40 * 86_400_000).toISOString()],
    );
    expect(await job('retention-line-customers').run(deps)).toEqual({ customers: 1 });
    expect(
      (
        await h.client.query('select line_user_id from customers where id = $1', [
          visitor.rows[0]?.id,
        ])
      ).rows[0],
    ).toMatchObject({ line_user_id: null });

    // Idempotent: nothing left to change.
    expect(await job('retention-orders').run(deps)).toEqual({ anonymized: 0 });
    expect(await job('retention-recipients').run(deps)).toEqual({ customers: 0, orders: 0 });

    const audit = await h.client.query<{ actor_type: string; action: string; after: unknown }>(
      "select actor_type, action, after from audit_log where action like 'retention.%' order by at",
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'retention.line_events.purge',
        'retention.orders.anonymize',
        'retention.recipients.expire',
      ]),
    );
    expect(audit.rows.every((r) => r.actor_type === 'system')).toBe(true);
    const text = JSON.stringify(audit.rows);
    expect(text).not.toContain('Job Person');
    expect(text).not.toContain('D2');
    expect(text).not.toContain('Utest-job');
  });

  test('member profile fields are cleared after 24 months without an order, counts only', async () => {
    const old = new Date(deps.now().getTime() - 740 * 86_400_000).toISOString();
    const fresh = new Date(deps.now().getTime() - 100 * 86_400_000).toISOString();
    const make = async (lastOrderAt: string) =>
      (
        await h.client.query<{ id: string }>(
          `insert into customers (line_user_id, last_order_at, full_name, nickname, phone, member_building)
           values ($1, $2, 'Job Member', 'Jm', '0800000001', 'D9') returning id`,
          [`Utest-job-member-${crypto.randomUUID()}`, lastOrderAt],
        )
      ).rows[0]?.id as string;
    const stale = await make(old);
    const recent = await make(fresh);
    expect(await job('retention-member-profiles').run(deps)).toEqual({ customers: 1 });
    const state = async (id: string) =>
      (await h.client.query('select full_name, phone from customers where id = $1', [id])).rows[0];
    expect(await state(stale)).toEqual({ full_name: null, phone: null });
    expect(await state(recent)).toEqual({ full_name: 'Job Member', phone: '0800000001' });
    expect(await job('retention-member-profiles').run(deps)).toEqual({ customers: 0 });
    const audit = await h.client.query(
      "select actor_type, after from audit_log where action = 'retention.member_profiles.expire'",
    );
    expect(audit.rows).toEqual([{ actor_type: 'system', after: { customers: 1, afterDays: 730 } }]);
  });

  test('the slip purge publishes order.upserted, after commit, for each order whose flag changed', async () => {
    const seed = async (status: 'claimed' | 'cancelled', key: string) => {
      const [ord] = (
        await h.client.query<{ id: string }>(
          `insert into orders (order_no, business_date, channel, fulfillment, delivery_building, recipient_name,
             status, subtotal_satang, total_satang, client_request_id)
           values ($1, '2026-09-10', 'storefront', 'entrance_delivery', 'D3', 'Slip Person',
             'completed', 8000, 8000, gen_random_uuid()) returning id`,
          [`JS-${Math.floor(Math.random() * 1e9)}`],
        )
      ).rows;
      // The sync trigger stamps updated_at; replica mode skips it so the payment can be old.
      await h.client.query("set session_replication_role = 'replica'");
      await h.client.query(
        `insert into payments (order_id, method, status, amount_satang, slip_image_key, void_reason, client_request_id, updated_at)
         values ($1, 'promptpay', $2, 8000, $3, $4, gen_random_uuid(), $5)`,
        [ord?.id, status, key, status === 'claimed' ? null : 'test', daysAgo(120)],
      );
      await h.client.query("set session_replication_role = 'origin'");
      await slips.put(key, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
      return ord?.id as string;
    };
    const claimedOrder = await seed('claimed', 'q'.repeat(32));
    const cancelledOrder = await seed('cancelled', 'r'.repeat(32));
    const before = h.events.length;

    expect(await job('retention-slips').run(deps)).toEqual({ deleted: 2, failed: 0 });

    const upserted = h.events
      .slice(before)
      .filter((e) => e.type === 'order.upserted')
      .map((e) => e.id);
    expect(upserted).toEqual([claimedOrder]);
    expect(upserted).not.toContain(cancelledOrder);
    const event = h.events.slice(before).find((e) => e.type === 'order.upserted');
    if (event?.type !== 'order.upserted') throw new Error('expected order.upserted');
    const row = (
      await h.client.query<{ rev: string; claim_without_slip: boolean }>(
        'select rev, claim_without_slip from orders where id = $1',
        [claimedOrder],
      )
    ).rows[0];
    expect(row?.claim_without_slip).toBe(true);
    expect(event.rev).toBe(Number(row?.rev));
    expect(orderDtoSchema.parse(event.data)).toMatchObject({ claimWithoutSlip: true });
    expect(JSON.stringify(event)).not.toContain('q'.repeat(32));
    // Nothing left to clear: a second run publishes nothing.
    const after = h.events.length;
    expect(await job('retention-slips').run(deps)).toEqual({ deleted: 0, failed: 0 });
    expect(h.events.length).toBe(after);
  });

  test('the slip purge also publishes payment.upserted for each payment that lost its slip (BE-02)', async () => {
    const [ord] = (
      await h.client.query<{ id: string }>(
        `insert into orders (order_no, business_date, channel, fulfillment, status, subtotal_satang,
           total_satang, client_request_id)
         values ($1, '2026-09-10', 'storefront', 'pickup', 'completed', 8000, 8000, gen_random_uuid())
         returning id`,
        [`JP-${Math.floor(Math.random() * 1e9)}`],
      )
    ).rows;
    const key = 'p'.repeat(32);
    // The sync trigger stamps updated_at; replica mode skips it so the payment can be old.
    await h.client.query("set session_replication_role = 'replica'");
    const [pay] = await h.client
      .query<{ id: string }>(
        `insert into payments (order_id, method, status, amount_satang, slip_image_key, void_reason,
           client_request_id, updated_at)
         values ($1, 'promptpay', 'cancelled', 8000, $2, 'test', gen_random_uuid(), $3) returning id`,
        [ord?.id, key, daysAgo(120)],
      )
      .then((r) => r.rows)
      .finally(() => h.client.query("set session_replication_role = 'origin'"));
    await slips.put(key, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    const before = h.events.length;

    await job('retention-slips').run(deps);

    const events = h.events
      .slice(before)
      .filter((e) => e.type === 'payment.upserted' && e.id === pay?.id);
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event?.type !== 'payment.upserted') throw new Error('expected payment.upserted');
    const row = (
      await h.client.query<{ rev: string; version: number }>(
        'select rev, version from payments where id = $1',
        [pay?.id],
      )
    ).rows[0];
    expect(event.rev).toBe(Number(row?.rev));
    expect(event.data.version).toBe(row?.version);
    expect(JSON.stringify(event)).not.toContain(key);
  });

  test('the default bounds are finite', () => {
    expect(RETENTION_BATCH.size).toBeGreaterThan(0);
    expect(RETENTION_BATCH.maxBatches).toBeGreaterThan(0);
    expect(RETENTION_BATCH.size * RETENTION_BATCH.maxBatches).toBeLessThanOrEqual(50_000);
  });
});

describe('slip2go-account-check (D-27)', () => {
  const run = () => job('slip2go-account-check').run(deps);
  const day = 86_400_000;
  let reply: AccountInfoResult = { kind: 'failed' };
  let asked = 0;
  const verifier: SlipVerifier = {
    verifyQr: async () => ({ kind: 'transient' }),
    verifyImage: async () => ({ kind: 'transient' }),
    accountInfo: async () => {
      asked += 1;
      return reply;
    },
  };
  const info = (
    estimatedQuotaSlip: number | null,
    expiresInMs: number | null,
  ): AccountInfoResult => ({
    kind: 'info',
    estimatedQuotaSlip,
    packageExpiredDate:
      expiresInMs === null ? null : new Date(deps.now().getTime() + expiresInMs).toISOString(),
  });
  const kinds = () => h.alerts.filter((a) => a.kind.startsWith('slip2go.')).map((a) => a.kind);

  beforeEach(() => {
    installSlipVerifier(verifier);
    asked = 0;
    h.alerts.length = 0;
  });
  afterEach(() => installSlipVerifier(null));

  test('with the verifier off it does nothing and asks nobody', async () => {
    installSlipVerifier(null);
    expect(await run()).toEqual({ checked: 0, failed: 0, alerts: 0 });
    expect(asked).toBe(0);
    expect(kinds()).toEqual([]);
  });

  test('plenty of slips and a package that lasts: no alert', async () => {
    reply = info(30, 4 * day);
    expect(await run()).toEqual({ checked: 1, failed: 0, alerts: 0 });
    expect(kinds()).toEqual([]);
  });

  test('fewer than 30 slips left alerts the owner with the number only', async () => {
    reply = info(29, 20 * day);
    expect(await run()).toEqual({ checked: 1, failed: 0, alerts: 1 });
    expect(h.alerts.filter((a) => a.kind.startsWith('slip2go.'))).toEqual([
      expect.objectContaining({
        kind: 'slip2go.quota_low',
        severity: 'warn',
        staffId: null,
        slip2go: { quotaSlips: 29 },
      }),
    ]);
  });

  test('a package that ends within 3 days (or already ended) alerts with the date only', async () => {
    reply = info(500, 3 * day);
    expect(await run()).toEqual({ checked: 1, failed: 0, alerts: 1 });
    expect(h.alerts.at(-1)?.slip2go).toEqual({
      expiresOn: new Date(deps.now().getTime() + 3 * day).toISOString().slice(0, 10),
    });
    h.alerts.length = 0;
    reply = info(500, -day);
    await run();
    expect(kinds()).toEqual(['slip2go.package_expiring']);
  });

  test('both low quota and expiry give two alerts; unknown figures give none', async () => {
    reply = info(1, day);
    expect(await run()).toEqual({ checked: 1, failed: 0, alerts: 2 });
    expect(kinds().sort()).toEqual(['slip2go.package_expiring', 'slip2go.quota_low']);
    h.alerts.length = 0;
    reply = info(null, null);
    expect(await run()).toEqual({ checked: 1, failed: 0, alerts: 0 });
  });

  test('an account call that fails is counted, never thrown, and alerts the owner (PAY-02)', async () => {
    h.clock.set('2028-09-01T01:00:00.000Z');
    reply = { kind: 'failed', code: '401004' };
    expect(await run()).toEqual({ checked: 0, failed: 1, alerts: 1 });
    expect(h.alerts.filter((a) => a.kind.startsWith('slip2go.'))).toEqual([
      expect.objectContaining({
        kind: 'slip2go.unavailable',
        severity: 'warn',
        staffId: null,
        deviceId: null,
        slip2go: { code: '401004' },
      }),
    ]);
    expect(h.alerts.at(-1)?.subject).toBeUndefined();
  });

  test('a failure with no code (network, unreadable answer) alerts with no code', async () => {
    h.clock.set('2028-09-02T01:00:00.000Z');
    reply = { kind: 'failed' };
    expect(await run()).toEqual({ checked: 0, failed: 1, alerts: 1 });
    expect(h.alerts.at(-1)).toMatchObject({ kind: 'slip2go.unavailable', slip2go: {} });
  });

  test('a code that is not 6 digits never reaches the alert (ids and codes only)', async () => {
    h.clock.set('2028-09-03T01:00:00.000Z');
    reply = { kind: 'failed', code: 'secret <html> text' };
    expect(await run()).toEqual({ checked: 0, failed: 1, alerts: 1 });
    expect(h.alerts.at(-1)?.slip2go).toEqual({});
  });

  test('once a business date: shared with the slip checks of that date', async () => {
    h.clock.set('2028-09-04T01:00:00.000Z');
    reply = { kind: 'failed', code: '500500' };
    expect(await run()).toEqual({ checked: 0, failed: 1, alerts: 1 });
    expect(await run()).toEqual({ checked: 0, failed: 1, alerts: 0 });
    expect(kinds()).toEqual(['slip2go.unavailable']);
    h.clock.set('2028-09-05T01:00:00.000Z');
    expect(await run()).toEqual({ checked: 0, failed: 1, alerts: 1 });
  });
});

describe('retention publishes what it changed, after commit (BE-02)', () => {
  const NAME = 'Zzyx-Retention-Name';
  const NOTE = 'Zzyx-Retention-Note';
  const since = (marker: number, type: AppEvent['type'], id: string | undefined) =>
    h.events.slice(marker).filter((e) => e.type === type && 'id' in e && e.id === id);
  const revOf = async (table: 'orders' | 'customers', id: string | undefined) =>
    Number(
      (await h.client.query<{ rev: string }>(`select rev from ${table} where id = $1`, [id]))
        .rows[0]?.rev,
    );

  async function finishedOrder(customerId: string | null, days: number) {
    const [row] = (
      await h.client.query<{ id: string }>(
        `insert into orders (order_no, business_date, channel, fulfillment, delivery_building, recipient_name,
           delivery_note, customer_id, status, subtotal_satang, total_satang, client_request_id, completed_at)
         values ($1, '2026-08-10', 'storefront', 'entrance_delivery', 'D7', $2, $3, $4,
           'completed', 8000, 8000, gen_random_uuid(), $5) returning id`,
        [`JR-${Math.floor(Math.random() * 1e9)}`, NAME, NOTE, customerId, daysAgo(days)],
      )
    ).rows;
    return row?.id as string;
  }

  test('retention-orders: one order.upserted per erased order, with the erased DTO; a rerun sends nothing', async () => {
    const id = await finishedOrder(null, 34);
    const marker = h.events.length;
    await job('retention-orders').run(deps);
    const events = since(marker, 'order.upserted', id);
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event?.type !== 'order.upserted') throw new Error('expected order.upserted');
    expect(event.rev).toBe(await revOf('orders', id));
    expect(orderDtoSchema.parse(event.data)).toMatchObject({
      recipientName: ANONYMIZED_RECIPIENT_NAME,
      deliveryBuilding: ANONYMIZED_BUILDING,
      deliveryNote: null,
      totalSatang: 8000,
    });
    expect(JSON.stringify(event)).not.toContain(NAME);
    expect(JSON.stringify(event)).not.toContain(NOTE);

    const again = h.events.length;
    await job('retention-orders').run(deps);
    expect(since(again, 'order.upserted', id)).toEqual([]);
  });

  test('retention-orders: a batch that rolls back publishes nothing', async () => {
    const id = await finishedOrder(null, 35);
    const marker = h.events.length;
    await expect(
      withFailingWrite(
        h,
        { table: 'audit_log', when: "new.action = 'retention.orders.anonymize'" },
        () => job('retention-orders').run(deps),
      ),
    ).rejects.toThrow();
    expect(h.events.slice(marker)).toEqual([]);
    const row = await h.client.query('select recipient_name from orders where id = $1', [id]);
    expect(row.rows[0]).toEqual({ recipient_name: NAME });
    // The next run does it, and tells the feed.
    await job('retention-orders').run(deps);
    expect(since(marker, 'order.upserted', id)).toHaveLength(1);
  });

  test('retention-recipients: the erased customer and their rewritten orders are published', async () => {
    const [cust] = (
      await h.client.query<{ id: string }>(
        `insert into customers (building, recipient_name, recipient_key, display_name, last_order_at, order_count)
         values ('D7', $1, $2, $1, $3, 1) returning id`,
        [NAME, `zzyx-${crypto.randomUUID()}`, daysAgo(40)],
      )
    ).rows;
    // An order finished only 20 days ago: the orders job leaves it, the recipients job erases it.
    const orderId = await finishedOrder(cust?.id ?? null, 20);
    const marker = h.events.length;
    await job('retention-recipients').run(deps);

    const customer = since(marker, 'customer.upserted', cust?.id);
    expect(customer).toHaveLength(1);
    const c = customer[0];
    if (c?.type !== 'customer.upserted') throw new Error('expected customer.upserted');
    expect(c.rev).toBe(await revOf('customers', cust?.id));
    expect(customerDtoSchema.parse(c.data)).toMatchObject({
      id: cust?.id,
      displayName: null,
      anonymized: true,
    });
    const orders = since(marker, 'order.upserted', orderId);
    expect(orders).toHaveLength(1);
    expect(JSON.stringify(h.events.slice(marker))).not.toContain(NAME);
  });

  test('retention-recipients: a batch that rolls back publishes nothing', async () => {
    const [cust] = (
      await h.client.query<{ id: string }>(
        `insert into customers (building, recipient_name, recipient_key, last_order_at, order_count)
         values ('D7', $1, $2, $3, 1) returning id`,
        [NAME, `zzyx-${crypto.randomUUID()}`, daysAgo(40)],
      )
    ).rows;
    const marker = h.events.length;
    await expect(
      withFailingWrite(
        h,
        { table: 'audit_log', when: "new.action = 'retention.recipients.expire'" },
        () => job('retention-recipients').run(deps),
      ),
    ).rejects.toThrow();
    expect(h.events.slice(marker)).toEqual([]);
    const row = await h.client.query('select anonymized_at from customers where id = $1', [
      cust?.id,
    ]);
    expect(row.rows[0]).toEqual({ anonymized_at: null });
    await job('retention-recipients').run(deps);
  });

  test('retention-line-customers: the erased app visitor is published', async () => {
    const visitor = await h.client.query<{ id: string }>(
      'insert into customers (line_user_id, display_name, first_seen_at) values ($1, $2, $3) returning id',
      [`Utest-be02-${crypto.randomUUID()}`, NAME, daysAgo(41)],
    );
    const id = visitor.rows[0]?.id;
    const marker = h.events.length;
    await job('retention-line-customers').run(deps);
    const events = since(marker, 'customer.upserted', id);
    expect(events).toHaveLength(1);
    expect(
      customerDtoSchema.parse(events[0]?.type === 'customer.upserted' && events[0].data),
    ).toMatchObject({ displayName: null, anonymized: true });
    expect(JSON.stringify(events)).not.toContain(NAME);
    expect(JSON.stringify(events)).not.toContain('Utest-be02');
  });

  test('retention-member-profiles: the customer is published without the cleared nickname', async () => {
    const [row] = (
      await h.client.query<{ id: string }>(
        `insert into customers (line_user_id, last_order_at, full_name, nickname, phone, member_building)
         values ($1, $2, $3, 'Zzyx-Nick', '0800000009', 'D9') returning id`,
        [`Utest-be02-m-${crypto.randomUUID()}`, daysAgo(800), NAME],
      )
    ).rows;
    const marker = h.events.length;
    await job('retention-member-profiles').run(deps);
    const events = since(marker, 'customer.upserted', row?.id);
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event?.type !== 'customer.upserted') throw new Error('expected customer.upserted');
    expect(event.rev).toBe(await revOf('customers', row?.id));
    expect(customerDtoSchema.parse(event.data)).toMatchObject({ nickname: null });
    const text = JSON.stringify(event);
    for (const gone of ['Zzyx-Nick', NAME, '0800000009']) expect(text).not.toContain(gone);
  });

  test('retention-member-profiles: a batch that rolls back publishes nothing', async () => {
    await h.client.query(
      `insert into customers (line_user_id, last_order_at, nickname) values ($1, $2, 'Zzyx-Nick2')`,
      [`Utest-be02-r-${crypto.randomUUID()}`, daysAgo(800)],
    );
    const marker = h.events.length;
    await expect(
      withFailingWrite(
        h,
        { table: 'audit_log', when: "new.action = 'retention.member_profiles.expire'" },
        () => job('retention-member-profiles').run(deps),
      ),
    ).rejects.toThrow();
    expect(h.events.slice(marker)).toEqual([]);
    await job('retention-member-profiles').run(deps);
  });
});
