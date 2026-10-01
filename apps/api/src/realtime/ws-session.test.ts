/**
 * The heartbeat and the session re-check of `WS /v1/ws`, on a fast beat (150 ms instead of 25 s) so
 * the tests can wait for it. The beat is the same code with a shorter timer.
 *
 * The in-memory sockets (`injectWS`) are used here; ws-tcp.test.ts covers real TCP.
 */
import { authRepo } from '@sds/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { hashToken } from '../auth/crypto.ts';
import { DEFAULT_AUTH_POLICY } from '../auth/policy.ts';
import { type AuthContext, authenticateSession, peekSession } from '../auth/service.ts';
import { createHarness, type Harness } from '../test-support/harness.ts';
import { connect, expectClosed, ofType, pause, until, type WsClient } from './test-helpers.ts';

const BEAT_MS = 150;
let h: Harness;
let device: { id: string; token: string };
const used: WsClient[] = [];

beforeAll(async () => {
  h = await createHarness({
    realtime: { hub: { heartbeatMs: BEAT_MS, authTimeoutMs: 2000, maxPerIp: 100, maxTotal: 500 } },
  });
  device = await h.newDevice();
}, 60_000);
beforeEach(() => {
  h.clock.set('2028-03-01T03:00:00.000Z');
});
afterEach(async () => {
  for (const c of used.splice(0)) if (!c.isClosed()) c.raw.close();
  await pause(20);
});
afterAll(async () => {
  await h.close();
});

async function signedIn(role: 'cashier' | 'kitchen' | 'manager' = 'cashier') {
  const person = await h.newStaff(role, '4821');
  const token = await h.pinSession(device.token, person.id, person.pin);
  const client = await connect(h.app);
  used.push(client);
  client.send({ type: 'auth', sessionToken: token, deviceToken: device.token });
  await client.next(ofType('ready'));
  return { client, token, person };
}

const row = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.client.query<T>(sql, params)).rows[0];

describe('the heartbeat', () => {
  test('app-level ping frames arrive, each with the newest rev', async () => {
    const { client } = await signedIn();
    const ready = client.frames.find(ofType('ready'));
    const first = await client.next(ofType('ping'));
    expect(typeof first.serverRev).toBe('number');
    expect(first.serverRev as number).toBeGreaterThanOrEqual(ready?.serverRev as number);
    // A ping keeps coming while the socket lives.
    await until(() => client.seen(ofType('ping')).length >= 3);
    // A synced write moves the number the next ping carries.
    await h.client.query("insert into menu_categories (name_th) values ('ping-test')");
    const latest = await row<{ v: string }>(
      "select last_value::text as v from pg_sequences where sequencename = 'rev_seq'",
    );
    await until(() =>
      client.frames.some((f) => f.type === 'ping' && f.serverRev === Number(latest?.v)),
    );
  });

  test('a client that stops answering is dropped within a couple of beats', async () => {
    const { client } = await signedIn();
    // A client that no longer answers protocol pings (a tablet that fell asleep, a dead Wi-Fi link).
    (client.raw as unknown as { _autoPong: boolean })._autoPong = false;
    const closed = await expectClosed(client, 2000);
    expect(closed.code).toBe(1006);
  });

  test('a client that answers stays up across many beats', async () => {
    const { client } = await signedIn();
    await pause(BEAT_MS * 8);
    expect(client.isClosed()).toBe(false);
  });
});

