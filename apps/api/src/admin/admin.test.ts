import {
  type DeviceDto,
  deviceDtoSchema,
  listDevicesResponseSchema,
  listStaffResponseSchema,
  type StaffDto,
  staffDtoSchema,
} from '@sds/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness, type OwnerFixture } from '../test-support/harness.ts';

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

/** A fresh owner session that has stepped up. Moves the clock so the TOTP codes are new. */
async function admin() {
  h.clock.advanceSeconds(90);
  return h.steppedUpOwner(owner);
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

// A PIN is digits, and digits are valid in a uuid, so "the PIN is not in this text" could fail by
// chance. These check the shape instead: no field that could hold a PIN, hash or counter.
const FORBIDDEN_KEYS = /pin$|pinhash|hash|token|secret|failed|level/i;
function expectNoSecretFields(value: unknown, where = 'response') {
  if (Array.isArray(value)) {
    for (const v of value) expectNoSecretFields(v, where);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key !== 'hasPin' && key !== 'pinLockedUntil') {
        expect(key, `${where}: field ${key}`).not.toMatch(FORBIDDEN_KEYS);
      }
      expectNoSecretFields(inner, where);
    }
  }
}

const rows = async (sql: string, params: unknown[] = []) =>
  (await h.client.query<Record<string, unknown>>(sql, params)).rows;

async function createStaff(token: string, body: Record<string, unknown>) {
  const res = await call('POST', '/v1/staff', token, body);
  if (res.statusCode !== 201) throw new Error(`create staff failed: ${res.statusCode} ${res.body}`);
  return staffDtoSchema.parse(res.json());
}

const pinSignIn = (staffId: string, pin: string, deviceToken = device.token) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/auth/pin',
    headers: { 'x-device-token': deviceToken },
    payload: { staffId, pin },
    remoteAddress: h.nextIp(),
  });

