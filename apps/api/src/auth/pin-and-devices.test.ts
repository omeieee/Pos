import { registerDeviceResponseSchema, sessionResponseSchema } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness, START_TIME } from '../test-support/harness.ts';
import { hashToken } from './crypto.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

let hour = 0;
/** Every test starts at its own hour, so locks and step-ups from other tests never overlap. */
function freshClock() {
  hour += 1;
  h.clock.set(new Date(Date.parse(START_TIME) + hour * 24 * 3_600_000).toISOString());
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function pin(deviceToken: string | undefined, body: Record<string, unknown>, ip = h.nextIp()) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/auth/pin',
    headers: deviceToken ? { 'x-device-token': deviceToken } : {},
    payload: body,
    remoteAddress: ip,
  });
}

const me = (token: string) =>
  h.app.inject({ method: 'GET', url: '/v1/auth/me', headers: bearer(token) });

async function rowOf(sql: string, params: unknown[]) {
  const res = await h.client.query<Record<string, unknown>>(sql, params);
  return res.rows[0];
}

const INVALID = {
  code: 'INVALID_CREDENTIALS',
  message: 'Those details are not correct',
  details: {},
};

describe('POST /v1/auth/device', () => {
  const register = (
    token: string | undefined,
    body: unknown = { name: 'Counter iPad', kind: 'ipad' },
  ) =>
    h.app.inject({
      method: 'POST',
      url: '/v1/auth/device',
      headers: token ? bearer(token) : {},
      payload: body as Record<string, unknown>,
      remoteAddress: h.nextIp(),
    });

  test('needs a signed-in session', async () => {
    freshClock();
    const res = await register(undefined);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  test('a cashier or manager may not register devices', async () => {
    freshClock();
    const device = await h.newDevice();
    for (const role of ['cashier', 'manager', 'kitchen'] as const) {
      const staff = await h.newStaff(role, '4821');
      const session = await h.pinSession(device.token, staff.id, staff.pin);
      const res = await register(session);
      expect(res.statusCode, role).toBe(403);
      expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  test('the owner needs a fresh step-up; signing in is not enough', async () => {
    freshClock();
    const owner = await h.newOwner();
    const session = await h.ownerSession(owner);
    const res = await register(session);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  test('registers a device after step-up: token shown once, only a hash stored, audited, owner alerted', async () => {
    freshClock();
    const owner = await h.newOwner();
    const session = await h.steppedUpOwner(owner);
    const res = await register(session, { name: '  Counter iPad ', kind: 'ipad' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = registerDeviceResponseSchema.parse(res.json());
    expect(body.device).toMatchObject({ name: 'Counter iPad', kind: 'ipad' });
    expect(body.deviceToken).toMatch(/^sds_dev_[A-Za-z0-9_-]{43}$/);

    const stored = await rowOf('select token_hash from devices where id = $1', [body.device.id]);
    expect(stored?.token_hash).toBe(hashToken(body.deviceToken));
    expect(JSON.stringify(stored)).not.toContain(body.deviceToken);

    const audit = await h.auditRows(body.device.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'device.register',
      actorType: 'staff',
      actorId: owner.staffId,
      after: { name: 'Counter iPad', kind: 'ipad' },
    });
    expect(JSON.stringify(audit)).not.toContain(body.deviceToken);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        kind: 'device.registered',
        severity: 'warn',
        deviceId: body.device.id,
      }),
    );

    // The new token opens the PIN screen's staff list.
    const list = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/staff',
      headers: { 'x-device-token': body.deviceToken },
      remoteAddress: h.nextIp(),
    });
    expect(list.statusCode).toBe(200);
  });

  test('the step-up expires after five minutes', async () => {
    freshClock();
    const owner = await h.newOwner();
    const session = await h.steppedUpOwner(owner);
    expect((await register(session)).statusCode).toBe(201);
    h.clock.advanceSeconds(5 * 60 - 1);
    expect((await register(session)).statusCode).toBe(201);
    h.clock.advanceSeconds(2);
    const res = await register(session);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  test('rejects an unknown kind or an empty name', async () => {
    freshClock();
    const owner = await h.newOwner();
    const session = await h.steppedUpOwner(owner);
    expect((await register(session, { name: 'x', kind: 'toaster' })).statusCode).toBe(400);
    expect((await register(session, { name: '  ', kind: 'ipad' })).statusCode).toBe(400);
  });
});

describe('GET /v1/auth/staff', () => {
  const list = (token: string | undefined) =>
    h.app.inject({
      method: 'GET',
      url: '/v1/auth/staff',
      headers: token ? { 'x-device-token': token } : {},
      remoteAddress: h.nextIp(),
    });

  test('needs a registered device', async () => {
    freshClock();
    for (const token of [undefined, 'sds_dev_unknown-token-value-123456789']) {
      const res = await list(token);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'DEVICE_UNREGISTERED' });
    }
  });

  test('refuses a revoked device and the print agent', async () => {
    freshClock();
    const revoked = await h.newDevice();
    await h.revokeDevice(revoked.id);
    expect((await list(revoked.token)).statusCode).toBe(401);
    const agent = await h.newDevice('print_agent');
    expect((await list(agent.token)).statusCode).toBe(403);
  });

  test('lists active staff who have a PIN, with no hashes', async () => {
    freshClock();
    const device = await h.newDevice();
    const cashier = await h.newStaff('cashier', '4821');
    const gone = await h.newStaff('kitchen', '4821');
    await h.client.query('update staff set active = false where id = $1', [gone.id]);
    const res = await list(device.token);
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { staff: { id: string }[] }).staff.map((s) => s.id);
    expect(ids).toContain(cashier.id);
    expect(ids).not.toContain(gone.id);
    expect(res.body).not.toMatch(/scrypt|pinHash|pin_hash/);
  });
});

describe('POST /v1/auth/pin', () => {
  test('signs a staff member in on a registered device', async () => {
    freshClock();
    const device = await h.newDevice();
    const staff = await h.newStaff('cashier', '4821');
    const res = await pin(device.token, { staffId: staff.id, pin: staff.pin });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = sessionResponseSchema.parse(res.json());
    expect(body.staff).toMatchObject({ id: staff.id, role: 'cashier' });
    expect(body.permissions).toContain('payment.confirm');
    expect(body.permissions).not.toContain('payment.void_refund');
    expect(body.idleTimeoutSeconds).toBe(2 * 60 * 60);
    expect(new Date(body.expiresAt).getTime()).toBe(h.clock.now().getTime() + 12 * 3600 * 1000);

    // The session works with the device it was opened on (and, see device-binding.test.ts, only then).
    const who = await h.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { ...bearer(body.sessionToken), 'x-device-token': device.token },
    });
    expect(who.json()).toMatchObject({ deviceId: device.id, staff: { id: staff.id } });
  });

  test('wrong PIN, unknown staff, inactive staff and staff without a PIN all get the same answer', async () => {
    freshClock();
    const device = await h.newDevice();
    const staff = await h.newStaff('cashier', '4821');
    const inactive = await h.newStaff('cashier', '4821');
    await h.client.query('update staff set active = false where id = $1', [inactive.id]);
    const noPin = await h.newStaff('cashier', '4821');
    await h.client.query('update staff set pin_hash = null where id = $1', [noPin.id]);

    const attempts = [
      { staffId: staff.id, pin: '0000' },
      { staffId: crypto.randomUUID(), pin: '4821' },
      { staffId: inactive.id, pin: '4821' },
      { staffId: noPin.id, pin: '4821' },
    ];
    for (const body of attempts) {
      const res = await pin(device.token, body);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(INVALID);
    }
  });

  test('checks the device first: guesses without one never touch the staff counters', async () => {
    freshClock();
    const staff = await h.newStaff('cashier', '4821');
    for (let i = 0; i < 8; i++) {
      const res = await pin(undefined, { staffId: staff.id, pin: '0000' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'DEVICE_UNREGISTERED' });
    }
    const revoked = await h.newDevice();
    await h.revokeDevice(revoked.id);
    expect((await pin(revoked.token, { staffId: staff.id, pin: '0000' })).statusCode).toBe(401);

    const row = await rowOf('select failed_pin_count, locked_until from staff where id = $1', [
      staff.id,
    ]);
    expect(row).toMatchObject({ failed_pin_count: 0, locked_until: null });
    const device = await h.newDevice();
    expect((await pin(device.token, { staffId: staff.id, pin: '4821' })).statusCode).toBe(200);
  });

  test('refuses the print agent device', async () => {
    freshClock();
    const agent = await h.newDevice('print_agent');
    const staff = await h.newStaff('cashier', '4821');
    const res = await pin(agent.token, { staffId: staff.id, pin: '4821' });
    expect(res.statusCode).toBe(403);
  });

  test('rejects a malformed PIN without echoing it', async () => {
    freshClock();
    const device = await h.newDevice();
    const staff = await h.newStaff('cashier', '4821');
    const res = await pin(device.token, { staffId: staff.id, pin: '12ab' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(res.body).not.toContain('12ab');
  });

  describe('lockout: five wrong tries, then five minutes', () => {
    test('locks on the fifth, audits it, alerts the owner, and refuses the right PIN while locked', async () => {
      freshClock();
      const device = await h.newDevice();
      const staff = await h.newStaff('cashier', '4821');
      for (let i = 1; i <= 4; i++) {
        expect((await pin(device.token, { staffId: staff.id, pin: '0000' })).statusCode).toBe(401);
      }
      const fifth = await pin(device.token, { staffId: staff.id, pin: '0000' });
      expect(fifth.statusCode).toBe(423);
      expect(fifth.json()).toMatchObject({
        code: 'ACCOUNT_LOCKED',
        details: { retryAfterSeconds: 300 },
      });

      const audit = await h.auditRows(staff.id);
      expect(audit.map((a) => a.action)).toEqual(['auth.pin_locked']);
      expect(audit[0]?.deviceId).toBe(device.id);
      expect(h.events).toContainEqual(
        expect.objectContaining({
          kind: 'staff.pin_locked',
          staffId: staff.id,
          deviceId: device.id,
        }),
      );

      h.clock.advanceSeconds(299);
      const early = await pin(device.token, { staffId: staff.id, pin: '4821' });
      expect(early.statusCode).toBe(423);
      expect(early.json()).toMatchObject({ details: { retryAfterSeconds: 1 } });
    });

    test('the lock ends after five minutes and the count starts over', async () => {
      freshClock();
      const device = await h.newDevice();
      const staff = await h.newStaff('cashier', '4821');
      for (let i = 0; i < 5; i++) await pin(device.token, { staffId: staff.id, pin: '0000' });
      h.clock.advanceSeconds(300);
      // One wrong try after the lock counts as the first, not the sixth.
      expect((await pin(device.token, { staffId: staff.id, pin: '0000' })).statusCode).toBe(401);
      expect((await pin(device.token, { staffId: staff.id, pin: '4821' })).statusCode).toBe(200);
      const row = await rowOf('select failed_pin_count, locked_until from staff where id = $1', [
        staff.id,
      ]);
      expect(row).toMatchObject({ failed_pin_count: 0, locked_until: null });
    });

    test('a correct PIN resets the count', async () => {
      freshClock();
      const device = await h.newDevice();
      const staff = await h.newStaff('cashier', '4821');
      for (let i = 0; i < 4; i++) await pin(device.token, { staffId: staff.id, pin: '0000' });
      expect((await pin(device.token, { staffId: staff.id, pin: '4821' })).statusCode).toBe(200);
      for (let i = 0; i < 4; i++) {
        expect((await pin(device.token, { staffId: staff.id, pin: '0000' })).statusCode).toBe(401);
      }
    });

    test('parallel guesses are counted one at a time: six at once means four refused, then locked', async () => {
      freshClock();
      const device = await h.newDevice();
      const staff = await h.newStaff('cashier', '4821');
      const results = await Promise.all(
        Array.from({ length: 6 }, () => pin(device.token, { staffId: staff.id, pin: '0000' })),
      );
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([401, 401, 401, 401, 423, 423]);
    });

    test('locking one person does not lock another', async () => {
      freshClock();
      const device = await h.newDevice();
      const a = await h.newStaff('cashier', '4821');
      const b = await h.newStaff('cashier', '4821');
      for (let i = 0; i < 5; i++) await pin(device.token, { staffId: a.id, pin: '0000' });
      expect((await pin(device.token, { staffId: b.id, pin: '4821' })).statusCode).toBe(200);
    });
  });
});

describe('sessions', () => {
  async function signedIn() {
    freshClock();
    const device = await h.newDevice();
    const staff = await h.newStaff('cashier', '4821');
    const token = await h.pinSession(device.token, staff.id, staff.pin);
    return { device, staff, token };
  }

  test('reject a missing, malformed or foreign credential', async () => {
    const { device } = await signedIn();
    for (const headers of [
      {},
      { authorization: 'Bearer' },
      { authorization: 'Bearer garbage' },
      { authorization: 'Basic c2VjcmV0OnNlY3JldA==' },
      // A device token is not a session.
      { authorization: `Bearer ${device.token}` },
      { authorization: 'Bearer sds_ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    ]) {
      const res = await h.app.inject({ method: 'GET', url: '/v1/auth/me', headers });
      expect(res.statusCode, JSON.stringify(headers)).toBe(401);
      expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  test('end after the absolute lifetime of 12 hours, even when used all along', async () => {
    const { token } = await signedIn();
    for (let i = 0; i < 11; i++) {
      h.clock.advanceSeconds(3600);
      expect((await me(token)).statusCode).toBe(200);
    }
    h.clock.advanceSeconds(3600 - 1);
    expect((await me(token)).statusCode).toBe(200);
    h.clock.advanceSeconds(2);
    expect((await me(token)).statusCode).toBe(401);
  });

  test('end after the idle timeout of 2 hours, and activity postpones it', async () => {
    const { token } = await signedIn();
    h.clock.advanceSeconds(2 * 3600 - 60);
    expect((await me(token)).statusCode).toBe(200);
    h.clock.advanceSeconds(2 * 3600 - 60);
    expect((await me(token)).statusCode).toBe(200);
    h.clock.advanceSeconds(2 * 3600 + 1);
    expect((await me(token)).statusCode).toBe(401);
  });

  test('logout ends the session at once', async () => {
    const { token } = await signedIn();
    const out = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: bearer(token),
    });
    expect(out.statusCode).toBe(204);
    expect((await me(token)).statusCode).toBe(401);
  });

  test('stop working the moment the device is revoked or the staff member is deactivated', async () => {
    const a = await signedIn();
    await h.revokeDevice(a.device.id);
    expect((await me(a.token)).statusCode).toBe(401);

    const b = await signedIn();
    await h.client.query('update staff set active = false where id = $1', [b.staff.id]);
    expect((await me(b.token)).statusCode).toBe(401);
  });

  test('follow a role change immediately', async () => {
    const { staff, token } = await signedIn();
    expect(((await me(token)).json() as { permissions: string[] }).permissions).not.toContain(
      'menu.edit',
    );
    await h.client.query("update staff set role = 'manager' where id = $1", [staff.id]);
    const after = (await me(token)).json() as { staff: { role: string }; permissions: string[] };
    expect(after.staff.role).toBe('manager');
    expect(after.permissions).toContain('menu.edit');
  });

  test('refresh the device last-seen time at most every five minutes', async () => {
    freshClock();
    const device = await h.newDevice();
    const staff = await h.newStaff('cashier', '4821');
    const version = async () =>
      (await rowOf('select version from devices where id = $1', [device.id]))?.version as number;

    const token = await h.pinSession(device.token, staff.id, staff.pin);
    const first = await version();
    h.clock.advanceSeconds(120);
    await me(token);
    await me(token);
    expect(await version()).toBe(first);
    h.clock.advanceSeconds(240);
    await me(token);
    expect(await version()).toBe(first + 1);
  });
});
