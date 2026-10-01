import {
  hasPermission,
  PERMISSIONS,
  requiresStepUp,
  STAFF_ROLES,
  type StaffRole,
  stepUpResponseSchema,
} from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createHarness,
  type Harness,
  type OwnerFixture,
  START_TIME,
  TEST_MASTER_KEY,
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

function stepUp(token: string | undefined, body: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/auth/step-up',
    headers: token ? bearer(token) : {},
    payload: body,
    remoteAddress: h.nextIp(),
  });
}

/** Step-up for the owner: password + the next TOTP code (a code works once). */
function ownerStepUp(token: string, owner: OwnerFixture, extra: Record<string, unknown> = {}) {
  h.clock.advanceSeconds(30);
  return stepUp(token, { password: owner.password, totp: owner.totp(1), ...extra });
}

interface Actor {
  token: string;
  staffId: string;
  /** Re-authenticates the way this role must. */
  stepUp(): Promise<{ statusCode: number }>;
}

async function actor(role: StaffRole): Promise<Actor> {
  if (role === 'owner') {
    const owner = await h.newOwner();
    const token = await h.ownerSession(owner);
    return { token, staffId: owner.staffId, stepUp: () => ownerStepUp(token, owner) };
  }
  const device = await h.newDevice();
  const staff = await h.newStaff(role, '4821');
  const token = await h.pinSession(device.token, staff.id, staff.pin);
  return { token, staffId: staff.id, stepUp: () => stepUp(token, { pin: staff.pin }) };
}

