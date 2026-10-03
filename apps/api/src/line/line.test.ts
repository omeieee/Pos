import { createHmac } from 'node:crypto';
import { lineRepo } from '@sds/db';
import { type LineClient, type LineMessage, quotaMonth } from '@sds/line';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { enforceGuardedRoutes, markLineSignatureCheck } from '../auth/guards.ts';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';
import { LINE_SIGNATURE_ROUTES } from '../v1.ts';
import { buildSender, createLineRuntime, type LineRuntime } from './runtime.ts';

// Fake values for tests only. The user ids are made up, not real LINE ids.
const SECRET = 'test-channel-secret-not-real';
const U1 = 'Utest00000000000000000000000000a1';
const U2 = 'Utest00000000000000000000000000b2';

let h: Harness;
let runtime: LineRuntime;
let owner: OwnerFixture;
const sent: { kind: 'reply' | 'push'; to: string; messages: LineMessage[] }[] = [];

const fakeClient: LineClient = {
  async reply(replyToken, messages) {
    sent.push({ kind: 'reply', to: replyToken, messages });
    return { ok: true };
  },
  async push(to, messages) {
    sent.push({ kind: 'push', to, messages });
    return { ok: true };
  },
};

beforeAll(async () => {
  runtime = createLineRuntime(
    { channelSecret: SECRET, channelAccessToken: undefined },
    { client: fakeClient },
  );
  h = await createHarness({ line: runtime });
  owner = await h.newOwner();
}, 60_000);
afterAll(async () => {
  await h.close();
});

const sign = (body: string, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('base64');

function webhook(
  body: string,
  headers: Record<string, string> = { 'x-line-signature': sign(body) },
) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/line/webhook',
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
    remoteAddress: h.nextIp(),
  });
}

let counter = 0;
const eventId = () => `evt-${Date.now()}-${++counter}`;
const body = (...events: unknown[]) => JSON.stringify({ destination: 'Utest', events });
const follow = (userId: string, id = eventId()) => ({
  type: 'follow',
  webhookEventId: id,
  replyToken: `rt-${id}`,
  source: { type: 'user', userId },
  timestamp: 1,
  mode: 'active',
  deliveryContext: { isRedelivery: false },
});
const postback = (userId: string, data: string, id = eventId()) => ({
  type: 'postback',
  webhookEventId: id,
  replyToken: `rt-${id}`,
  source: { type: 'user', userId },
  postback: { data },
});

async function customer(userId: string) {
  const r = await h.client.query<{
    id: string;
    unfollowed_at: string | null;
    privacy_ack_at: string | null;
  }>('select id, unfollowed_at, privacy_ack_at from customers where line_user_id = $1', [userId]);
  return r.rows[0];
}
async function eventRows(id: string) {
  const r = await h.client.query<{ processed_at: string | null; error: string | null }>(
    'select processed_at, error from line_events where webhook_event_id = $1',
    [id],
  );
  return r.rows;
}

