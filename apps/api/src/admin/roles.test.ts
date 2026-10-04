/**
 * D-23: role changes, and owners renaming or deactivating other owners. Nobody changes
 * themselves, and the last active owner always stays.
 */
import { authRepo } from '@sds/db';
import { listStaffResponseSchema, type StaffDto, staffDtoSchema } from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { encryptSecret, hashPassword, hashPin, hashRecoveryCode } from '../auth/crypto.ts';
import { DEFAULT_AUTH_POLICY } from '../auth/policy.ts';
import type { AuthContext, Principal } from '../auth/service.ts';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';
import { changeStaffRole, patchStaffMember } from './service.ts';

let h: Harness;
let owner: OwnerFixture;
let device: { id: string; token: string };
beforeAll(async () => {
  h = await createHarness();
  owner = await h.newOwner({ pin: '246810' });
  device = await h.newDevice();
}, 60_000);
afterAll(async () => {
  await h.close();
});

/** A fresh session of `who` that has stepped up. Moves the clock so the TOTP codes are new. */
async function adminOf(who: OwnerFixture = owner) {
  h.clock.advanceSeconds(90);
  return h.steppedUpOwner(who);
}

function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  token: string | undefined,
  body?: unknown,
) {
  return h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    remoteAddress: h.nextIp(),
  });
}

async function staffRow(token: string, id: string): Promise<StaffDto> {
  const list = listStaffResponseSchema.parse((await call('GET', '/v1/staff', token)).json());
  const row = list.staff.find((s) => s.id === id);
  if (!row) throw new Error('staff member not listed');
  return row;
}

