import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { insertAudit } from './audit.ts';
import * as auth from './auth.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import { auditLog, staff } from './schema.ts';

let db: PgliteDb;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
}, 60_000);

afterAll(async () => {
  await client.close();
});

const unique = () => crypto.randomUUID();

async function newOwner(overrides: Partial<auth.NewOwner> = {}) {
  const email = `${unique()}@example.test`;
  const { staffId } = await auth.insertOwner(db, {
    email,
    displayName: 'Owner',
    passwordHash: 'pw-hash',
    pinHash: null,
    encryptTotpSecret: (id) => `enc-for-${id}`,
    recoveryCodeHashes: ['h1', 'h2', 'h3'],
    ...overrides,
  });
  return { email, staffId };
}

describe('owner credentials', () => {
  test('insertOwner stores the staff row and credentials, and the secret is bound to the staff id', async () => {
    const { email, staffId } = await newOwner();
    expect(await auth.ownerExists(db)).toBe(true);
    const row = await auth.lockOwnerByEmail(db, email);
    expect(row).toMatchObject({
      staffId,
      role: 'owner',
      active: true,
      failedLoginCount: 0,
      lockedUntil: null,
      totpLastStep: null,
      totpSecretEnc: `enc-for-${staffId}`,
      recoveryCodeHashes: ['h1', 'h2', 'h3'],
    });
    expect(await auth.lockOwnerByStaffId(db, staffId)).toMatchObject({ email });
    expect(await auth.lockOwnerByEmail(db, 'nobody@example.test')).toBeUndefined();
  });

  test('a TOTP step is accepted once; the same or an older step is refused', async () => {
    const { staffId } = await newOwner();
    expect(await auth.claimTotpStep(db, staffId, 100)).toBe(true);
    expect(await auth.claimTotpStep(db, staffId, 100)).toBe(false);
    expect(await auth.claimTotpStep(db, staffId, 99)).toBe(false);
    expect(await auth.claimTotpStep(db, staffId, 101)).toBe(true);
  });

  test('two parallel requests with the same TOTP step: exactly one wins', async () => {
    const { staffId } = await newOwner();
    const results = await Promise.all([
      auth.claimTotpStep(db, staffId, 500),
      auth.claimTotpStep(db, staffId, 500),
      auth.claimTotpStep(db, staffId, 500),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('a recovery code works once and leaves the others', async () => {
    const { staffId, email } = await newOwner();
    expect(await auth.consumeRecoveryCode(db, staffId, 'h2')).toBe(true);
    expect(await auth.consumeRecoveryCode(db, staffId, 'h2')).toBe(false);
    expect(await auth.consumeRecoveryCode(db, staffId, 'unknown')).toBe(false);
    expect((await auth.lockOwnerByEmail(db, email))?.recoveryCodeHashes).toEqual(['h1', 'h3']);
  });

  test('parallel use of one recovery code: exactly one wins', async () => {
    const { staffId } = await newOwner();
    const results = await Promise.all([
      auth.consumeRecoveryCode(db, staffId, 'h1'),
      auth.consumeRecoveryCode(db, staffId, 'h1'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('login state (failures and lock) is stored', async () => {
    const { staffId, email } = await newOwner();
    const until = new Date('2026-10-01T10:00:00Z');
    await auth.setOwnerLoginState(db, staffId, { failedLoginCount: 5, lockedUntil: until });
    expect(await auth.lockOwnerByEmail(db, email)).toMatchObject({
      failedLoginCount: 5,
      lockedUntil: until,
    });
  });
});

describe('owner administration queries', () => {
  test('lockSoleOwner finds the owner, replaceOwnerSecondFactor swaps the secret and codes and clears the lock', async () => {
    const { staffId, email } = await newOwner();
    expect((await auth.lockSoleOwner(db))?.role).toBe('owner');

    await auth.setOwnerLoginState(db, staffId, { failedLoginCount: 4, lockedUntil: new Date() });
    await auth.claimTotpStep(db, staffId, 77);
    await auth.replaceOwnerSecondFactor(db, staffId, {
      totpSecretEnc: 'new-enc',
      recoveryCodeHashes: ['n1', 'n2'],
    });
    expect(await auth.lockOwnerByEmail(db, email)).toMatchObject({
      totpSecretEnc: 'new-enc',
      recoveryCodeHashes: ['n1', 'n2'],
      totpLastStep: null,
      failedLoginCount: 0,
      lockedUntil: null,
    });
  });

  test('clearOwnerLocks resets the failure count and lock only', async () => {
    const { staffId, email } = await newOwner();
    await auth.setOwnerLoginState(db, staffId, { failedLoginCount: 5, lockedUntil: new Date() });
    await auth.clearOwnerLocks(db, staffId);
    expect(await auth.lockOwnerByEmail(db, email)).toMatchObject({
      failedLoginCount: 0,
      lockedUntil: null,
      recoveryCodeHashes: ['h1', 'h2', 'h3'],
    });
  });

  test('revokeSessionsForStaff ends every open session of that person and no other', async () => {
    const a = await newOwner();
    const b = await newOwner();
    const at = new Date('2026-10-01T04:00:00Z');
    const hashes = [unique(), unique()];
    await auth.insertSession(db, {
      tokenHash: hashes[0] ?? '',
      staffId: a.staffId,
      deviceId: null,
      kind: 'owner',
      expiresAt: at,
      lastSeenAt: at,
    });
    await auth.insertSession(db, {
      tokenHash: hashes[1] ?? '',
      staffId: b.staffId,
      deviceId: null,
      kind: 'owner',
      expiresAt: at,
      lastSeenAt: at,
    });
    await auth.revokeSessionsForStaff(db, a.staffId, at);
    expect((await auth.findSessionByTokenHash(db, hashes[0] ?? ''))?.revokedAt).toEqual(at);
    expect((await auth.findSessionByTokenHash(db, hashes[1] ?? ''))?.revokedAt).toBeNull();
  });
});

describe('step-up counters are kept apart from sign-in counters', () => {
  test('owner: each has its own count and lock, and clearOwnerLocks clears both', async () => {
    const { staffId, email } = await newOwner();
    const until = new Date('2026-10-01T10:00:00Z');
    await auth.setOwnerLoginState(db, staffId, { failedLoginCount: 2, lockedUntil: null });
    await auth.setOwnerStepUpState(db, staffId, { stepUpFailedCount: 5, stepUpLockedUntil: until });
    expect(await auth.lockOwnerByEmail(db, email)).toMatchObject({
      failedLoginCount: 2,
      lockedUntil: null,
      stepUpFailedCount: 5,
      stepUpLockedUntil: until,
    });
    await auth.clearOwnerLocks(db, staffId);
    expect(await auth.lockOwnerByEmail(db, email)).toMatchObject({
      failedLoginCount: 0,
      stepUpFailedCount: 0,
      stepUpLockedUntil: null,
    });
  });

  test('staff: the same, and a new PIN clears both', async () => {
    const [row] = await db
      .insert(staff)
      .values({ displayName: `s-${unique()}`, role: 'manager', pinHash: 'h' })
      .returning({ id: staff.id });
    const id = row?.id ?? '';
    const until = new Date('2026-10-01T10:05:00Z');
    await auth.setStaffPinState(db, id, { failedPinCount: 1, lockedUntil: null });
    await auth.setStaffStepUpState(db, id, { stepUpFailedCount: 5, stepUpLockedUntil: until });
    expect(await auth.lockStaffForPin(db, id)).toMatchObject({
      failedPinCount: 1,
      lockedUntil: null,
      stepUpFailedCount: 5,
      stepUpLockedUntil: until,
    });
    await auth.setStaffPinHash(db, id, 'new');
    expect(await auth.lockStaffForPin(db, id)).toMatchObject({
      failedPinCount: 0,
      stepUpFailedCount: 0,
      stepUpLockedUntil: null,
    });
  });
});

describe('staff PINs', () => {
  async function newStaff(role: 'cashier' | 'kitchen', pinHash: string | null, active = true) {
    const [row] = await db
      .insert(staff)
      .values({ displayName: `s-${unique()}`, role, pinHash, active })
      .returning({ id: staff.id });
    return row?.id ?? '';
  }

  test('the PIN screen lists active staff who have a PIN, and nobody else', async () => {
    const withPin = await newStaff('cashier', 'h');
    const noPin = await newStaff('cashier', null);
    const inactive = await newStaff('kitchen', 'h', false);
    const ids = (await auth.listPinStaff(db)).map((s) => s.id);
    expect(ids).toContain(withPin);
    expect(ids).not.toContain(noPin);
    expect(ids).not.toContain(inactive);
  });

  test('the lock row exposes the counters, and setStaffPinState writes them', async () => {
    const id = await newStaff('cashier', 'h');
    expect(await auth.lockStaffForPin(db, id)).toMatchObject({
      id,
      role: 'cashier',
      pinHash: 'h',
      failedPinCount: 0,
      lockedUntil: null,
    });
    const until = new Date('2026-10-01T10:05:00Z');
    await auth.setStaffPinState(db, id, { failedPinCount: 5, lockedUntil: until });
    expect(await auth.lockStaffForPin(db, id)).toMatchObject({
      failedPinCount: 5,
      lockedUntil: until,
    });
    await auth.setStaffPinHash(db, id, 'new-hash');
    expect(await auth.lockStaffForPin(db, id)).toMatchObject({
      pinHash: 'new-hash',
      failedPinCount: 0,
      lockedUntil: null,
    });
    expect(await auth.lockStaffForPin(db, crypto.randomUUID())).toBeUndefined();
  });
});

describe('devices and sessions', () => {
  test('a device is found by its token hash and can be marked seen', async () => {
    const tokenHash = unique();
    const device = await auth.insertDevice(db, { name: 'iPad', kind: 'ipad', tokenHash });
    expect(device).toMatchObject({ name: 'iPad', kind: 'ipad', revokedAt: null, lastSeenAt: null });
    const at = new Date('2026-10-01T03:00:00Z');
    await auth.markDeviceSeen(db, device.id, at);
    expect(await auth.findDeviceByTokenHash(db, tokenHash)).toMatchObject({
      id: device.id,
      lastSeenAt: at,
    });
    expect(await auth.findDeviceByTokenHash(db, 'no-such-hash')).toBeUndefined();
  });

  test('a session is found with its staff member and device, and can be stepped up and revoked', async () => {
    const { staffId } = await newOwner();
    const device = await auth.insertDevice(db, {
      name: 'Laptop',
      kind: 'laptop',
      tokenHash: unique(),
    });
    const tokenHash = unique();
    const now = new Date('2026-10-01T03:00:00Z');
    const expiresAt = new Date('2026-10-01T15:00:00Z');
    const id = await auth.insertSession(db, {
      tokenHash,
      staffId,
      deviceId: device.id,
      kind: 'owner',
      expiresAt,
      lastSeenAt: now,
    });

    expect(await auth.findSessionByTokenHash(db, tokenHash)).toMatchObject({
      id,
      staffId,
      deviceId: device.id,
      kind: 'owner',
      expiresAt,
      lastSeenAt: now,
      stepUpUntil: null,
      revokedAt: null,
      staffRole: 'owner',
      staffActive: true,
      deviceRevokedAt: null,
    });

    const later = new Date('2026-10-01T03:10:00Z');
    await auth.touchSession(db, id, later);
    const until = new Date('2026-10-01T03:15:00Z');
    await auth.setSessionStepUp(db, id, until);
    await auth.revokeSession(db, id, later);
    expect(await auth.findSessionByTokenHash(db, tokenHash)).toMatchObject({
      lastSeenAt: later,
      stepUpUntil: until,
      revokedAt: later,
    });
    expect(await auth.findSessionByTokenHash(db, 'no-such-hash')).toBeUndefined();
  });

  test('a session without a device has no device columns', async () => {
    const { staffId } = await newOwner();
    const tokenHash = unique();
    const now = new Date('2026-10-01T03:00:00Z');
    await auth.insertSession(db, {
      tokenHash,
      staffId,
      deviceId: null,
      kind: 'pin',
      expiresAt: now,
      lastSeenAt: now,
    });
    expect(await auth.findSessionByTokenHash(db, tokenHash)).toMatchObject({
      deviceId: null,
      deviceRevokedAt: null,
      deviceLastSeenAt: null,
    });
  });
});

describe('audit', () => {
  test('insertAudit appends a row with the optional fields defaulted to null', async () => {
    const entityId = unique();
    await insertAudit(db, {
      actorType: 'system',
      action: 'test.action',
      entity: 'test',
      entityId,
      after: { ok: true },
    });
    const rows = await db.select().from(auditLog);
    const row = rows.find((r) => r.entityId === entityId);
    expect(row).toMatchObject({
      actorType: 'system',
      actorId: null,
      deviceId: null,
      action: 'test.action',
      before: null,
      after: { ok: true },
      ip: null,
    });
  });
});
