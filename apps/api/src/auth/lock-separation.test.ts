/**
 * Lock-out denial of service (QA High): guessing at the public sign-in must not lock the people
 * who are already signed in out of step-up, step-up guessing must not lock sign-in, and a locked
 * owner must look exactly like an e-mail that does not exist.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createHarness,
  type Harness,
  type OwnerFixture,
  START_TIME,
} from '../test-support/harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

let day = 0;
function freshClock() {
  day += 1;
  h.clock.set(new Date(Date.parse(START_TIME) + day * 24 * 3_600_000).toISOString());
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const signIn = (body: Record<string, unknown>) =>
  h.app.inject({ method: 'POST', url: '/v1/auth/owner', payload: body, remoteAddress: h.nextIp() });
const stepUp = (token: string, body: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/auth/step-up',
    headers: bearer(token),
    payload: body,
    remoteAddress: h.nextIp(),
  });
const wrongSignIn = (o: OwnerFixture) =>
  signIn({ email: o.email, password: 'definitely-not-it', totp: '000000' });

describe('a locked owner looks like an e-mail that does not exist', () => {
  test('the answer is byte for byte the same, before, at and after the lock', async () => {
    freshClock();
    const owner = await h.newOwner();
    const unknown = await signIn({
      email: 'nobody@example.test',
      password: 'whatever-it-is',
      totp: '123456',
    });
    expect(unknown.statusCode).toBe(401);

    const answers = [];
    for (let i = 0; i < 5; i++) answers.push(await wrongSignIn(owner)); // the 5th locks
    const right = await signIn({
      email: owner.email,
      password: owner.password,
      totp: owner.totp(),
    });
    answers.push(right); // locked: even the right credentials
    for (const res of answers) {
      expect(res.statusCode).toBe(401);
      expect(res.body).toBe(unknown.body);
    }
    // The lock is real and was recorded for the operator.
    expect((await h.auditRows(owner.staffId)).map((a) => a.action)).toContain('auth.owner_locked');
    expect(h.alerts).toContainEqual(
      expect.objectContaining({ kind: 'owner.login_locked', severity: 'critical' }),
    );
  });

  test('no 423, no retry hint, no header that differs', async () => {
    freshClock();
    const owner = await h.newOwner();
    for (let i = 0; i < 5; i++) await wrongSignIn(owner);
    const locked = await signIn({
      email: owner.email,
      password: owner.password,
      totp: owner.totp(),
    });
    const unknown = await signIn({
      email: 'nobody@example.test',
      password: 'whatever-it-is',
      totp: '123456',
    });
    expect(locked.body).not.toMatch(/lock|retry|later/i);
    const keep = (r: typeof locked) => ({
      ...r.headers,
      date: undefined,
      'content-length': undefined,
    });
    expect(keep(locked)).toEqual(keep(unknown));
  });
});

describe('sign-in and step-up have separate counters and locks', () => {
  test('guessing at the public sign-in does not stop an open session from stepping up', async () => {
    freshClock();
    const owner = await h.newOwner();
    const session = await h.ownerSession(owner);
    for (let i = 0; i < 5; i++) await wrongSignIn(owner); // sign-in is now locked for 15 minutes
    expect(
      (await signIn({ email: owner.email, password: owner.password, totp: owner.totp(1) }))
        .statusCode,
    ).toBe(401);

    h.clock.advanceSeconds(30);
    const res = await stepUp(session, { password: owner.password, totp: owner.totp(1) });
    expect(res.statusCode).toBe(200);
  });

  test('guessing at step-up locks step-up (and says so), not the sign-in', async () => {
    freshClock();
    const owner = await h.newOwner();
    const session = await h.ownerSession(owner);
    for (let i = 0; i < 4; i++) {
      expect(
        (await stepUp(session, { password: 'nope-nope-nope', totp: '000000' })).statusCode,
      ).toBe(401);
    }
    const fifth = await stepUp(session, { password: 'nope-nope-nope', totp: '000000' });
    // The caller is signed in as this account, so telling them is no leak.
    expect(fifth.statusCode).toBe(423);
    expect(fifth.json()).toMatchObject({
      code: 'ACCOUNT_LOCKED',
      details: { retryAfterSeconds: 900 },
    });
    expect((await h.auditRows(owner.staffId)).map((a) => a.action)).toContain(
      'auth.step_up_locked',
    );
    expect(h.alerts).toContainEqual(expect.objectContaining({ kind: 'owner.step_up_locked' }));

    h.clock.advanceSeconds(30);
    expect(
      (await signIn({ email: owner.email, password: owner.password, totp: owner.totp(1) }))
        .statusCode,
    ).toBe(200);
  });

  test('PIN: wrong sign-in PINs do not lock step-up', async () => {
    freshClock();
    const device = await h.newDevice();
    const manager = await h.newStaff('manager', '4821');
    const token = await h.pinSession(device.token, manager.id, '4821');
    const pinSignIn = (pin: string) =>
      h.app.inject({
        method: 'POST',
        url: '/v1/auth/pin',
        headers: { 'x-device-token': device.token },
        payload: { staffId: manager.id, pin },
        remoteAddress: h.nextIp(),
      });
    for (let i = 0; i < 5; i++) await pinSignIn('0000');
    expect((await pinSignIn('4821')).statusCode).toBe(423);
    expect((await stepUp(token, { pin: '4821' })).statusCode).toBe(200);
  });

  test('PIN: wrong step-up PINs do not lock sign-in', async () => {
    freshClock();
    const device = await h.newDevice();
    const manager = await h.newStaff('manager', '4821');
    const token = await h.pinSession(device.token, manager.id, '4821');
    for (let i = 0; i < 5; i++) await stepUp(token, { pin: '0000' });
    expect((await stepUp(token, { pin: '4821' })).statusCode).toBe(423);
    const login = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/pin',
      headers: { 'x-device-token': device.token },
      payload: { staffId: manager.id, pin: '4821' },
      remoteAddress: h.nextIp(),
    });
    expect(login.statusCode).toBe(200);
  });
});

describe('global rate buckets on /v1/auth/owner and /v1/auth/step-up', () => {
  test('cap the total, whoever asks, and open again after the window', async () => {
    const small = await createHarness({
      policy: { ownerGlobalRatePerMinute: 3, stepUpGlobalRatePerMinute: 2 },
    });
    try {
      const owner = await small.newOwner();
      const device = await small.newDevice();
      const manager = await small.newStaff('manager', '4821');
      const session = await small.pinSession(device.token, manager.id, '4821');

      const attempt = () =>
        small.app.inject({
          method: 'POST',
          url: '/v1/auth/owner',
          payload: { email: owner.email, password: 'definitely-not-it', totp: '000000' },
          remoteAddress: small.nextIp(), // every request from a different address
        });
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await attempt()).statusCode);
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
      const limited = await attempt();
      expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED' });

      const step = () =>
        small.app.inject({
          method: 'POST',
          url: '/v1/auth/step-up',
          headers: { authorization: `Bearer ${session}`, 'x-device-token': device.token },
          payload: { pin: '0000' },
          remoteAddress: small.nextIp(),
        });
      expect([
        (await step()).statusCode,
        (await step()).statusCode,
        (await step()).statusCode,
      ]).toEqual([401, 401, 429]);

      // Other routes have their own limits.
      const pin = await small.app.inject({
        method: 'POST',
        url: '/v1/auth/pin',
        headers: { 'x-device-token': device.token },
        payload: { staffId: manager.id, pin: '4821' },
        remoteAddress: small.nextIp(),
      });
      expect(pin.statusCode).toBe(200);

      small.clock.advanceSeconds(61);
      expect((await attempt()).statusCode).toBe(401);
    } finally {
      await small.close();
    }
  }, 60_000);
});
