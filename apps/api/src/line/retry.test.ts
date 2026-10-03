import type { LineClient, LineMessage } from '@sds/line';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness } from '../test-support/harness.ts';
import { LINE_EVENT_RETRY, retryLineEvents } from './retry.ts';
import { createLineRuntime, type LineRuntime } from './runtime.ts';

// Made-up LINE user ids and event ids: no real customer data in tests.
let h: Harness;
let runtime: LineRuntime;
const sent: { kind: 'reply' | 'push'; messages: LineMessage[] }[] = [];
const fakeClient: LineClient = {
  async reply(_token, messages) {
    sent.push({ kind: 'reply', messages });
    return { ok: true };
  },
  async push(_to, messages) {
    sent.push({ kind: 'push', messages });
    return { ok: true };
  },
};

beforeAll(async () => {
  runtime = createLineRuntime(
    { channelSecret: 'test-channel-secret-not-real', channelAccessToken: undefined },
    { client: fakeClient },
  );
  h = await createHarness({ line: runtime });
}, 60_000);
afterAll(async () => {
  await h.close();
});

const deps = () => ({ db: h.db, events: h.bus, now: h.clock.now, line: runtime });
const minutesAgo = (m: number) => new Date(h.clock.now().getTime() - m * 60_000);

let n = 0;
async function store(args: {
  userId: string;
  route: Record<string, unknown> | null;
  ageMinutes: number;
  processed?: boolean;
  error?: string;
  attempts?: number;
}) {
  const id = `retry-${++n}`;
  await h.client.query(
    `insert into line_events (webhook_event_id, type, user_id, route, received_at, processed_at, error, attempts)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
    [
      id,
      String(args.route?.kind ?? 'follow'),
      args.userId,
      args.route ? JSON.stringify(args.route) : null,
      minutesAgo(args.ageMinutes).toISOString(),
      args.processed ? minutesAgo(args.ageMinutes).toISOString() : null,
      args.error ?? null,
      args.attempts ?? 0,
    ],
  );
  return id;
}
const row = async (id: string) =>
  (
    await h.client.query<{
      processed_at: string | null;
      error: string | null;
      attempts: number;
    }>('select processed_at, error, attempts from line_events where webhook_event_id = $1', [id])
  ).rows[0];
const customer = async (userId: string) =>
  (
    await h.client.query<{
      unfollowed_at: Date | null;
      privacy_ack_at: Date | null;
    }>('select unfollowed_at, privacy_ack_at from customers where line_user_id = $1', [userId])
  ).rows[0];

describe('retryLineEvents', () => {
  test('runs an event that was stored but never handled (a crash), without answering the customer', async () => {
    sent.length = 0;
    const user = 'Utest-retry-crash';
    const id = await store({
      userId: user,
      route: { kind: 'follow', userId: user },
      ageMinutes: 10,
    });
    const result = await retryLineEvents(deps());
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(await customer(user)).toBeDefined();
    const after = await row(id);
    expect(after?.processed_at).not.toBeNull();
    expect(after?.error).toBeNull();
    expect(after?.attempts).toBe(1);
    // The reply token is long gone: a retry does the database work only.
    expect(sent).toHaveLength(0);
  });

  test('runs an event whose handler failed before, and clears its error', async () => {
    const user = 'Utest-retry-error';
    const id = await store({
      userId: user,
      route: { kind: 'follow', userId: user },
      ageMinutes: 10,
      processed: true,
      error: 'TypeError',
    });
    await retryLineEvents(deps());
    expect(await row(id)).toMatchObject({ error: null });
    expect(await customer(user)).toBeDefined();
  });

  test('leaves alone: handled events, too-young events (still being handled), old events, spent attempts, rows with no route', async () => {
    const base = { ageMinutes: 10 };
    const u = 'Utest-retry-leave';
    const ok = await store({
      ...base,
      userId: u,
      route: { kind: 'follow', userId: u },
      processed: true,
    });
    const young = await store({ userId: u, route: { kind: 'follow', userId: u }, ageMinutes: 0.5 });
    const old = await store({
      userId: u,
      route: { kind: 'follow', userId: u },
      ageMinutes: LINE_EVENT_RETRY.maxAgeMinutes + 5,
    });
    const spent = await store({
      ...base,
      userId: u,
      route: { kind: 'follow', userId: u },
      error: 'Error',
      processed: true,
      attempts: LINE_EVENT_RETRY.maxAttempts,
    });
    const noRoute = await store({ ...base, userId: u, route: null });
    const result = await retryLineEvents(deps());
    expect(result.claimed).toBe(0);
    expect((await row(ok))?.attempts).toBe(0);
    expect((await row(young))?.processed_at).toBeNull();
    expect((await row(old))?.processed_at).toBeNull();
    expect((await row(noRoute))?.processed_at).toBeNull();
    expect((await row(spent))?.attempts).toBe(LINE_EVENT_RETRY.maxAttempts);
    expect(await customer(u)).toBeUndefined();
  });

  test('a failing event is retried a limited number of times, recording only a class name', async () => {
    const user = 'Utest-poison';
    await h.client.query(
      `alter table customers add constraint tmp_poison check (line_user_id <> '${user}')`,
    );
    try {
      const id = await store({
        userId: user,
        route: { kind: 'follow', userId: user },
        ageMinutes: 10,
      });
      for (let i = 0; i < LINE_EVENT_RETRY.maxAttempts + 3; i++) await retryLineEvents(deps());
      const after = await row(id);
      expect(after?.attempts).toBe(LINE_EVENT_RETRY.maxAttempts);
      expect(after?.error).toBe('Error');
      expect(h.logs()).not.toContain(user);
    } finally {
      await h.client.query('alter table customers drop constraint tmp_poison');
    }
  });

  test('an old unfollow never undoes a later follow; it is marked handled and skipped', async () => {
    const user = 'Utest-retry-order';
    const unfollow = await store({
      userId: user,
      route: { kind: 'unfollow', userId: user },
      ageMinutes: 30,
    });
    const follow = await store({
      userId: user,
      route: { kind: 'follow', userId: user },
      ageMinutes: 20,
    });
    const result = await retryLineEvents(deps());
    expect(result.superseded).toBe(1);
    expect((await customer(user))?.unfollowed_at).toBeNull();
    expect((await row(unfollow))?.processed_at).not.toBeNull();
    expect((await row(follow))?.processed_at).not.toBeNull();
  });

  test('a retried unfollow is dated when LINE delivered it, not when the retry ran', async () => {
    const user = 'Utest-retry-unfollow';
    await h.client.query('insert into customers (line_user_id) values ($1)', [user]);
    const received = minutesAgo(15).toISOString();
    await store({ userId: user, route: { kind: 'unfollow', userId: user }, ageMinutes: 15 });
    await retryLineEvents(deps());
    expect((await customer(user))?.unfollowed_at?.toISOString()).toBe(received);
  });

  test('a retried privacy acknowledgement is stored with the delivery time', async () => {
    const user = 'Utest-retry-ack';
    const received = minutesAgo(12).toISOString();
    await store({ userId: user, route: { kind: 'ack_privacy', userId: user }, ageMinutes: 12 });
    await retryLineEvents(deps());
    const c = await customer(user);
    expect(c?.privacy_ack_at?.toISOString()).toBe(received);
  });

  test('handles at most `limit` rows a run and picks the rest up on the next run', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const u = `Utest-retry-batch-${i}`;
      ids.push(await store({ userId: u, route: { kind: 'follow', userId: u }, ageMinutes: 10 }));
    }
    expect((await retryLineEvents(deps(), { limit: 2 })).claimed).toBe(2);
    expect((await retryLineEvents(deps(), { limit: 2 })).claimed).toBe(1);
    for (const id of ids) expect((await row(id))?.processed_at).not.toBeNull();
  });
});