describe('signature', () => {
  test('a bad, tampered or missing signature is rejected and stores nothing', async () => {
    const id = eventId();
    const b = body(follow(U1, id));
    expect((await webhook(b, { 'x-line-signature': sign(b, 'wrong-secret') })).statusCode).toBe(
      403,
    );
    expect(
      (await webhook(b.replace('Utest', 'Uevil'), { 'x-line-signature': sign(b) })).statusCode,
    ).toBe(403);
    expect((await webhook(b, {})).statusCode).toBe(401);
    expect((await webhook(b, { 'x-line-signature': 'not-base64' })).statusCode).toBe(403);
    await runtime.idle();
    expect(await eventRows(id)).toHaveLength(0);
  });

  test('a valid signature over the raw body is accepted (even with unusual whitespace)', async () => {
    const b = `{ "destination": "Utest",   "events": [] }`;
    expect((await webhook(b)).statusCode).toBe(200);
  });

  test('LINE sends a charset in the content type: the raw body still reaches the check', async () => {
    for (const type of ['application/json; charset=utf-8', 'application/json;charset=UTF-8']) {
      const b = body(follow('Utest-charset-1'));
      const res = await webhook(b, { 'x-line-signature': sign(b), 'content-type': type });
      expect(res.statusCode, type).toBe(200);
    }
  });

  test('a database failure while storing answers 500 and leaves nothing stored (LINE redelivers)', async () => {
    const first = eventId();
    const second = eventId();
    // The second id is too long for nothing; force a failure with a type that violates NOT NULL.
    await h.client.query(
      'alter table line_events add constraint tmp_fail check (webhook_event_id <> $1)'.replace(
        '$1',
        `'${second}'`,
      ),
    );
    try {
      const res = await webhook(
        body(follow('Utest-atomic-1', first), follow('Utest-atomic-2', second)),
      );
      expect(res.statusCode).toBe(500);
      expect(await eventRows(first)).toHaveLength(0);
    } finally {
      await h.client.query('alter table line_events drop constraint tmp_fail');
    }
    // Redelivery after the fault is handled normally.
    expect(
      (await webhook(body(follow('Utest-atomic-1', first), follow('Utest-atomic-2', second))))
        .statusCode,
    ).toBe(200);
    await runtime.idle();
    expect((await eventRows(first))[0]?.processed_at).not.toBeNull();
  });

  test('the console Verify call (no events) answers 200', async () => {
    expect((await webhook(body())).statusCode).toBe(200);
  });

  test('without LINE_CHANNEL_SECRET the webhook answers 503 and never accepts unsigned requests', async () => {
    const bare = await createHarness({
      line: createLineRuntime({ channelSecret: undefined, channelAccessToken: undefined }),
    });
    try {
      const b = body(follow(U1));
      const res = await bare.app.inject({
        method: 'POST',
        url: '/v1/line/webhook',
        headers: { 'content-type': 'application/json', 'x-line-signature': sign(b) },
        payload: b,
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });

  test('a non-JSON body with a valid signature is a 400', async () => {
    expect((await webhook('not json')).statusCode).toBe(400);
  });
});

describe('follow, unfollow and privacy acknowledgement', () => {
  test('follow creates the customer and replies with the greeting and privacy notice (a free reply)', async () => {
    sent.length = 0;
    const id = eventId();
    const res = await webhook(body(follow(U1, id)));
    expect(res.statusCode).toBe(200);
    await runtime.idle();

    const c = await customer(U1);
    expect(c?.privacy_ack_at).toBeNull(); // following is not acknowledging
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe('reply');
    expect(JSON.stringify(sent[0]?.messages)).toContain('แซ่บโดนเส้น');
    expect(JSON.stringify(sent[0]?.messages)).toContain('omeie');
    expect((await eventRows(id))[0]?.processed_at).not.toBeNull();
    const log = await h.client.query<{ kind: string; counted: boolean }>(
      "select kind, counted from line_message_log where template = 'follow_greeting' and customer_id = $1",
      [c?.id],
    );
    expect(log.rows).toEqual([{ kind: 'reply', counted: false }]);
  });

  test('the same webhookEventId delivered twice is handled once', async () => {
    sent.length = 0;
    const id = eventId();
    const b = body(follow(U2, id));
    expect((await webhook(b)).statusCode).toBe(200);
    await runtime.idle();
    const redelivery = body({ ...follow(U2, id), deliveryContext: { isRedelivery: true } });
    expect((await webhook(redelivery)).statusCode).toBe(200);
    await runtime.idle();

    expect(sent).toHaveLength(1);
    expect(await eventRows(id)).toHaveLength(1);
    const c = await h.client.query('select 1 from customers where line_user_id = $1', [U2]);
    expect(c.rows).toHaveLength(1);
  });

  test('two events in one request are both handled; a duplicate inside the batch only once', async () => {
    sent.length = 0;
    const id = eventId();
    await webhook(
      body(follow('Utest-batch-1', id), follow('Utest-batch-2'), follow('Utest-batch-1', id)),
    );
    await runtime.idle();
    expect(sent).toHaveLength(2);
  });

  test('unfollow marks the customer; a new follow clears it', async () => {
    const u = 'Utest-unfollow-1';
    await webhook(body(follow(u)));
    await runtime.idle();
    await webhook(
      body({ type: 'unfollow', webhookEventId: eventId(), source: { type: 'user', userId: u } }),
    );
    await runtime.idle();
    expect((await customer(u))?.unfollowed_at).not.toBeNull();
    await webhook(body(follow(u)));
    await runtime.idle();
    expect((await customer(u))?.unfollowed_at).toBeNull();
  });

  test('the "I understand" button stores the acknowledgement once and replies', async () => {
    sent.length = 0;
    const u = 'Utest-ack-1';
    await webhook(body(follow(u)));
    await runtime.idle();
    h.clock.advanceSeconds(10);
    await webhook(body(postback(u, 'action=ack_privacy')));
    await runtime.idle();
    const first = (await customer(u))?.privacy_ack_at;
    expect(first).not.toBeNull();
    expect(JSON.stringify(sent.at(-1)?.messages)).toContain('รับทราบ');

    h.clock.advanceSeconds(10);
    await webhook(body(postback(u, 'action=ack_privacy')));
    await runtime.idle();
    expect((await customer(u))?.privacy_ack_at).toEqual(first);
  });

  test('an acknowledgement before any follow event still creates the customer', async () => {
    const u = 'Utest-ack-first';
    await webhook(body(postback(u, 'action=ack_privacy')));
    await runtime.idle();
    expect((await customer(u))?.privacy_ack_at).not.toBeNull();
  });

  test('unknown event types and unhandled postbacks are stored, processed and not answered', async () => {
    sent.length = 0;
    const a = eventId();
    const b = eventId();
    await webhook(
      body(
        { type: 'videoPlayComplete', webhookEventId: a, source: { type: 'user', userId: U1 } },
        postback(U1, 'action=junk', b),
      ),
    );
    await runtime.idle();
    expect((await eventRows(a))[0]?.processed_at).not.toBeNull();
    expect((await eventRows(b))[0]?.error).toBeNull();
    expect(sent).toHaveLength(0);
  });

  test('a failing handler is recorded by class name and does not fail the webhook', async () => {
    const failing = createLineRuntime(
      { channelSecret: SECRET, channelAccessToken: undefined },
      {
        client: {
          reply: async () => {
            throw new TypeError('boom with Utest-secret-text');
          },
          push: async () => ({ ok: true }),
        },
      },
    );
    const f = await createHarness({ line: failing });
    try {
      const id = eventId();
      const b = body(follow('Utest-fail-1', id));
      const res = await f.app.inject({
        method: 'POST',
        url: '/v1/line/webhook',
        headers: { 'content-type': 'application/json', 'x-line-signature': sign(b) },
        payload: b,
      });
      expect(res.statusCode).toBe(200);
      await failing.idle();
      const row = await f.client.query<{ error: string | null }>(
        'select error from line_events where webhook_event_id = $1',
        [id],
      );
      expect(row.rows[0]?.error).toBe('TypeError');
      expect(f.logs()).not.toContain('Utest-secret-text');
    } finally {
      await f.close();
    }
  });

  test('the logs never hold LINE user ids, the signature or message text', async () => {
    expect(h.logs()).not.toContain(U1);
    expect(h.logs()).not.toContain('Utest-ack-1');
    expect(h.logs()).not.toContain(sign(body()));
  });
});

describe('stored events keep no raw payload or chat text', () => {
  const TYPED = 'ขอเส้นเล็ก ห้อง 1203 โทร 0812345678';
  const ORDER = '0194f1c2-7a3b-7c11-8d22-4e5f60718293';

  test('a stored row holds the type, the user id and id fields only', async () => {
    const text = eventId();
    const image = eventId();
    const key = eventId();
    const paid = eventId();
    const ack = eventId();
    await webhook(
      body(
        {
          type: 'message',
          webhookEventId: text,
          replyToken: 'rt-text',
          source: { type: 'user', userId: U2 },
          message: { type: 'text', id: 'm1', text: TYPED },
        },
        {
          type: 'message',
          webhookEventId: image,
          replyToken: 'rt-image',
          source: { type: 'user', userId: U2 },
          message: { type: 'image', id: 'm2' },
        },
        {
          type: 'message',
          webhookEventId: key,
          replyToken: 'rt-key',
          source: { type: 'user', userId: U2 },
          message: { type: 'text', id: 'm3', text: 'เมนู' },
        },
        postback(U2, `action=paid&order=${ORDER}&note=${encodeURIComponent(TYPED)}`, paid),
        postback(U2, 'action=ack_privacy', ack),
      ),
    );
    await runtime.idle();
    const rows = await h.client.query<{
      webhook_event_id: string;
      type: string;
      user_id: string | null;
      payload: unknown;
      route: Record<string, unknown> | null;
    }>(
      'select webhook_event_id, type, user_id, payload, route from line_events where webhook_event_id = any($1)',
      [[text, image, key, paid, ack]],
    );
    const byId = new Map(rows.rows.map((r) => [r.webhook_event_id, r]));
    for (const r of rows.rows) {
      expect(r.payload).toBeNull();
      expect(r.user_id).toBe(U2);
      expect(JSON.stringify(r)).not.toContain('1203');
      expect(JSON.stringify(r)).not.toContain('0812345678');
      expect(JSON.stringify(r)).not.toContain('rt-'); // reply tokens are not kept either
    }
    expect(byId.get(text)?.route).toEqual({ kind: 'ignore' });
    expect(byId.get(image)?.route).toEqual({ kind: 'slip_image', userId: U2, messageId: 'm2' });
    expect(byId.get(key)?.route).toEqual({ kind: 'keyword', keyword: 'menu', userId: U2 });
    expect(byId.get(paid)?.route).toEqual({
      kind: 'payment_claimed',
      userId: U2,
      orderId: ORDER,
    });
    expect(byId.get(ack)?.route).toEqual({ kind: 'ack_privacy', userId: U2 });
  });
});

describe('route inventory', () => {
  test('the webhook is the only unguarded LINE route and it is signature-checked', () => {
    const line = h.routes.filter((r) => r.url.startsWith('/v1/line') && r.method !== 'HEAD');
    expect(line.map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      'GET /v1/line/quota',
      'POST /v1/line/webhook',
    ]);
    expect(line.filter((r) => !r.guarded).map((r) => r.url)).toEqual(['/v1/line/webhook']);
  });

  test('start-up refuses a listed LINE route that has no signature check', async () => {
    const app = Fastify();
    app.addHook('onRoute', () => {});
    enforceGuardedRoutes(app, new Set(), new Set(), new Set(), new Set(), LINE_SIGNATURE_ROUTES);
    app.post(
      '/v1/line/webhook',
      { preHandler: markLineSignatureCheck(async () => {}) },
      async () => ({}),
    );
    await expect(app.ready()).resolves.toBeDefined();

    const bad = Fastify();
    enforceGuardedRoutes(bad, new Set(), new Set(), new Set(), new Set(), LINE_SIGNATURE_ROUTES);
    expect(() => bad.post('/v1/line/webhook', async () => ({}))).toThrow(/signature/);
  });
});

describe('quota', () => {
  const quota = (token?: string) =>
    h.app.inject({
      method: 'GET',
      url: '/v1/line/quota',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      remoteAddress: h.nextIp(),
    });

  test('needs settings.view: no session 401, kitchen 403, owner 200', async () => {
    expect((await quota()).statusCode).toBe(401);
    const device = await h.newDevice();
    const kitchen = await h.newStaff('kitchen', '4321');
    const token = await h.pinSession(device.token, kitchen.id, kitchen.pin);
    expect((await quota(token)).statusCode).toBe(403);
    expect((await quota(await h.ownerSession(owner))).statusCode).toBe(200);
  });

  test('used equals the counted push rows of the month, and the policy and limit come from settings', async () => {
    h.clock.advanceSeconds(90);
    const token = await h.ownerSession(owner);
    const month = quotaMonth(h.clock.now());
    await h.client.query(
      `insert into settings (key, value) values ('line_policy', $1::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify({ push: 'ready-only', warnAtPercent: 80 })],
    );
    for (let i = 0; i < 3; i++) {
      const r = await lineRepo.reservePush(h.db, { month, limit: 300, template: `t${i}` });
      expect(r.status).toBe('reserved');
    }
    const res = await quota(token);
    expect(res.json()).toMatchObject({
      month,
      used: 3,
      limit: 300,
      policy: 'essential',
      warnAtPercent: 80,
      configured: true, // a secret and a client
    });
    const counted = await h.client.query<{ n: number }>(
      "select count(*)::int as n from line_message_log where counted and kind = 'push'",
    );
    expect(counted.rows[0]?.n).toBe(3);

    await h.client.query(
      `update settings set value = '{"push":"off"}'::jsonb where key = 'line_policy'`,
    );
    expect((await quota(token)).json()).toMatchObject({ policy: 'off' });
    await h.client.query(`delete from settings where key = 'line_policy'`);
  });
});

describe('quota-aware push through the real books', () => {
  test('one push per order, the cap, release on refusal, and the warning alert', async () => {
    const month = quotaMonth(h.clock.now());
    await h.client.query('delete from line_quota_months where month = $1', [month]);
    const [cust] = (
      await h.client.query<{ id: string }>(
        "insert into customers (line_user_id) values ('Utest-push-1') returning id",
      )
    ).rows;
    const order = (
      await h.client.query<{ id: string }>(
        `insert into orders (order_no, business_date, channel, fulfillment, delivery_building, recipient_name,
           customer_id, status, subtotal_satang, total_satang, client_request_id)
         values ('P-1', '2026-10-02', 'line', 'entrance_delivery', 'B1', 'x', $1, 'completed', 5000, 5000, gen_random_uuid())
         returning id`,
        [cust?.id],
      )
    ).rows[0]?.id as string;

    const calls: string[] = [];
    const rt = createLineRuntime(
      { channelSecret: SECRET, channelAccessToken: undefined },
      {
        client: {
          reply: async () => ({ ok: true }),
          push: async (to) => {
            calls.push(to);
            return { ok: true };
          },
        },
      },
    );
    await h.client.query(
      `insert into settings (key, value) values ('line_policy', $1::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify({ push: 'essential', warnAtPercent: 50, monthlyLimit: 4 })],
    );
    const sender = buildSender({ db: h.db, runtime: rt, events: h.bus, now: h.clock.now });
    const msg = [{ type: 'text' as const, text: 'ready' }];
    const meta = {
      template: 'ready_receipt',
      essential: true,
      orderId: order,
      customerId: cust?.id ?? '',
    };

    const alertsBefore = h.alerts.length;
    expect(await sender.push('U', msg, meta)).toEqual({ sent: true });
    expect(await sender.push('U', msg, meta)).toEqual({ sent: false, reason: 'duplicate' });
    expect(await lineRepo.getMonthUsage(h.db, month)).toBe(1);

    // Fill to the warning level (2 of 4) and the cap (4 of 4) with other templates.
    expect((await sender.push('U', msg, { template: 'b', essential: true })).sent).toBe(true);
    expect((await sender.push('U', msg, { template: 'c', essential: true })).sent).toBe(true);
    expect((await sender.push('U', msg, { template: 'd', essential: true })).sent).toBe(true);
    expect(await sender.push('U', msg, { template: 'e', essential: true })).toEqual({
      sent: false,
      reason: 'quota_exhausted',
    });
    expect(calls).toHaveLength(4);
    expect(h.alerts.slice(alertsBefore).map((a) => a.kind)).toEqual([
      'line.quota_warning',
      'line.quota_capped',
    ]);
    // The unused unit of a refused push goes back.
    const refuse = buildSender({
      db: h.db,
      runtime: createLineRuntime(
        { channelSecret: SECRET, channelAccessToken: undefined },
        {
          client: {
            reply: async () => ({ ok: true }),
            push: async () => ({ ok: false, definite: true, status: 400 }),
          },
        },
      ),
      events: h.bus,
      now: h.clock.now,
    });
    await h.client.query('update line_quota_months set used = 1 where month = $1', [month]);
    expect((await refuse.push('U', msg, { template: 'f', essential: true })).sent).toBe(false);
    expect(await lineRepo.getMonthUsage(h.db, month)).toBe(1);

    await h.client.query(`delete from settings where key = 'line_policy'`);
  });

  test('concurrent reservations never pass the limit', async () => {
    const month = '2099-01';
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        lineRepo.reservePush(h.db, { month, limit: 3, template: `c${i}` }),
      ),
    );
    expect(results.filter((r) => r.status === 'reserved')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'capped')).toHaveLength(5);
    expect(await lineRepo.getMonthUsage(h.db, month)).toBe(3);
  });
});