describe('sessions are re-checked on every beat, and a socket never extends one', () => {
  test('a session that went idle closes 4401', async () => {
    const { client } = await signedIn();
    h.clock.advanceSeconds(DEFAULT_AUTH_POLICY.pinIdleSeconds + 1);
    expect(await expectClosed(client, 2000)).toMatchObject({ code: 4401, reason: 'session_ended' });
  });

  test('an open socket does not touch the session or the device (and burns no rev)', async () => {
    const { client, token } = await signedIn();
    const before = await row<{ last_seen_at: string; rev: string }>(
      `select s.last_seen_at::text, d.rev::text from sessions s join devices d on d.id = s.device_id
        where s.token_hash = $1`,
      [hashToken(token)],
    );
    // Well inside the idle limit but past the touch interval: a REST call WOULD refresh both.
    h.clock.advanceSeconds(DEFAULT_AUTH_POLICY.deviceSeenIntervalSeconds + 60);
    await pause(BEAT_MS * 6);
    expect(client.isClosed()).toBe(false);
    const after = await row<{ last_seen_at: string; rev: string }>(
      `select s.last_seen_at::text, d.rev::text from sessions s join devices d on d.id = s.device_id
        where s.token_hash = $1`,
      [hashToken(token)],
    );
    expect(after).toEqual(before);
  });

  test('so a socket cannot keep an otherwise idle session alive: it ends at the idle limit', async () => {
    const { client } = await signedIn();
    // Ten checks in, one hour apart on the test clock: still alive, never refreshed...
    h.clock.advanceSeconds(60 * 60);
    await pause(BEAT_MS * 3);
    expect(client.isClosed()).toBe(false);
    // ...and gone once the two hours are up.
    h.clock.advanceSeconds(60 * 60 + 5);
    expect(await expectClosed(client, 2000)).toMatchObject({ code: 4401 });
  });

  test('the absolute end of a session closes it even if it was never idle', async () => {
    const { client, token } = await signedIn();
    await h.client.query('update sessions set expires_at = $1 where token_hash = $2', [
      h.clock.now().toISOString(),
      hashToken(token),
    ]);
    expect(await expectClosed(client, 2000)).toMatchObject({ code: 4401, reason: 'session_ended' });
  });

  test('a revoked session, a deactivated person and a revoked device each close it, with no event needed', async () => {
    const a = await signedIn();
    await h.client.query('update sessions set revoked_at = now() where token_hash = $1', [
      hashToken(a.token),
    ]);
    expect(await expectClosed(a.client, 2000)).toMatchObject({ code: 4401 });

    const b = await signedIn();
    await h.client.query('update staff set active = false where id = $1', [b.person.id]);
    expect(await expectClosed(b.client, 2000)).toMatchObject({ code: 4401 });

    const spare = await h.newDevice();
    const person = await h.newStaff('cashier', '4821');
    const token = await h.pinSession(spare.token, person.id, person.pin);
    const c = await connect(h.app);
    used.push(c);
    c.send({ type: 'auth', sessionToken: token, deviceToken: spare.token });
    await c.next(ofType('ready'));
    await h.revokeDevice(spare.id);
    expect(await expectClosed(c, 2000)).toMatchObject({ code: 4401 });
  });

  test('a role change applies from the next beat: a cashier made kitchen stops getting customer frames', async () => {
    const { client, person } = await signedIn('cashier');
    const customer = (rev: number) => {
      const id = crypto.randomUUID();
      return {
        type: 'customer.upserted' as const,
        id,
        rev,
        data: {
          id,
          displayName: 'คุณสมชาย',
          nickname: null,
          roomNo: null,
          firstSeenAt: '2026-10-02T03:00:00.000Z',
          lastOrderAt: null,
          orderCount: 0,
          totalSpentSatang: 0,
          anonymized: false,
          version: 1,
          rev,
        },
      };
    };
    h.bus.publish(customer(5001));
    await client.next((f) => f.type === 'customer.upserted' && f.rev === 5001);

    await h.client.query("update staff set role = 'kitchen' where id = $1", [person.id]);
    await pause(BEAT_MS * 4);
    h.bus.publish(customer(5002));
    await pause(100);
    expect(client.frames.some((f) => f.type === 'customer.upserted' && f.rev === 5002)).toBe(false);
    expect(client.isClosed()).toBe(false);
  });
});

describe('peekSession', () => {
  const ctx = (): AuthContext => ({
    db: h.db,
    keys: h.keys,
    policy: DEFAULT_AUTH_POLICY,
    now: h.clock.now,
    events: h.bus,
  });

  test('gives the same answer as authenticateSession, and writes nothing', async () => {
    const person = await h.newStaff('cashier', '4821');
    const token = await h.pinSession(device.token, person.id, person.pin);
    h.clock.advanceSeconds(DEFAULT_AUTH_POLICY.deviceSeenIntervalSeconds + 120);

    const stamp = async () =>
      row<{ s: string; d: string; r: string }>(
        `select s.last_seen_at::text as s, d.last_seen_at::text as d, d.rev::text as r
           from sessions s join devices d on d.id = s.device_id where s.token_hash = $1`,
        [hashToken(token)],
      );
    const before = await stamp();
    const peeked = await peekSession(ctx(), token, device.token);
    expect(await stamp()).toEqual(before); // nothing written

    const authed = await authenticateSession(ctx(), token, device.token);
    expect(peeked).toEqual(authed);
    expect(await stamp()).not.toEqual(before); // the REST check does touch both
  });

  test('refuses what the REST guard refuses: unknown token, wrong device, ended session', async () => {
    const person = await h.newStaff('cashier', '4821');
    const token = await h.pinSession(device.token, person.id, person.pin);
    expect(await peekSession(ctx(), 'x'.repeat(30), device.token)).toBeNull();
    await expect(peekSession(ctx(), token, undefined)).rejects.toMatchObject({
      code: 'DEVICE_MISMATCH',
    });
    await expect(
      peekSession(ctx(), token, 'sds_dev_Another-Device-Token-1234'),
    ).rejects.toMatchObject({ code: 'DEVICE_MISMATCH' });
    await authRepo.revokeSession(
      h.db,
      (await peekSession(ctx(), token, device.token))?.sessionId ?? '',
      h.clock.now(),
    );
    expect(await peekSession(ctx(), token, device.token)).toBeNull();
  });
});