async function createStaff(token: string, role: 'manager' | 'cashier' | 'kitchen', pin: string) {
  const res = await call('POST', '/v1/staff', token, { displayName: `${role} x`, role, pin });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode}`);
  return staffDtoSchema.parse(res.json());
}

const changeRole = (token: string, id: string, body: Record<string, unknown>) =>
  call('POST', `/v1/staff/${id}/role`, token, body);

const pinSignIn = (staffId: string, pin: string) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/auth/pin',
    headers: { 'x-device-token': device.token },
    payload: { staffId, pin },
    remoteAddress: h.nextIp(),
  });

/** A manager-or-other who signs in by e-mail too, as an accepted invite makes them. */
async function credentialedStaff(role: 'owner' | 'manager' | 'cashier' | 'kitchen', pin: string) {
  const { staffId } = await authRepo.insertCredentialedStaff(h.db, {
    email: `${role}-${crypto.randomUUID().slice(0, 8)}@example.test`,
    displayName: `${role} invited`,
    role,
    passwordHash: await hashPassword('does-not-matter-here'),
    pinHash: await hashPin(pin, h.keys),
    encryptTotpSecret: (id) => encryptSecret(Buffer.alloc(20, 1), h.keys.totpKey, id),
    recoveryCodeHashes: [hashRecoveryCode('AAAA-BBBB-CCCC-DDDD')],
    totpLastStep: 1,
  });
  return staffId;
}

describe('POST /v1/staff/:id/role', () => {
  test('promoting a cashier to manager needs a 6-digit PIN; then it ends sessions and is audited', async () => {
    const token = await adminOf();
    const person = await createStaff(token, 'cashier', '4821');
    const session = await h.pinSession(device.token, person.id, '4821');
    const events = h.events.length;

    // Missing PIN, and a PIN that is too short for the NEW role: 400 on `pin`, nothing changed.
    for (const body of [
      { expectedVersion: person.version, role: 'manager' },
      { expectedVersion: person.version, role: 'manager', pin: '4821' },
    ]) {
      const res = await changeRole(token, person.id, body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect((await staffRow(token, person.id)).role).toBe('cashier');

    const res = await changeRole(token, person.id, {
      expectedVersion: person.version,
      role: 'manager',
      pin: '135790',
    });
    expect(res.statusCode).toBe(200);
    const changed = staffDtoSchema.parse(res.json());
    expect(changed).toMatchObject({ role: 'manager', hasPin: true });
    expect(changed.version).toBeGreaterThan(person.version);

    // The old PIN and the open session are dead; the new PIN works.
    expect((await h.probe(session)).statusCode).toBe(401);
    expect((await pinSignIn(person.id, '4821')).statusCode).toBe(401);
    expect((await pinSignIn(person.id, '135790')).statusCode).toBe(200);

    const audit = (await h.auditRows(person.id)).find((a) => a.action === 'staff.role_change');
    expect(audit).toMatchObject({
      actorType: 'staff',
      actorId: owner.staffId,
      entity: 'staff',
      before: { role: 'cashier' },
      after: { role: 'manager', pinSet: true },
    });
    expect(JSON.stringify(audit)).not.toContain('135790');
    const alert = h.alerts.find((a) => a.kind === 'staff.role_changed' && a.staffId === person.id);
    expect(alert).toMatchObject({ severity: 'warn' });
    expect(h.events.slice(events)).toContainEqual({
      type: 'session.ended',
      staffId: person.id,
      reason: 'role_changed',
    });
    expect(h.logs()).not.toContain('135790');
  }, 30_000);

  test('a role with the same or a shorter PIN needs none, and the old PIN keeps working', async () => {
    const token = await adminOf();
    const manager = await createStaff(token, 'manager', '246813');
    const down = await changeRole(token, manager.id, {
      expectedVersion: manager.version,
      role: 'cashier',
    });
    expect(down.statusCode).toBe(200);
    expect(down.json()).toMatchObject({ role: 'cashier' });
    expect((await pinSignIn(manager.id, '246813')).statusCode).toBe(200);

    const cashier = await createStaff(token, 'cashier', '4821');
    const sideways = await changeRole(token, cashier.id, {
      expectedVersion: cashier.version,
      role: 'kitchen',
    });
    expect(sideways.statusCode).toBe(200);
    expect((await pinSignIn(cashier.id, '4821')).statusCode).toBe(200);
    expect(
      (await h.auditRows(cashier.id)).find((a) => a.action === 'staff.role_change')?.after,
    ).toEqual({ role: 'kitchen', pinSet: false });
  }, 30_000);

  test('the same role again changes nothing and writes nothing', async () => {
    const token = await adminOf();
    const person = await createStaff(token, 'kitchen', '4821');
    const res = await changeRole(token, person.id, {
      expectedVersion: person.version,
      role: 'kitchen',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: person.version });
    expect((await h.auditRows(person.id)).some((a) => a.action === 'staff.role_change')).toBe(
      false,
    );
  });

  test('needs the version the client saw: stale is 409; missing, unknown role and extra fields are 400', async () => {
    const token = await adminOf();
    const person = await createStaff(token, 'cashier', '4821');
    const stale = await changeRole(token, person.id, {
      expectedVersion: person.version + 5,
      role: 'kitchen',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: person.version },
    });
    for (const body of [
      { role: 'kitchen' },
      { expectedVersion: person.version, role: 'boss' },
      { expectedVersion: person.version, role: 'kitchen', active: false },
    ]) {
      expect((await changeRole(token, person.id, body)).statusCode).toBe(400);
    }
    expect(
      (
        await changeRole(token, '0192f3a0-0000-7000-8000-000000000001', {
          expectedVersion: 1,
          role: 'kitchen',
        })
      ).statusCode,
    ).toBe(404);
  });

  test('nobody changes their own role', async () => {
    const token = await adminOf();
    const me = await staffRow(token, owner.staffId);
    const res = await changeRole(token, owner.staffId, {
      expectedVersion: me.version,
      role: 'manager',
      pin: '246810',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'SELF_CHANGE' });
    expect((await staffRow(token, owner.staffId)).role).toBe('owner');
  });

  test('an owner without a PIN needs one to become a manager (they would have no step-up factor)', async () => {
    const first = await adminOf();
    const noPin = await h.newOwner(); // the first owner by owner:create may have no PIN
    const me = await staffRow(first, noPin.staffId);
    const res = await changeRole(first, noPin.staffId, {
      expectedVersion: me.version,
      role: 'manager',
    });
    expect(res.statusCode).toBe(400);
    const ok = await changeRole(first, noPin.staffId, {
      expectedVersion: me.version,
      role: 'manager',
      pin: '123789',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ role: 'manager', hasPin: true });
  }, 30_000);

  test('only someone with an e-mail account can become an owner', async () => {
    const token = await adminOf();
    const pinOnly = await createStaff(token, 'manager', '246813');
    const refused = await changeRole(token, pinOnly.id, {
      expectedVersion: pinOnly.version,
      role: 'owner',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'OWNER_NEEDS_ACCOUNT' });

    const invitedId = await credentialedStaff('manager', '246813');
    const invited = await staffRow(token, invitedId);
    expect(invited.email).toMatch(/@example\.test$/);
    const ok = await changeRole(token, invitedId, {
      expectedVersion: invited.version,
      role: 'owner',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ role: 'owner', email: invited.email });
  }, 30_000);

  test('a co-owner can demote the first owner; the demoted person loses owner rights at once', async () => {
    const co = await h.newOwner({ pin: '864209' });
    const first = await h.newOwner({ pin: '753197' });
    const firstSession = await h.ownerSession(first);
    const coToken = await adminOf(co);
    const row = await staffRow(coToken, first.staffId);
    const res = await changeRole(coToken, first.staffId, {
      expectedVersion: row.version,
      role: 'manager',
    });
    expect(res.statusCode).toBe(200);
    expect((await h.probe(firstSession)).statusCode).toBe(401);
  }, 30_000);

  test('a manager or cashier cannot change roles', async () => {
    const token = await adminOf();
    const target = await createStaff(token, 'kitchen', '4821');
    const manager = await h.newStaff('manager', '246813');
    const session = await h.pinSession(device.token, manager.id, '246813');
    await call('POST', '/v1/auth/step-up', session, { pin: '246813' });
    const res = await changeRole(session, target.id, {
      expectedVersion: target.version,
      role: 'cashier',
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /v1/staff/:id/pin on an owner', () => {
  const setPin = (token: string, id: string, pin: string) =>
    call('POST', `/v1/staff/${id}/pin`, token, { pin });

  test('an owner cannot set another owner PIN (it would let them sign in as that owner); their own is fine', async () => {
    const co = await h.newOwner({ pin: '864209' });
    const token = await adminOf();
    const refused = await setPin(token, co.staffId, '111222');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'OWNER_PROTECTED' });
    expect((await pinSignIn(co.staffId, '111222')).statusCode).toBe(401);

    const own = await setPin(token, owner.staffId, '246810');
    expect(own.statusCode).toBe(200);
  }, 30_000);

  test('a manager target still gets the PIN, and the length is judged against the locked row', async () => {
    const token = await adminOf();
    const manager = await createStaff(token, 'manager', '246813');
    expect((await setPin(token, manager.id, '1234')).statusCode).toBe(400);
    expect((await setPin(token, manager.id, '135790')).statusCode).toBe(200);
  }, 30_000);
});

describe('PATCH /v1/staff/:id on an owner', () => {
  test('another owner can rename and deactivate an owner; their sessions end and they cannot sign in', async () => {
    const co = await h.newOwner({ pin: '864209' });
    const other = await h.newOwner({ pin: '753197' });
    const otherSession = await h.ownerSession(other);
    const coToken = await adminOf(co);
    const row = await staffRow(coToken, other.staffId);

    const renamed = await call('PATCH', `/v1/staff/${other.staffId}`, coToken, {
      expectedVersion: row.version,
      displayName: 'Renamed Owner',
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ displayName: 'Renamed Owner', role: 'owner' });
    expect((await h.probe(otherSession)).statusCode).toBe(200); // a rename does not end sessions

    const gone = await call('PATCH', `/v1/staff/${other.staffId}`, coToken, {
      expectedVersion: (renamed.json() as StaffDto).version,
      active: false,
    });
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toMatchObject({ active: false });
    expect((await h.probe(otherSession)).statusCode).toBe(401);
    h.clock.advanceSeconds(60);
    const login = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/owner',
      payload: { email: other.email, password: other.password, totp: other.totp() },
      remoteAddress: h.nextIp(),
    });
    expect(login.statusCode).toBe(401);
    expect(
      h.alerts.some((a) => a.kind === 'staff.deactivated' && a.staffId === other.staffId),
    ).toBe(true);
  }, 30_000);
});

describe('the last active owner', () => {
  function context(): AuthContext {
    return {
      db: h.db,
      keys: h.keys,
      policy: DEFAULT_AUTH_POLICY,
      now: h.clock.now,
      events: h.bus,
    };
  }
  const principalFor = (staffId: string): Principal => ({
    sessionId: crypto.randomUUID(),
    staffId,
    displayName: 'stale owner',
    role: 'owner',
    kind: 'owner',
    deviceId: null,
    expiresAt: new Date(h.clock.now().getTime() + 3_600_000),
    stepUpUntil: new Date(h.clock.now().getTime() + 3_600_000),
  });

  // The route guard hands the service a principal read at the start of the request. If the actor
  // lost the owner role a moment before the transaction (two owners acting on each other at once),
  // the transaction itself must still refuse: it locks the owners and counts them.
  test('cannot lose the owner role or be deactivated, even when the actor is a stale owner', async () => {
    const lone = await createHarness();
    try {
      const a = await lone.newOwner({ pin: '864209' });
      const b = await lone.newOwner({ pin: '753197' });
      await lone.client.query("update staff set role = 'manager' where id = $1", [a.staffId]);
      const ctx = {
        ...context(),
        db: lone.db,
        keys: lone.keys,
        now: lone.clock.now,
        events: lone.bus,
      };
      const [row] = (
        await lone.client.query<{ version: number }>('select version from staff where id = $1', [
          b.staffId,
        ])
      ).rows;
      const version = row?.version ?? 0;

      await expect(
        changeStaffRole(
          ctx,
          principalFor(a.staffId),
          b.staffId,
          { expectedVersion: version, role: 'cashier', pin: '4821' },
          { ip: null },
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: 'LAST_OWNER' });
      await expect(
        patchStaffMember(
          ctx,
          principalFor(a.staffId),
          b.staffId,
          { expectedVersion: version, active: false },
          { ip: null },
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: 'LAST_OWNER' });
      // Renaming the last owner is not a loss of the role: it is then only the actor check that stops it.
      await expect(
        patchStaffMember(
          ctx,
          principalFor(a.staffId),
          b.staffId,
          { expectedVersion: version, displayName: 'x' },
          { ip: null },
        ),
      ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

      const [still] = (
        await lone.client.query<{ role: string; active: boolean }>(
          'select role, active from staff where id = $1',
          [b.staffId],
        )
      ).rows;
      expect(still).toEqual({ role: 'owner', active: true });
    } finally {
      await lone.close();
    }
  }, 60_000);

  test('a stale actor who is not an owner any more is refused even when other owners remain', async () => {
    const trio = await createHarness();
    try {
      const a = await trio.newOwner({ pin: '864209' });
      const b = await trio.newOwner({ pin: '753197' });
      await trio.newOwner({ pin: '642086' });
      await trio.client.query("update staff set role = 'manager' where id = $1", [a.staffId]);
      const ctx = {
        ...context(),
        db: trio.db,
        keys: trio.keys,
        now: trio.clock.now,
        events: trio.bus,
      };
      const [row] = (
        await trio.client.query<{ version: number }>('select version from staff where id = $1', [
          b.staffId,
        ])
      ).rows;
      await expect(
        changeStaffRole(
          ctx,
          principalFor(a.staffId),
          b.staffId,
          { expectedVersion: row?.version ?? 0, role: 'manager' },
          { ip: null },
        ),
      ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    } finally {
      await trio.close();
    }
  }, 60_000);
});
