import { describe, expect, test, vi } from 'vitest';
import type { LineClient, LineSendResult } from './client.ts';
import {
  DEFAULT_LINE_POLICY,
  type LinePolicy,
  parseLinePolicy,
  quotaMonth,
  thresholdCrossed,
} from './policy.ts';
import { createLineSender, type QuotaStore } from './sender.ts';

const TEXT = [{ type: 'text' as const, text: 'x' }];

function fakeStore(limitUsed = 0) {
  let used = limitUsed;
  const orders = new Set<string>();
  const alerted = new Set<string>();
  const store: QuotaStore & { replies: number; released: number; used(): number } = {
    replies: 0,
    released: 0,
    used: () => used,
    async claimAlert(a) {
      const key = `${a.month}|${a.level}`;
      if (alerted.has(key)) return false;
      alerted.add(key);
      return true;
    },
    async reservePush(a) {
      if (a.orderId) {
        const key = `${a.orderId}|${a.template}`;
        if (orders.has(key)) return { status: 'duplicate' };
        orders.add(key);
      }
      if (used >= a.limit) return { status: 'capped' };
      used += 1;
      return { status: 'reserved', used, logId: `log-${used}` };
    },
    async releasePush() {
      used -= 1;
      store.released += 1;
    },
    async logReply() {
      store.replies += 1;
    },
  };
  return store;
}

function fakeClient(result: LineSendResult = { ok: true }) {
  return {
    reply: vi.fn(async () => result),
    push: vi.fn(async () => result),
  } satisfies LineClient;
}

const policy = (p: Partial<LinePolicy> = {}): LinePolicy => ({ ...DEFAULT_LINE_POLICY, ...p });

function sender(opts: {
  client?: LineClient | null;
  store?: ReturnType<typeof fakeStore>;
  policy?: LinePolicy;
  onThreshold?: (l: 'warn' | 'cap', u: number, n: number) => void;
}) {
  return createLineSender({
    client: opts.client === undefined ? fakeClient() : opts.client,
    store: opts.store ?? fakeStore(),
    getPolicy: async () => opts.policy ?? policy(),
    now: () => new Date('2026-10-15T05:00:00Z'),
    ...(opts.onThreshold ? { onThreshold: opts.onThreshold } : {}),
  });
}

describe('reply', () => {
  test('is free: allowed under policy off and at the cap, logged as a reply', async () => {
    const store = fakeStore(300);
    const client = fakeClient();
    const s = sender({ client, store, policy: policy({ push: 'off' }) });
    expect(await s.reply('rt', TEXT, { template: 'greeting' })).toEqual({ sent: true });
    expect(client.reply).toHaveBeenCalledOnce();
    expect(store.replies).toBe(1);
    expect(store.used()).toBe(300);
  });

  test('reports a LINE failure without throwing', async () => {
    const s = sender({ client: fakeClient({ ok: false, definite: true, status: 400 }) });
    expect(await s.reply('rt', TEXT, { template: 'x' })).toEqual({ sent: false, reason: 'failed' });
  });
});

