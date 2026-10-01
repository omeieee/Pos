/**
 * `WS /v1/ws` over real loopback TCP, with Node's built-in WebSocket as the client (the browser's
 * API: it cannot set headers, so these sockets authenticate with the first message exactly as the
 * staff app will). What this adds over ws.test.ts: a real upgrade, real close handshakes (a closed
 * socket frees its slot), a real 1009 on an oversized message, a real shutdown, and fan-out
 * latency measured end to end.
 *
 * Latency numbers are printed with `console.info` (look for "latency:"). They are PGlite on the
 * author's laptop, not Postgres on the Oracle VM, and not a phone on shop Wi-Fi.
 *
 * Still not proven: TLS and Caddy in front, a real Safari, real-Postgres commit timing.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';
import { connectTcp, expectClosed, ofType, pause, until, type WsClient } from './test-helpers.ts';

let h: Harness;
let port: number;
let owner: OwnerFixture;
let device: { id: string; token: string };
let cashier: { id: string; pin: string };
let kitchen: { id: string; pin: string };
const used: WsClient[] = [];

beforeAll(async () => {
  h = await createHarness({
    realtime: { hub: { maxPerIp: 4, authTimeoutMs: 1500 }, connectsPerMinute: 10_000 },
  });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  port = (h.app.server.address() as AddressInfo).port;
  owner = await h.newOwner();
  device = await h.newDevice();
  cashier = await h.newStaff('cashier', '4821');
  kitchen = await h.newStaff('kitchen', '4821');
  h.clock.set('2028-02-01T03:00:00.000Z');
}, 60_000);
afterEach(async () => {
  for (const c of used.splice(0)) if (!c.isClosed()) c.raw.close();
  await pause(30);
});
afterAll(async () => {
  await h.close();
});

async function open(): Promise<WsClient> {
  const c = await connectTcp(port);
  used.push(c);
  return c;
}

async function signedIn(who: 'cashier' | 'kitchen' | 'owner'): Promise<WsClient> {
  // A one-time code is good for one 30-second step, and the clock is the test's own.
  h.clock.advanceSeconds(31);
  const token =
    who === 'owner'
      ? await h.ownerSession(owner)
      : await h.pinSession(
          device.token,
          who === 'cashier' ? cashier.id : kitchen.id,
          who === 'cashier' ? cashier.pin : kitchen.pin,
        );
  const c = await open();
  c.send({
    type: 'auth',
    sessionToken: token,
    ...(who === 'owner' ? {} : { deviceToken: device.token }),
  });
  await c.next(ofType('ready'));
  return c;
}

describe('over real TCP', () => {
  test('a browser-style socket (no headers) authenticates with its first message and gets ready', async () => {
    const c = await signedIn('cashier');
    expect(c.frames[0]).toMatchObject({ type: 'ready', heartbeatSeconds: 25 });
  });

  test('a socket that never authenticates is closed 4408 by the deadline', async () => {
    const c = await open();
    expect(await expectClosed(c, 4000)).toMatchObject({ code: 4408, reason: 'auth_timeout' });
  });

  test('a bad token closes 4401', async () => {
    const c = await open();
    c.send({ type: 'auth', sessionToken: 'sds_ses_NotARealTokenNotARealToken1' });
    expect(await expectClosed(c)).toMatchObject({ code: 4401 });
  });

  test('a message over the size cap closes 1009', async () => {
    const c = await open();
    c.send(JSON.stringify({ type: 'auth', sessionToken: 'a'.repeat(5000) }));
    expect(await expectClosed(c)).toMatchObject({ code: 1009 });
  });

  test('a closed socket frees its slot: the per-address cap is 4, and the fifth waits for a close', async () => {
    const four: WsClient[] = [];
    for (let i = 0; i < 4; i += 1) four.push(await open());
    const refused = await open();
    expect(await expectClosed(refused)).toMatchObject({
      code: 4429,
      reason: 'too_many_connections',
    });

    // A real close handshake frees the slot (unlike the in-memory streams of ws.test.ts).
    four[0]?.raw.close();
    await expectClosed(four[0] as WsClient);
    let accepted: WsClient | undefined;
    await until(async () => {
      const c = await open();
      await pause(60);
      if (c.isClosed()) return false; // still refused: the server has not seen the close yet
      accepted = c;
      return true;
    });
    expect(accepted?.isClosed()).toBe(false);
  });

  test('closing the app closes every open socket with 1001 and returns quickly', async () => {
    const mine = await createHarness({ realtime: { hub: { shutdownGraceMs: 1000 } } });
    try {
      await mine.app.listen({ host: '127.0.0.1', port: 0 });
      const p = (mine.app.server.address() as AddressInfo).port;
      const o = await mine.newOwner();
      const token = await mine.ownerSession(o);
      const sockets: WsClient[] = [];
      for (let i = 0; i < 3; i += 1) {
        const c = await connectTcp(p);
        c.send({ type: 'auth', sessionToken: token });
        await c.next(ofType('ready'));
        sockets.push(c);
      }
      const unauthenticated = await connectTcp(p);
      const started = performance.now();
      await mine.app.close();
      const elapsed = performance.now() - started;
      for (const c of [...sockets, unauthenticated]) {
        expect(await expectClosed(c, 3000)).toMatchObject({
          code: 1001,
          reason: 'server_shutdown',
        });
      }
      expect(elapsed).toBeLessThan(2500);
      console.info(
        `shutdown: app.close() with 4 open sockets returned in ${elapsed.toFixed(0)} ms`,
      );
    } finally {
      await mine.client.close();
    }
  });
});

// ---------- Fan-out latency ----------

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function report(label: string, samples: number[]): { p50: number; p95: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const stats = {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
  };
  console.info(
    `latency: ${label}: n=${samples.length} p50=${stats.p50.toFixed(1)} ms p95=${stats.p95.toFixed(1)} ms max=${stats.max.toFixed(1)} ms`,
  );
  return stats;
}

describe('fan-out latency (two sockets, loopback TCP, PGlite)', () => {
  const shop = { nameTh: 'แซ่บโดนเส้น', nameEn: null, phone: null, address: null };

  test('publish to receipt on two sockets: p95 well under a second', async () => {
    const till = await signedIn('cashier');
    const boss = await signedIn('owner');
    const samples: number[] = [];
    for (let i = 1; i <= 200; i += 1) {
      const rev = 1_000_000 + i;
      const t0 = performance.now();
      h.bus.publish({ type: 'settings.updated', key: 'shop', rev, version: i, data: shop });
      await Promise.all([till.next((f) => f.rev === rev), boss.next((f) => f.rev === rev)]);
      for (const c of [till, boss]) {
        const at = c.frames.findIndex((f) => f.rev === rev);
        samples.push((c.times[at] as number) - t0);
      }
    }
    const stats = report('bus.publish -> frame on each of two sockets', samples);
    expect(stats.p95).toBeLessThan(250);
  });

  test('a burst of 300 events arrives complete and in order on both sockets', async () => {
    const till = await signedIn('cashier');
    const boss = await signedIn('owner');
    const base = 2_000_000;
    const t0 = performance.now();
    for (let i = 1; i <= 300; i += 1) {
      h.bus.publish({
        type: 'settings.updated',
        key: 'shop',
        rev: base + i,
        version: i,
        data: shop,
      });
    }
    await Promise.all([
      till.next((f) => f.rev === base + 300),
      boss.next((f) => f.rev === base + 300),
    ]);
    const total = performance.now() - t0;
    for (const c of [till, boss]) {
      const revs = c.frames
        .filter((f) => typeof f.rev === 'number' && f.rev > base)
        .map((f) => f.rev);
      expect(revs).toHaveLength(300);
      expect(revs).toEqual([...revs].sort((a, b) => (a as number) - (b as number)));
    }
    console.info(
      `latency: burst of 300 events on 2 sockets fully delivered in ${total.toFixed(1)} ms`,
    );
    expect(total).toBeLessThan(2000);
  });

  test('a real order write to the frame on two sockets (includes the PGlite transaction): p95 under a second', async () => {
    const till = await signedIn('cashier');
    const cook = await signedIn('kitchen');
    const menu = await h.newMenu();
    const token = await h.pinSession(device.token, cashier.id, cashier.pin);
    const samples: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const t0 = performance.now();
      const res = await h.app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: { authorization: `Bearer ${token}` },
        remoteAddress: h.nextIp(),
        payload: {
          clientRequestId: crypto.randomUUID(),
          channel: 'storefront',
          fulfillment: 'takeaway',
          items: [{ menuItemId: menu.noodles, qty: 1, modifierOptionIds: [menu.thin] }],
        },
      });
      expect(res.statusCode).toBe(201);
      const id = (res.json() as { id: string }).id;
      await Promise.all([
        till.next((f) => f.type === 'order.upserted' && f.id === id),
        cook.next((f) => f.type === 'order.upserted' && f.id === id),
      ]);
      for (const c of [till, cook]) {
        const at = c.frames.findIndex((f) => f.type === 'order.upserted' && f.id === id);
        samples.push((c.times[at] as number) - t0);
      }
    }
    const stats = report('POST /v1/orders (inject) -> order frame on each of two sockets', samples);
    expect(stats.p95).toBeLessThan(1000);
  });
});
