import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as auth from './auth.ts';
import * as people from './people.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';

let db: PgliteDb;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
}, 60_000);
afterAll(async () => {
  await client.close();
});

const unique = () => crypto.randomUUID();
const at = new Date('2026-10-01T04:00:00Z');

describe('devices', () => {
  test('are listed without their token hash, and revoking stamps the time', async () => {
    const tokenHash = unique();
    const device = await auth.insertDevice(db, { name: 'Zzz iPad', kind: 'ipad', tokenHash });
    const listed = (await people.listDevices(db)).find((d) => d.id === device.id);
    expect(listed).toEqual({
      id: device.id,
      name: 'Zzz iPad',
      kind: 'ipad',
      lastSeenAt: null,
      revokedAt: null,
      version: 1,
    });
    expect(JSON.stringify(listed)).not.toContain(tokenHash);

    expect((await people.lockDevice(db, device.id))?.revokedAt).toBeNull();
    const revoked = await people.revokeDevice(db, device.id, at);
    expect(revoked).toMatchObject({ revokedAt: at, version: 2 });
    expect(await people.lockDevice(db, unique())).toBeUndefined();
  });

  test('revokeSessionsForDevice ends the sessions opened on that device only', async () => {
    const a = await auth.insertDevice(db, { name: 'a', kind: 'ipad', tokenHash: unique() });
    const b = await auth.insertDevice(db, { name: 'b', kind: 'ipad', tokenHash: unique() });
    const owner = await auth.insertOwner(db, {
      email: `${unique()}@example.test`,
      displayName: 'o',
      passwordHash: 'x',
      pinHash: null,
      encryptTotpSecret: () => 'enc',
      recoveryCodeHashes: [],
    });
    const open = async (deviceId: string) => {
      const tokenHash = unique();
      await auth.insertSession(db, {
        tokenHash,
        staffId: owner.staffId,
        deviceId,
        kind: 'pin',
        expiresAt: new Date('2026-10-02T00:00:00Z'),
        lastSeenAt: at,
      });
      return tokenHash;
    };
    const onA = await open(a.id);
    const onB = await open(b.id);
    await people.revokeSessionsForDevice(db, a.id, at);
    expect((await auth.findSessionByTokenHash(db, onA))?.revokedAt).toEqual(at);
    expect((await auth.findSessionByTokenHash(db, onB))?.revokedAt).toBeNull();
  });
});

describe('staff', () => {
  test('a new member is listed with hasPin and no hash; the PIN hash is never returned', async () => {
    const row = await people.insertStaff(db, {
      displayName: 'น้อย',
      role: 'cashier',
      pinHash: 'secret-hash',
    });
    expect(row).toEqual({
      id: row.id,
      displayName: 'น้อย',
      role: 'cashier',
      active: true,
      hasPin: true,
      lockedUntil: null,
      version: 1,
    });
    const listed = await people.listStaff(db);
    expect(listed.find((s) => s.id === row.id)).toEqual(row);
    expect(JSON.stringify(listed)).not.toContain('secret-hash');
    expect(await people.findStaff(db, row.id)).toEqual(row);
    expect(await people.findStaff(db, unique())).toBeUndefined();
  });

  test('updateStaffIfVersion changes the row only for the version the caller saw', async () => {
    const row = await people.insertStaff(db, { displayName: 'ก', role: 'kitchen', pinHash: 'h' });
    const updated = await people.updateStaffIfVersion(db, row.id, 1, {
      displayName: 'ข',
      active: false,
    });
    expect(updated).toMatchObject({ displayName: 'ข', active: false, version: 2 });
    expect(await people.updateStaffIfVersion(db, row.id, 1, { displayName: 'ค' })).toBeUndefined();
    expect((await people.findStaff(db, row.id))?.displayName).toBe('ข');
  });

  test('lockStaff returns the member, or nothing', async () => {
    const row = await people.insertStaff(db, { displayName: 'ล็อก', role: 'cashier', pinHash: 'h' });
    expect((await people.lockStaff(db, row.id))?.id).toBe(row.id);
    expect(await people.lockStaff(db, unique())).toBeUndefined();
  });
});