describe('push', () => {
  test('policy off sends nothing and takes no quota', async () => {
    const client = fakeClient();
    const store = fakeStore();
    const s = sender({ client, store, policy: policy({ push: 'off' }) });
    expect(await s.push('U1', TEXT, { template: 'ready', essential: true })).toEqual({
      sent: false,
      reason: 'policy_off',
    });
    expect(client.push).not.toHaveBeenCalled();
    expect(store.used()).toBe(0);
  });

  test('essential allows ready+receipt and blocks the rest; all allows both', async () => {
    const s = sender({ policy: policy({ push: 'essential' }) });
    expect((await s.push('U1', TEXT, { template: 'ready', essential: true })).sent).toBe(true);
    expect(await s.push('U1', TEXT, { template: 'promo', essential: false })).toEqual({
      sent: false,
      reason: 'not_essential',
    });
    const all = sender({ policy: policy({ push: 'all' }) });
    expect((await all.push('U1', TEXT, { template: 'promo', essential: false })).sent).toBe(true);
  });

  test('stops at the monthly limit', async () => {
    const client = fakeClient();
    const s = sender({ client, store: fakeStore(299), policy: policy({ monthlyLimit: 300 }) });
    expect((await s.push('U1', TEXT, { template: 'a', essential: true })).sent).toBe(true);
    expect(await s.push('U1', TEXT, { template: 'a', essential: true })).toEqual({
      sent: false,
      reason: 'quota_exhausted',
    });
    expect(client.push).toHaveBeenCalledOnce();
  });

  test('one push per order and template', async () => {
    const client = fakeClient();
    const store = fakeStore();
    const s = sender({ client, store });
    const meta = { template: 'ready_receipt', essential: true, orderId: 'o1' };
    expect((await s.push('U1', TEXT, meta)).sent).toBe(true);
    expect(await s.push('U1', TEXT, meta)).toEqual({ sent: false, reason: 'duplicate' });
    expect(client.push).toHaveBeenCalledOnce();
    expect(store.used()).toBe(1);
  });

  test('a definite refusal gives the unit back; an unknown failure keeps it spent', async () => {
    const refused = fakeStore();
    await sender({
      client: fakeClient({ ok: false, definite: true, status: 400 }),
      store: refused,
    }).push('U1', TEXT, { template: 'a', essential: true });
    expect(refused.used()).toBe(0);
    expect(refused.released).toBe(1);

    const unknown = fakeStore();
    const out = await sender({
      client: fakeClient({ ok: false, definite: false }),
      store: unknown,
    }).push('U1', TEXT, { template: 'a', essential: true });
    expect(out).toEqual({ sent: false, reason: 'failed' });
    expect(unknown.used()).toBe(1);
  });

  test('sends the log id as the retry key', async () => {
    const client = fakeClient();
    await sender({ client }).push('U1', TEXT, { template: 'a', essential: true });
    expect(client.push).toHaveBeenCalledWith('U1', TEXT, 'log-1');
  });

  test('warns once at the warning level and once at the cap', async () => {
    const calls: [string, number][] = [];
    const s = sender({
      policy: policy({ monthlyLimit: 10, warnAtPercent: 80 }),
      onThreshold: (level, used) => calls.push([level, used]),
    });
    for (let i = 0; i < 12; i++) await s.push('U1', TEXT, { template: 'a', essential: true });
    expect(calls).toEqual([
      ['warn', 8],
      ['cap', 10],
    ]);
  });

  test('the alert comes after the push went out, never for a push LINE refused', async () => {
    const order: string[] = [];
    const client = fakeClient();
    client.push.mockImplementation(async () => {
      order.push('push');
      return { ok: true } as LineSendResult;
    });
    const s = sender({
      client,
      policy: policy({ monthlyLimit: 10, warnAtPercent: 80 }),
      store: fakeStore(7),
      onThreshold: (level) => order.push(`alert:${level}`),
    });
    await s.push('U1', TEXT, { template: 'a', essential: true });
    expect(order).toEqual(['push', 'alert:warn']);

    // LINE definitely refuses a push that would reach the cap: the unit goes back, no alert.
    const calls: string[] = [];
    const refused = sender({
      client: fakeClient({ ok: false, definite: true, status: 400 }),
      policy: policy({ monthlyLimit: 10, warnAtPercent: 80 }),
      store: fakeStore(9),
      onThreshold: (level) => calls.push(level),
    });
    await refused.push('U1', TEXT, { template: 'a', essential: true });
    expect(calls).toEqual([]);
  });

  test('a refused push does not use up the alert: the next one that reaches the level raises it once', async () => {
    const store = fakeStore(7);
    const calls: string[] = [];
    const p = policy({ monthlyLimit: 10, warnAtPercent: 80 });
    const onThreshold = (level: string) => calls.push(level);
    await sender({
      client: fakeClient({ ok: false, definite: true, status: 500 }),
      policy: p,
      store,
      onThreshold,
    }).push('U1', TEXT, { template: 'a', essential: true });
    expect(calls).toEqual([]);
    // Two senders over the same books, as two webhook batches: still one alert.
    await sender({ policy: p, store, onThreshold }).push('U1', TEXT, {
      template: 'a',
      essential: true,
    });
    await sender({ policy: p, store, onThreshold }).push('U1', TEXT, {
      template: 'a',
      essential: true,
    });
    expect(calls).toEqual(['warn']);
  });

  test('an unknown failure may have been delivered, so the unit stays spent and the alert still comes', async () => {
    const calls: string[] = [];
    await sender({
      client: fakeClient({ ok: false, definite: false }),
      policy: policy({ monthlyLimit: 10, warnAtPercent: 80 }),
      store: fakeStore(7),
      onThreshold: (level) => calls.push(level),
    }).push('U1', TEXT, { template: 'a', essential: true });
    expect(calls).toEqual(['warn']);
  });

  test('a level that was passed without being hit exactly still alerts once (limit lowered mid-month)', async () => {
    const calls: [string, number][] = [];
    const store = fakeStore(12); // already above the new limit of 10
    const s = sender({
      policy: policy({ monthlyLimit: 10, warnAtPercent: 80 }),
      store,
      onThreshold: (level, used) => calls.push([level, used]),
    });
    expect(await s.push('U1', TEXT, { template: 'a', essential: true })).toEqual({
      sent: false,
      reason: 'quota_exhausted',
    });
    await s.push('U1', TEXT, { template: 'a', essential: true });
    expect(calls).toEqual([['cap', 10]]);
  });

  test('without LINE_* settings nothing is sent and nothing is spent', async () => {
    const store = fakeStore();
    const s = sender({ client: null, store });
    expect(await s.push('U1', TEXT, { template: 'a', essential: true })).toEqual({
      sent: false,
      reason: 'not_configured',
    });
    expect((await s.reply('rt', TEXT, { template: 'a' })).sent).toBe(false);
    expect(store.used()).toBe(0);
  });
});

describe('policy', () => {
  test('defaults when never saved; legacy names map; unreadable fails closed to off', () => {
    expect(parseLinePolicy(undefined)).toEqual(DEFAULT_LINE_POLICY);
    expect(parseLinePolicy({ push: 'ready-only', warnAtPercent: 80 }).push).toBe('essential');
    expect(parseLinePolicy({ push: 'always' }).push).toBe('all');
    expect(parseLinePolicy({ push: 'off', monthlyLimit: 1000 })).toMatchObject({
      push: 'off',
      monthlyLimit: 1000,
    });
    expect(parseLinePolicy({ push: 'sometimes' }).push).toBe('off');
    expect(parseLinePolicy('garbage').push).toBe('off');
    expect(parseLinePolicy({ push: 'all', monthlyLimit: 0 }).push).toBe('off');
  });

  test('the month is the Bangkok calendar month', () => {
    expect(quotaMonth(new Date('2026-10-31T16:59:59Z'))).toBe('2026-10');
    expect(quotaMonth(new Date('2026-10-31T17:00:00Z'))).toBe('2026-11');
  });

  test('thresholds', () => {
    const p = { warnAtPercent: 80, monthlyLimit: 300 };
    expect(thresholdCrossed(239, p)).toBeNull();
    expect(thresholdCrossed(240, p)).toBe('warn');
    expect(thresholdCrossed(300, p)).toBe('cap');
  });
});