describe('permission matrix (RBAC) on every route guard', () => {
  test('a request without a session is refused', async () => {
    freshClock();
    for (const permission of [undefined, ...PERMISSIONS]) {
      const res = await h.probe(undefined, permission);
      expect(res.statusCode, String(permission)).toBe(401);
    }
  });

  test.each(STAFF_ROLES)(
    '%s: allowed, forbidden and step-up outcomes follow packages/shared',
    async (role) => {
      freshClock();
      const who = await actor(role);
      expect((await h.probe(who.token)).statusCode).toBe(200);

      // Before step-up: forbidden beats step-up; sensitive permissions ask for step-up.
      for (const permission of PERMISSIONS) {
        const res = await h.probe(who.token, permission);
        if (!hasPermission(role, permission)) {
          expect(res.statusCode, `${role} ${permission}`).toBe(403);
          expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
        } else if (requiresStepUp(permission)) {
          expect(res.statusCode, `${role} ${permission}`).toBe(403);
          expect(res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
        } else {
          expect(res.statusCode, `${role} ${permission}`).toBe(200);
        }
      }

      // After step-up the sensitive permissions the role holds open; the rest stay shut.
      expect((await who.stepUp()).statusCode).toBe(200);
      for (const permission of PERMISSIONS) {
        const res = await h.probe(who.token, permission);
        expect(res.statusCode, `${role} ${permission}`).toBe(
          hasPermission(role, permission) ? 200 : 403,
        );
      }
    },
  );

  test('only the owner can reach the PromptPay ID, staff, devices and exports', async () => {
    freshClock();
    for (const role of STAFF_ROLES) {
      const who = await actor(role);
      await who.stepUp();
      for (const permission of [
        'settings.promptpay',
        'staff.manage',
        'device.manage',
        'data.export',
      ] as const) {
        const res = await h.probe(who.token, permission);
        expect(res.statusCode, `${role} ${permission}`).toBe(role === 'owner' ? 200 : 403);
      }
    }
  });
});

describe('POST /v1/auth/step-up', () => {
  test('needs a session', async () => {
    freshClock();
    expect((await stepUp(undefined, { pin: '4821' })).statusCode).toBe(401);
  });

  test('owner: password + a fresh code grants five minutes, and is audited', async () => {
    freshClock();
    const owner = await h.newOwner();
    const token = await h.ownerSession(owner);
    const res = await ownerStepUp(token, owner);
    expect(res.statusCode).toBe(200);
    const body = stepUpResponseSchema.parse(res.json());
    expect(new Date(body.stepUpUntil).getTime()).toBe(h.clock.now().getTime() + 5 * 60 * 1000);

    const me = await h.app.inject({ method: 'GET', url: '/v1/auth/me', headers: bearer(token) });
    expect(me.json()).toMatchObject({ stepUpUntil: body.stepUpUntil });

    const audit = (await h.auditRows(owner.staffId)).filter((a) => a.action === 'auth.step_up');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.after).toMatchObject({ method: 'password+totp' });
  });

  test('owner: signing in does not count, and the sign-in code cannot be reused', async () => {
    freshClock();
    const owner = await h.newOwner();
    const token = await h.ownerSession(owner);
    expect((await h.probe(token, 'settings.promptpay')).json()).toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    // The code used to sign in is spent.
    const reuse = await stepUp(token, { password: owner.password, totp: owner.totp() });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  test('owner: a wrong password is refused, audited and counted', async () => {
    freshClock();
    const owner = await h.newOwner();
    const token = await h.ownerSession(owner);
    h.clock.advanceSeconds(30);
    const res = await stepUp(token, { password: 'not-the-password', totp: owner.totp(1) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect((await h.auditRows(owner.staffId)).map((a) => a.action)).toContain(
      'auth.step_up_failed',
    );
    expect((await h.probe(token, 'settings.promptpay')).json()).toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
  });

  test('R4: an owner who unlocked a device with a PIN still needs password + code to change the PromptPay ID', async () => {
    freshClock();
    const owner = await h.newOwner({ pin: '2468' });
    const device = await h.newDevice();
    const token = await h.pinSession(device.token, owner.staffId, '2468');
    expect((await h.probe(token, 'settings.promptpay')).json()).toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });

    // The PIN is not enough, even though it opened the session.
    const withPin = await stepUp(token, { pin: '2468' });
    expect(withPin.statusCode).toBe(400);
    expect((await h.probe(token, 'settings.promptpay')).statusCode).toBe(403);

    expect((await ownerStepUp(token, owner)).statusCode).toBe(200);
    expect((await h.probe(token, 'settings.promptpay')).statusCode).toBe(200);
  });

  test('owner: a recovery code works as the second factor, once, and alerts the owner', async () => {
    freshClock();
    const owner = await h.newOwner();
    const token = await h.ownerSession(owner);
    const body = { password: owner.password, recoveryCode: owner.recoveryCodes[0] };
    expect((await stepUp(token, body)).statusCode).toBe(200);
    expect((await stepUp(token, body)).statusCode).toBe(401);
    expect(
      h.events.some((e) => e.kind === 'owner.recovery_code_used' && e.staffId === owner.staffId),
    ).toBe(true);
    // Step-up audits the break-glass code just like signing in does.
    const used = (await h.auditRows(owner.staffId)).filter(
      (a) => a.action === 'auth.recovery_code_used',
    );
    expect(used).toHaveLength(1);
    expect(used[0]?.after).toEqual({ remaining: 7 });
  });

  test('owner: five wrong tries lock the account, and the lock also blocks signing in', async () => {
    freshClock();
    const owner = await h.newOwner();
    const token = await h.ownerSession(owner);
    for (let i = 0; i < 4; i++) {
      expect((await stepUp(token, { password: 'nope-nope-nope', totp: '000000' })).statusCode).toBe(
        401,
      );
    }
    const fifth = await stepUp(token, { password: 'nope-nope-nope', totp: '000000' });
    expect(fifth.statusCode).toBe(423);
    expect((await h.auditRows(owner.staffId)).map((a) => a.action)).toContain('auth.owner_locked');

    h.clock.advanceSeconds(30);
    const login = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/owner',
      payload: { email: owner.email, password: owner.password, totp: owner.totp(1) },
      remoteAddress: h.nextIp(),
    });
    expect(login.statusCode).toBe(423);
  });

  test('manager: re-enters the PIN; the password form is refused', async () => {
    freshClock();
    const who = await actor('manager');
    expect(
      (await stepUp(who.token, { password: 'whatever-it-is', totp: '123456' })).statusCode,
    ).toBe(400);
    expect((await stepUp(who.token, { pin: '0000' })).statusCode).toBe(401);
    expect((await h.probe(who.token, 'payment.void_refund')).json()).toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    expect((await who.stepUp()).statusCode).toBe(200);
    expect((await h.probe(who.token, 'payment.void_refund')).statusCode).toBe(200);
  });

  test('manager: wrong PINs share the PIN lock with signing in', async () => {
    freshClock();
    const device = await h.newDevice();
    const staff = await h.newStaff('manager', '4821');
    const token = await h.pinSession(device.token, staff.id, '4821');
    for (let i = 0; i < 4; i++) expect((await stepUp(token, { pin: '0000' })).statusCode).toBe(401);
    expect((await stepUp(token, { pin: '0000' })).statusCode).toBe(423);
    // The right PIN is refused now, for step-up and for a new sign-in alike.
    expect((await stepUp(token, { pin: '4821' })).statusCode).toBe(423);
    const login = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/pin',
      headers: { 'x-device-token': device.token },
      payload: { staffId: staff.id, pin: '4821' },
      remoteAddress: h.nextIp(),
    });
    expect(login.statusCode).toBe(423);
  });

  test('is per session: a second session has none, and so does a new sign-in', async () => {
    freshClock();
    const owner = await h.newOwner();
    const first = await h.ownerSession(owner);
    expect((await ownerStepUp(first, owner)).statusCode).toBe(200);
    expect((await h.probe(first, 'device.manage')).statusCode).toBe(200);

    h.clock.advanceSeconds(60);
    const second = await h.ownerSession(owner);
    expect((await h.probe(second, 'device.manage')).statusCode).toBe(403);

    await h.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(first) });
    expect((await h.probe(first, 'device.manage')).statusCode).toBe(401);
  });
});