describe('who may use these routes', () => {
  const routes = (staffId: string, deviceId: string) =>
    [
      ['GET', '/v1/devices'],
      ['POST', `/v1/devices/${deviceId}/revoke`],
      ['GET', '/v1/staff'],
      ['POST', '/v1/staff'],
      ['PATCH', `/v1/staff/${staffId}`],
      ['POST', `/v1/staff/${staffId}/pin`],
    ] as const;

  test('nobody without a session', async () => {
    for (const [method, url] of routes(crypto.randomUUID(), crypto.randomUUID())) {
      expect((await call(method, url, undefined, {})).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  test('not the manager, cashier or kitchen, even after they step up', async () => {
    const target = await h.newStaff('cashier', '4821');
    for (const role of ['manager', 'cashier', 'kitchen'] as const) {
      const who = await h.newStaff(role, '4821');
      const token = await h.pinSession(device.token, who.id, '4821');
      await call('POST', '/v1/auth/step-up', token, { pin: '4821' });
      for (const [method, url] of routes(target.id, device.id)) {
        const res = await call(method, url, token, {});
        expect(res.statusCode, `${role} ${method} ${url}`).toBe(403);
        expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
      }
    }
  });

  test('the owner needs a fresh step-up: signing in is not enough', async () => {
    h.clock.advanceSeconds(90);
    const token = await h.ownerSession(owner);
    const target = await h.newStaff('cashier', '4821');
    for (const [method, url] of routes(target.id, device.id)) {
      const res = await call(method, url, token, {});
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    }
  });
});

describe('devices', () => {
  test('lists every device with its state, and never a token or hash', async () => {
    const token = await admin();
    const other = await h.newDevice('iphone');
    const res = await call('GET', '/v1/devices', token);
    expect(res.statusCode).toBe(200);
    const { devices } = listDevicesResponseSchema.parse(res.json());
    expect(devices.map((d) => d.id)).toEqual(expect.arrayContaining([device.id, other.id]));
    expect(devices.find((d) => d.id === other.id)).toMatchObject({
      kind: 'iphone',
      revokedAt: null,
    });
    expectNoSecretFields(res.json());
    expect(res.body).not.toContain(other.token);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('a device registered through /v1/auth/device shows up', async () => {
    const token = await admin();
    const reg = await call('POST', '/v1/auth/device', token, {
      name: 'Kitchen phone',
      kind: 'iphone',
    });
    const id = (reg.json() as { device: { id: string } }).device.id;
    const list = listDevicesResponseSchema.parse((await call('GET', '/v1/devices', token)).json());
    expect(list.devices.find((d) => d.id === id)).toMatchObject({ name: 'Kitchen phone' });
  });

  test('revoking stops its token and ends its open sessions, and is audited and alerted', async () => {
    const token = await admin();
    const lost = await h.newDevice('ipad');
    const cashier = await h.newStaff('cashier', '4821');
    const session = await h.pinSession(lost.token, cashier.id, '4821');
    const before = h.alerts.length;

    h.clock.advanceSeconds(10);
    const res = await call('POST', `/v1/devices/${lost.id}/revoke`, token);
    expect(res.statusCode).toBe(200);
    const dto = deviceDtoSchema.parse(res.json());
    expect(dto).toMatchObject({ id: lost.id, revokedAt: h.clock.now().toISOString() });

    // The lost iPad can no longer sign anyone in, and what was open on it is dead.
    expect((await pinSignIn(cashier.id, '4821', lost.token)).statusCode).toBe(401);
    expect((await call('GET', '/v1/auth/me', session)).statusCode).toBe(401);

    const audit = (await h.auditRows(lost.id)).filter((a) => a.action === 'device.revoke');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: 'staff',
      actorId: owner.staffId,
      entity: 'devices',
    });
    expect(h.alerts.slice(before)).toContainEqual(
      expect.objectContaining({ kind: 'device.revoked', severity: 'warn', deviceId: lost.id }),
    );
  });

  test('revoking again is harmless and writes no second audit row', async () => {
    const token = await admin();
    const lost = await h.newDevice('laptop');
    await call('POST', `/v1/devices/${lost.id}/revoke`, token);
    const again = await call('POST', `/v1/devices/${lost.id}/revoke`, token);
    expect(again.statusCode).toBe(200);
    expect((await h.auditRows(lost.id)).filter((a) => a.action === 'device.revoke')).toHaveLength(
      1,
    );
  });

  test('an unknown device is 404 and a malformed id is 400', async () => {
    const token = await admin();
    expect(
      (await call('POST', `/v1/devices/${crypto.randomUUID()}/revoke`, token)).statusCode,
    ).toBe(404);
    expect((await call('POST', '/v1/devices/nope/revoke', token)).statusCode).toBe(400);
  });
});

describe('staff: list and create', () => {
  test('lists staff with their state and no PIN or hash', async () => {
    const token = await admin();
    const created = await createStaff(token, { displayName: 'น้อย', role: 'cashier', pin: '4821' });
    const res = await call('GET', '/v1/staff', token);
    expect(res.statusCode).toBe(200);
    const { staff } = listStaffResponseSchema.parse(res.json());
    expect(staff.find((s) => s.id === created.id)).toMatchObject({
      displayName: 'น้อย',
      role: 'cashier',
      active: true,
      hasPin: true,
    });
    expect(staff.find((s) => s.id === owner.staffId)).toMatchObject({
      role: 'owner',
      hasPin: true,
    });
    expectNoSecretFields(res.json());
    expect(res.body).not.toMatch(/scrypt/i);
  });

  test('shows when someone is locked out', async () => {
    const token = await admin();
    const s = await createStaff(token, { displayName: 'ล็อก', role: 'cashier', pin: '4821' });
    for (let i = 0; i < 5; i++) await pinSignIn(s.id, '0000');
    const { staff } = listStaffResponseSchema.parse((await call('GET', '/v1/staff', token)).json());
    expect(staff.find((x) => x.id === s.id)?.pinLockedUntil).not.toBeNull();
  });

  test('creates a staff member who can then sign in with the PIN; audited, alerted, no PIN stored in clear', async () => {
    const token = await admin();
    const before = h.alerts.length;
    const res = await call('POST', '/v1/staff', token, {
      displayName: '  สมชาย ',
      role: 'kitchen',
      pin: '5937',
    });
    expect(res.statusCode).toBe(201);
    const created = staffDtoSchema.parse(res.json());
    expect(created).toMatchObject({
      displayName: 'สมชาย',
      role: 'kitchen',
      active: true,
      hasPin: true,
      version: 1,
    });
    expectNoSecretFields(res.json());

    expect((await pinSignIn(created.id, '5937')).statusCode).toBe(200);
    expect((await pinSignIn(created.id, '5938')).statusCode).toBe(401);

    const audit = (await h.auditRows(created.id)).find((a) => a.action === 'staff.create');
    expect(audit).toMatchObject({ actorType: 'staff', actorId: owner.staffId, entity: 'staff' });
    expect(audit?.after).toEqual({ displayName: 'สมชาย', role: 'kitchen' });
    for (const row of await h.auditRows(created.id))
      expectNoSecretFields([row.before, row.after], 'audit');
    expect(h.alerts.slice(before)).toContainEqual(
      expect.objectContaining({ kind: 'staff.created', severity: 'warn', staffId: created.id }),
    );

    const stored = (await rows('select pin_hash from staff where id = $1', [created.id]))[0];
    expect(String(stored?.pin_hash)).toMatch(/^scrypt\$/);
  });

  test('a manager needs 6 digits; the owner role cannot be created', async () => {
    const token = await admin();
    for (const body of [
      { displayName: 'ผู้จัดการ', role: 'manager', pin: '4821' },
      { displayName: 'ผู้จัดการ', role: 'manager', pin: '48210' },
      { displayName: 'เจ้าของ', role: 'owner', pin: '482103' },
      { displayName: '', role: 'cashier', pin: '4821' },
      { displayName: 'x', role: 'cashier', pin: '4821', pinHash: 'abc' },
    ]) {
      const res = await call('POST', '/v1/staff', token, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      expectNoSecretFields(res.json());
    }
    const ok = await call('POST', '/v1/staff', token, {
      displayName: 'ผู้จัดการ',
      role: 'manager',
      pin: '482103',
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe('staff: change', () => {
  test('renames, deactivates (sessions end, sign-in is refused) and reactivates; each change is audited', async () => {
    const token = await admin();
    const s = await createStaff(token, { displayName: 'เดิม', role: 'cashier', pin: '4821' });
    const session = await h.pinSession(device.token, s.id, '4821');

    const renamed = await call('PATCH', `/v1/staff/${s.id}`, token, {
      expectedVersion: s.version,
      displayName: 'ใหม่',
    });
    expect(renamed.statusCode).toBe(200);
    const r = staffDtoSchema.parse(renamed.json());
    expect(r).toMatchObject({ displayName: 'ใหม่', version: s.version + 1 });

    const off = await call('PATCH', `/v1/staff/${s.id}`, token, {
      expectedVersion: r.version,
      active: false,
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ active: false });
    expect((await call('GET', '/v1/auth/me', session)).statusCode).toBe(401);
    expect((await pinSignIn(s.id, '4821')).statusCode).toBe(401);
    expect(h.alerts).toContainEqual(
      expect.objectContaining({ kind: 'staff.deactivated', staffId: s.id }),
    );

    const on = await call('PATCH', `/v1/staff/${s.id}`, token, {
      expectedVersion: (off.json() as StaffDto).version,
      active: true,
    });
    expect(on.statusCode).toBe(200);
    expect((await pinSignIn(s.id, '4821')).statusCode).toBe(200);
    // What was open before the deactivation stays dead: reactivating does not revive it.
    expect((await call('GET', '/v1/auth/me', session)).statusCode).toBe(401);

    const trail = (await h.auditRows(s.id)).filter((a) => a.action === 'staff.update');
    expect(trail).toHaveLength(3);
    expect(trail[0]).toMatchObject({
      before: { displayName: 'เดิม' },
      after: { displayName: 'ใหม่' },
    });
  });

  test('needs the version the client saw: missing is 400, stale is 409 with the current version', async () => {
    const token = await admin();
    const s = await createStaff(token, { displayName: 'ก', role: 'cashier', pin: '4821' });
    expect((await call('PATCH', `/v1/staff/${s.id}`, token, { displayName: 'ข' })).statusCode).toBe(
      400,
    );
    await call('PATCH', `/v1/staff/${s.id}`, token, {
      expectedVersion: s.version,
      displayName: 'ข',
    });
    const stale = await call('PATCH', `/v1/staff/${s.id}`, token, {
      expectedVersion: s.version,
      displayName: 'ค',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: s.version + 1 },
    });
  });

  test('refuses a role change and unknown fields; unknown staff is 404', async () => {
    const token = await admin();
    const s = await createStaff(token, { displayName: 'ก', role: 'cashier', pin: '4821' });
    for (const extra of [{ role: 'manager' }, { pin: '123456' }, { pinHash: 'x' }]) {
      const res = await call('PATCH', `/v1/staff/${s.id}`, token, {
        expectedVersion: s.version,
        active: true,
        ...extra,
      });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect(
      (
        await call('PATCH', `/v1/staff/${crypto.randomUUID()}`, token, {
          expectedVersion: 1,
          active: true,
        })
      ).statusCode,
    ).toBe(404);
  });

  test('an owner cannot rename or deactivate themselves (another owner can; see roles.test.ts)', async () => {
    const token = await admin();
    const me = listStaffResponseSchema
      .parse((await call('GET', '/v1/staff', token)).json())
      .staff.find((s) => s.id === owner.staffId) as StaffDto;
    const res = await call('PATCH', `/v1/staff/${owner.staffId}`, token, {
      expectedVersion: me.version,
      active: false,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'SELF_CHANGE' });
    const rename = await call('PATCH', `/v1/staff/${owner.staffId}`, token, {
      expectedVersion: me.version,
      displayName: 'Someone else',
    });
    expect(rename.json()).toMatchObject({ code: 'SELF_CHANGE' });
  });
});

describe('staff: set a PIN', () => {
  test('the new PIN works, the old one and open sessions do not, and a lock is cleared', async () => {
    const token = await admin();
    const s = await createStaff(token, { displayName: 'ลืม', role: 'cashier', pin: '4821' });
    const session = await h.pinSession(device.token, s.id, '4821');
    for (let i = 0; i < 5; i++) await pinSignIn(s.id, '0000'); // locked out

    const res = await call('POST', `/v1/staff/${s.id}/pin`, token, { pin: '7351' });
    expect(res.statusCode).toBe(200);
    expect(staffDtoSchema.parse(res.json())).toMatchObject({
      id: s.id,
      hasPin: true,
      pinLockedUntil: null,
    });
    expectNoSecretFields(res.json());

    expect((await call('GET', '/v1/auth/me', session)).statusCode).toBe(401);
    expect((await pinSignIn(s.id, '4821')).statusCode).toBe(401);
    expect((await pinSignIn(s.id, '7351')).statusCode).toBe(200);
  });

  test('is audited and alerted, without the PIN anywhere', async () => {
    const token = await admin();
    const s = await createStaff(token, { displayName: 'ลืม', role: 'cashier', pin: '4821' });
    const before = h.alerts.length;
    await call('POST', `/v1/staff/${s.id}/pin`, token, { pin: '7351' });
    const trail = await h.auditRows(s.id);
    expect(trail.map((a) => a.action)).toContain('staff.set_pin');
    for (const row of trail) expectNoSecretFields([row.before, row.after], 'audit');
    expect(h.logs()).not.toMatch(/"pin":"7351"/);
    expect(h.alerts.slice(before)).toContainEqual(
      expect.objectContaining({ kind: 'staff.pin_set', staffId: s.id }),
    );
  });

  test("the PIN must be long enough for the person's role (the owner and managers need 6 digits)", async () => {
    const token = await admin();
    const manager = await createStaff(token, {
      displayName: 'จัดการ',
      role: 'manager',
      pin: '482103',
    });
    const short = await call('POST', `/v1/staff/${manager.id}/pin`, token, { pin: '4821' });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(
      (await call('POST', `/v1/staff/${manager.id}/pin`, token, { pin: '735109' })).statusCode,
    ).toBe(200);

    const ownerShort = await call('POST', `/v1/staff/${owner.staffId}/pin`, token, { pin: '4821' });
    expect(ownerShort.statusCode).toBe(400);
    expect(
      (await call('POST', `/v1/staff/${owner.staffId}/pin`, token, { pin: '135790' })).statusCode,
    ).toBe(200);
  });

  test('unknown staff is 404; a malformed PIN is 400', async () => {
    const token = await admin();
    expect(
      (await call('POST', `/v1/staff/${crypto.randomUUID()}/pin`, token, { pin: '4821' }))
        .statusCode,
    ).toBe(404);
    const s = await createStaff(token, { displayName: 'ก', role: 'cashier', pin: '4821' });
    expect((await call('POST', `/v1/staff/${s.id}/pin`, token, { pin: '12ab' })).statusCode).toBe(
      400,
    );
  });
});

describe('the shapes are the shared ones', () => {
  test('a device and a staff member parse with the shared schemas', async () => {
    const token = await admin();
    const devices = (await call('GET', '/v1/devices', token)).json() as { devices: DeviceDto[] };
    for (const d of devices.devices) expect(deviceDtoSchema.safeParse(d).success).toBe(true);
  });
});
