import { ANONYMIZED_BUILDING, ANONYMIZED_RECIPIENT_NAME } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createLineRuntime } from '../line/runtime.ts';
import { createMemorySlipStore } from '../slips/store.ts';
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

  test('the default bounds are finite', () => {
    expect(RETENTION_BATCH.size).toBeGreaterThan(0);
    expect(RETENTION_BATCH.maxBatches).toBeGreaterThan(0);
    expect(RETENTION_BATCH.size * RETENTION_BATCH.maxBatches).toBeLessThanOrEqual(50_000);
  });
});
