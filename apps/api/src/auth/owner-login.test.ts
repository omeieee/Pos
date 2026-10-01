import { sessionResponseSchema } from '@sds/shared';
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

// A fresh clock position and a fresh owner for every test: TOTP steps and lockouts are state.
let owner: OwnerFixture;
let ip = '';
const startOffset = { value: 0 };
async function fresh() {
  startOffset.value += 1;
  // Whole minutes apart, so one test's TOTP steps never overlap another's.
  h.clock.set(new Date(Date.parse(START_TIME) + startOffset.value * 3_600_000).toISOString());
  owner = await h.newOwner();
  ip = h.nextIp();
}

function login(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/auth/owner',
    payload: body,
    headers,
    remoteAddress: ip,
  });
}
const withTotp = (o: OwnerFixture, extra: Record<string, unknown> = {}) => ({
  email: o.email,
  password: o.password,
  totp: o.totp(),
  ...extra,
});
const wrong = (o: OwnerFixture) => ({
  email: o.email,
  password: 'definitely-not-it',
  totp: o.totp(),
});

describe('POST /v1/auth/owner', () => {
  test('signs in with password and TOTP and returns a session that works', async () => {
    await fresh();
    const res = await login(withTotp(owner));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = sessionResponseSchema.parse(res.json());
    expect(body.staff).toMatchObject({ id: owner.staffId, role: 'owner' });
    expect(body.permissions).toContain('settings.promptpay');
    expect(body.idleTimeoutSeconds).toBe(30 * 60);

    const me = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${body.sessionToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ staff: { id: owner.staffId }, stepUpUntil: null });

    const audit = await h.auditRows(owner.staffId);
    expect(audit.map((a) => a.action)).toEqual(['auth.owner_login']);
    expect(audit[0]?.after).toEqual({ method: 'password+totp' });
  });

  test('never returns hashes, secrets or the stored TOTP secret', async () => {
    await fresh();
    const res = await login(withTotp(owner));
    expect(res.body).not.toMatch(/scrypt\$|v1\.|passwordHash|totp_secret|pinHash/);
    expect(res.body).not.toContain(owner.totpSecret.toString('base64url'));
  });

  test('a wrong password, a wrong code and an unknown e-mail get the same answer', async () => {
    await fresh();
    const badPassword = await login(wrong(owner));
    const badTotp = await login(
      withTotp(owner, { totp: owner.totp() === '000000' ? '000001' : '000000' }),
    );
    const unknown = await login({
      email: 'nobody@example.test',
      password: 'whatever-it-is',
      totp: '123456',
    });
    for (const res of [badPassword, badTotp, unknown]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        code: 'INVALID_CREDENTIALS',
        message: 'Those details are not correct',
        details: {},
      });
    }
  });

  test('accepts a code one step either side for clock drift, and no further', async () => {
    await fresh();
    expect((await login(withTotp(owner, { totp: owner.totp(-1) }))).statusCode).toBe(200);
    await fresh();
    expect((await login(withTotp(owner, { totp: owner.totp(1) }))).statusCode).toBe(200);
    await fresh();
    expect((await login(withTotp(owner, { totp: owner.totp(2) }))).statusCode).toBe(401);
  });

  test('a TOTP code works once; neither it nor an older code can be replayed', async () => {
    await fresh();
    const code = owner.totp();
    const older = owner.totp(-1);
    expect((await login(withTotp(owner, { totp: code }))).statusCode).toBe(200);
    expect((await login(withTotp(owner, { totp: code }))).statusCode).toBe(401);
    expect((await login(withTotp(owner, { totp: older }))).statusCode).toBe(401);
    // The next step's code is new, so it works.
    expect((await login(withTotp(owner, { totp: owner.totp(1) }))).statusCode).toBe(200);
  });

  test('a wrong password does not use up the TOTP code', async () => {
    await fresh();
    expect((await login(wrong(owner))).statusCode).toBe(401);
    expect((await login(withTotp(owner))).statusCode).toBe(200);
  });

  test('parallel guesses are all counted', async () => {
    await fresh();
    await Promise.all([login(wrong(owner)), login(wrong(owner)), login(wrong(owner))]);
    const rows = await h.client.query<{ failed_login_count: number }>(
      'select failed_login_count from owner_credentials where staff_id = $1',
      [owner.staffId],
    );
    expect(rows.rows[0]?.failed_login_count).toBe(3);
  });

  test('five wrong tries lock the account for 15 minutes, with audit rows and an alert', async () => {
    await fresh();
    for (let i = 1; i <= 4; i++) expect((await login(wrong(owner))).statusCode).toBe(401);
    const fifth = await login(wrong(owner));
    expect(fifth.statusCode).toBe(423);
    expect(fifth.json()).toMatchObject({
      code: 'ACCOUNT_LOCKED',
      details: { retryAfterSeconds: 900 },
    });

    const actions = (await h.auditRows(owner.staffId)).map((a) => a.action);
    expect(actions.filter((a) => a === 'auth.owner_login_failed')).toHaveLength(4);
    expect(actions).toContain('auth.owner_locked');
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'alert.security',
        kind: 'owner.login_locked',
        severity: 'critical',
        staffId: owner.staffId,
      }),
    );

    // Even the right credentials are refused while locked.
    h.clock.advanceSeconds(60);
    expect((await login(withTotp(owner))).statusCode).toBe(423);
    // After the lock the owner can sign in again and the count starts over.
    h.clock.advanceSeconds(15 * 60);
    expect((await login(withTotp(owner))).statusCode).toBe(200);
    expect((await login(wrong(owner))).statusCode).toBe(401);
    expect((await login(wrong(owner))).statusCode).toBe(401);
  });

  test('a recovery code signs in once, in any case or grouping, and raises an alert', async () => {
    await fresh();
    const [first, second] = owner.recoveryCodes;
    expect(first && second).toBeTruthy();
    const body = (code: string) => ({
      email: owner.email,
      password: owner.password,
      recoveryCode: code,
    });

    const written = (first ?? '').toLowerCase().replaceAll('-', ' ');
    expect((await login(body(written))).statusCode).toBe(200);
    expect((await login(body(first ?? ''))).statusCode).toBe(401);
    expect((await login(body(second ?? ''))).statusCode).toBe(200);

    const actions = (await h.auditRows(owner.staffId)).map((a) => a.action);
    expect(actions.filter((a) => a === 'auth.recovery_code_used')).toHaveLength(2);
    expect(h.events.filter((e) => e.kind === 'owner.recovery_code_used')).toHaveLength(2);
  });

  test('a recovery code needs the password too', async () => {
    await fresh();
    const res = await login({
      email: owner.email,
      password: 'definitely-not-it',
      recoveryCode: owner.recoveryCodes[0],
    });
    expect(res.statusCode).toBe(401);
    // The code was not consumed.
    const ok = await login({
      email: owner.email,
      password: owner.password,
      recoveryCode: owner.recoveryCodes[0],
    });
    expect(ok.statusCode).toBe(200);
  });

  test('an inactive owner cannot sign in', async () => {
    await fresh();
    await h.client.query('update staff set active = false where id = $1', [owner.staffId]);
    expect((await login(withTotp(owner))).statusCode).toBe(401);
  });

  test('rejects a body without exactly one second factor, without echoing the password', async () => {
    await fresh();
    const none = await login({ email: owner.email, password: owner.password });
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(none.body).not.toContain(owner.password);

    const both = await login(withTotp(owner, { recoveryCode: owner.recoveryCodes[0] }));
    expect(both.statusCode).toBe(400);
  });

  test('can be tied to a registered device; an unknown device token is refused', async () => {
    await fresh();
    const device = await h.newDevice('laptop');
    const ok = await login(withTotp(owner), { 'x-device-token': device.token });
    expect(ok.statusCode).toBe(200);
    const me = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${ok.json().sessionToken}` },
    });
    expect(me.json()).toMatchObject({ deviceId: device.id });

    await fresh();
    const bad = await login(withTotp(owner), {
      'x-device-token': 'sds_dev_not-a-real-token-value',
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({ code: 'DEVICE_UNREGISTERED' });
  });

  test('is rate limited per IP', async () => {
    await fresh();
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const res = await login({
        email: 'nobody@example.test',
        password: 'whatever-it-is',
        totp: '123456',
      });
      if (res.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