describe('credentials stay out of logs and responses', () => {
  test('a full sign-in, step-up and device registration leaves no secret in the log', async () => {
    freshClock();
    const owner = await h.newOwner();
    const device = await h.newDevice();
    const cashier = await h.newStaff('cashier', '4821');

    const ownerToken = await h.ownerSession(owner, device.token);
    await ownerStepUp(ownerToken, owner);
    const registered = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/device',
      headers: { ...bearer(ownerToken), 'x-device-token': device.token },
      payload: { name: 'Kitchen iPhone', kind: 'iphone' },
      remoteAddress: h.nextIp(),
    });
    expect(registered.statusCode).toBe(201);
    const newDeviceToken = (registered.json() as { deviceToken: string }).deviceToken;
    const cashierToken = await h.pinSession(device.token, cashier.id, '4821');
    await h.app.inject({
      method: 'POST',
      url: '/v1/auth/pin',
      headers: { 'x-device-token': device.token },
      payload: { staffId: cashier.id, pin: '9999' },
      remoteAddress: h.nextIp(),
    });
    await h.app.inject({
      method: 'POST',
      url: '/v1/auth/owner',
      payload: { email: owner.email, password: 'wrong-wrong-wrong', totp: '000000' },
      remoteAddress: h.nextIp(),
    });

    const logs = h.logs();
    // The log is not empty: the requests themselves were logged.
    expect(logs).toContain('/v1/auth/owner');
    expect(logs).toContain('/v1/auth/pin');

    const longSecrets = [
      owner.password,
      'wrong-wrong-wrong',
      ownerToken,
      cashierToken,
      device.token,
      newDeviceToken,
      owner.totpSecret.toString('base64url'),
      owner.totpSecret.toString('hex'),
      ...owner.recoveryCodes,
      TEST_MASTER_KEY.toString('base64'),
      TEST_MASTER_KEY.toString('hex'),
    ];
    for (const secret of longSecrets) expect(logs, secret.slice(0, 8)).not.toContain(secret);
    // PINs and codes are short and could match by chance, so check that no body field is logged.
    expect(logs).not.toMatch(/"(pin|password|totp|recoveryCode)":"[^[]/);
  });

  test('an invalid body is answered and logged without its values', async () => {
    freshClock();
    const secret = 'a-very-recognisable-password-value';
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/owner',
      payload: { email: 'not-an-email', password: secret },
      remoteAddress: h.nextIp(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(res.body).not.toContain(secret);
    expect(h.logs()).not.toContain(secret);
  });

  test('responses to failed sign-ins carry no hint about which part was wrong', async () => {
    freshClock();
    const owner = await h.newOwner();
    const a = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/owner',
      payload: { email: owner.email, password: 'wrong-wrong-wrong', totp: owner.totp() },
      remoteAddress: h.nextIp(),
    });
    const b = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/owner',
      payload: { email: owner.email, password: owner.password, totp: '000000' },
      remoteAddress: h.nextIp(),
    });
    expect(a.body).toBe(b.body);
  });
});
