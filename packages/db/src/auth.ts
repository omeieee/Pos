/**
 * Queries for devices, staff PINs, owner credentials and sessions (02 §7). Only packages/db
 * imports the ORM, so apps/api calls these inside its own `db.transaction`. Policy (lockout
 * length, expiry, hashing) stays in apps/api; every comparison with "now" happens there too.
 */
import type { DeviceKind, SessionKind, StaffRole } from '@sds/shared';
import { and, asc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { devices, ownerCredentials, sessions, staff } from './schema.ts';

// ---------- Devices ----------

export interface DeviceRow {
  id: string;
  name: string;
  kind: DeviceKind;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

const deviceColumns = {
  id: devices.id,
  name: devices.name,
  kind: devices.kind,
  lastSeenAt: devices.lastSeenAt,
  revokedAt: devices.revokedAt,
};

export async function insertDevice(
  db: Db,
  input: { name: string; kind: DeviceKind; tokenHash: string },
): Promise<DeviceRow> {
  const [row] = await db.insert(devices).values(input).returning(deviceColumns);
  if (!row) throw new Error('device insert returned no row');
  return row as DeviceRow;
}

export async function findDeviceByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<DeviceRow | undefined> {
  const [row] = await db
    .select(deviceColumns)
    .from(devices)
    .where(eq(devices.tokenHash, tokenHash))
    .limit(1);
  return row as DeviceRow | undefined;
}

/** Each touch bumps the device's rev/version, so the caller throttles how often it calls this. */
export async function markDeviceSeen(db: Db, deviceId: string, at: Date): Promise<void> {
  await db.update(devices).set({ lastSeenAt: at }).where(eq(devices.id, deviceId));
}

// ---------- Staff and PINs ----------

export interface StaffPrincipalRow {
  id: string;
  displayName: string;
  role: StaffRole;
}

export interface StaffPinRow extends StaffPrincipalRow {
  pinHash: string | null;
  active: boolean;
  failedPinCount: number;
  lockedUntil: Date | null;
  stepUpFailedCount: number;
  stepUpLockedUntil: Date | null;
}

/** Active staff who have a PIN: the tiles on the PIN screen. */
export async function listPinStaff(db: Db): Promise<StaffPrincipalRow[]> {
  const rows = await db
    .select({ id: staff.id, displayName: staff.displayName, role: staff.role })
    .from(staff)
    .where(and(eq(staff.active, true), isNotNull(staff.pinHash)))
    .orderBy(asc(staff.displayName), asc(staff.id));
  return rows as StaffPrincipalRow[];
}

/** Locks the row for the rest of the transaction, so parallel PIN guesses are counted one by one. */
export async function lockStaffForPin(db: Db, staffId: string): Promise<StaffPinRow | undefined> {
  const [row] = await db
    .select({
      id: staff.id,
      displayName: staff.displayName,
      role: staff.role,
      pinHash: staff.pinHash,
      active: staff.active,
      failedPinCount: staff.failedPinCount,
      lockedUntil: staff.lockedUntil,
      stepUpFailedCount: staff.stepUpFailedCount,
      stepUpLockedUntil: staff.stepUpLockedUntil,
    })
    .from(staff)
    .where(eq(staff.id, staffId))
    .for('update')
    .limit(1);
  return row as StaffPinRow | undefined;
}

export async function setStaffPinState(
  db: Db,
  staffId: string,
  state: { failedPinCount: number; lockedUntil: Date | null },
): Promise<void> {
  await db.update(staff).set(state).where(eq(staff.id, staffId));
}

/** Step-up has its own count and lock, apart from sign-in (QA: one must not lock the other). */
export async function setStaffStepUpState(
  db: Db,
  staffId: string,
  state: { stepUpFailedCount: number; stepUpLockedUntil: Date | null },
): Promise<void> {
  await db.update(staff).set(state).where(eq(staff.id, staffId));
}

export async function setStaffPinHash(db: Db, staffId: string, pinHash: string): Promise<void> {
  await db
    .update(staff)
    .set({
      pinHash,
      failedPinCount: 0,
      lockedUntil: null,
      stepUpFailedCount: 0,
      stepUpLockedUntil: null,
    })
    .where(eq(staff.id, staffId));
}

// ---------- Owner credentials ----------

export interface OwnerLoginRow {
  staffId: string;
  email: string;
  passwordHash: string;
  totpSecretEnc: string | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  stepUpFailedCount: number;
  stepUpLockedUntil: Date | null;
  totpLastStep: number | null;
  recoveryCodeHashes: string[];
  displayName: string;
  role: StaffRole;
  active: boolean;
}

const ownerColumns = {
  staffId: ownerCredentials.staffId,
  email: ownerCredentials.email,
  passwordHash: ownerCredentials.passwordHash,
  totpSecretEnc: ownerCredentials.totpSecretEnc,
  failedLoginCount: ownerCredentials.failedLoginCount,
  lockedUntil: ownerCredentials.lockedUntil,
  stepUpFailedCount: ownerCredentials.stepUpFailedCount,
  stepUpLockedUntil: ownerCredentials.stepUpLockedUntil,
  totpLastStep: ownerCredentials.totpLastStep,
  recoveryCodeHashes: ownerCredentials.recoveryCodeHashes,
  displayName: staff.displayName,
  role: staff.role,
  active: staff.active,
};

/** Locks the credentials row (not the staff row) until the transaction ends. */
export async function lockOwnerByEmail(db: Db, email: string): Promise<OwnerLoginRow | undefined> {
  const [row] = await db
    .select(ownerColumns)
    .from(ownerCredentials)
    .innerJoin(staff, eq(staff.id, ownerCredentials.staffId))
    .where(eq(ownerCredentials.email, email))
    .for('update', { of: ownerCredentials })
    .limit(1);
  return row as OwnerLoginRow | undefined;
}

export async function lockOwnerByStaffId(
  db: Db,
  staffId: string,
): Promise<OwnerLoginRow | undefined> {
  const [row] = await db
    .select(ownerColumns)
    .from(ownerCredentials)
    .innerJoin(staff, eq(staff.id, ownerCredentials.staffId))
    .where(eq(ownerCredentials.staffId, staffId))
    .for('update', { of: ownerCredentials })
    .limit(1);
  return row as OwnerLoginRow | undefined;
}

/** The owner (the shop has exactly one), with the credentials row locked. For the owner:* commands. */
export async function lockSoleOwner(db: Db): Promise<OwnerLoginRow | undefined> {
  const [row] = await db
    .select(ownerColumns)
    .from(ownerCredentials)
    .innerJoin(staff, eq(staff.id, ownerCredentials.staffId))
    .where(eq(staff.role, 'owner'))
    .orderBy(asc(staff.id))
    .for('update', { of: ownerCredentials })
    .limit(1);
  return row as OwnerLoginRow | undefined;
}

/** Replaces the authenticator secret and the recovery codes, and clears the lock and replay marker. */
export async function replaceOwnerSecondFactor(
  db: Db,
  staffId: string,
  next: { totpSecretEnc: string; recoveryCodeHashes: string[] },
): Promise<void> {
  await db
    .update(ownerCredentials)
    .set({
      totpSecretEnc: next.totpSecretEnc,
      recoveryCodeHashes: next.recoveryCodeHashes,
      totpLastStep: null,
      failedLoginCount: 0,
      lockedUntil: null,
      stepUpFailedCount: 0,
      stepUpLockedUntil: null,
    })
    .where(eq(ownerCredentials.staffId, staffId));
}

/** Clears both locks: the public sign-in and step-up. */
export async function clearOwnerLocks(db: Db, staffId: string): Promise<void> {
  await db
    .update(ownerCredentials)
    .set({ failedLoginCount: 0, lockedUntil: null, stepUpFailedCount: 0, stepUpLockedUntil: null })
    .where(eq(ownerCredentials.staffId, staffId));
}

export async function setOwnerStepUpState(
  db: Db,
  staffId: string,
  state: { stepUpFailedCount: number; stepUpLockedUntil: Date | null },
): Promise<void> {
  await db.update(ownerCredentials).set(state).where(eq(ownerCredentials.staffId, staffId));
}

export async function setOwnerLoginState(
  db: Db,
  staffId: string,
  state: { failedLoginCount: number; lockedUntil: Date | null },
): Promise<void> {
  await db.update(ownerCredentials).set(state).where(eq(ownerCredentials.staffId, staffId));
}

/**
 * Accepts a TOTP time step only if it is newer than every step used before (RFC 6238 §5.2:
 * a code works once). One conditional UPDATE, so two parallel requests cannot both win.
 */
export async function claimTotpStep(db: Db, staffId: string, step: number): Promise<boolean> {
  const rows = await db
    .update(ownerCredentials)
    .set({ totpLastStep: step })
    .where(
      and(
        eq(ownerCredentials.staffId, staffId),
        or(isNull(ownerCredentials.totpLastStep), lt(ownerCredentials.totpLastStep, step)),
      ),
    )
    .returning({ staffId: ownerCredentials.staffId });
  return rows.length === 1;
}

/** Removes the code's hash in one conditional UPDATE: a recovery code works once. */
export async function consumeRecoveryCode(
  db: Db,
  staffId: string,
  codeHash: string,
): Promise<boolean> {
  const rows = await db
    .update(ownerCredentials)
    .set({
      recoveryCodeHashes: sql`array_remove(${ownerCredentials.recoveryCodeHashes}, ${codeHash})`,
    })
    .where(
      and(
        eq(ownerCredentials.staffId, staffId),
        sql`${codeHash} = any(${ownerCredentials.recoveryCodeHashes})`,
      ),
    )
    .returning({ staffId: ownerCredentials.staffId });
  return rows.length === 1;
}

export async function ownerExists(db: Db): Promise<boolean> {
  const rows = await db
    .select({ id: staff.id })
    .from(staff)
    .where(eq(staff.role, 'owner'))
    .limit(1);
  return rows.length > 0;
}

export interface NewOwner {
  email: string;
  displayName: string;
  passwordHash: string;
  pinHash: string | null;
  /** Called with the new staff id (the AES-GCM associated data) to produce the stored secret. */
  encryptTotpSecret: (staffId: string) => string;
  recoveryCodeHashes: string[];
}

/** Creates the owner's staff row and credentials. Call inside a transaction. */
export async function insertOwner(db: Db, owner: NewOwner): Promise<{ staffId: string }> {
  const [row] = await db
    .insert(staff)
    .values({
      displayName: owner.displayName,
      role: 'owner',
      ...(owner.pinHash ? { pinHash: owner.pinHash } : {}),
    })
    .returning({ id: staff.id });
  if (!row) throw new Error('owner insert returned no row');
  await db.insert(ownerCredentials).values({
    staffId: row.id,
    email: owner.email,
    passwordHash: owner.passwordHash,
    totpSecretEnc: owner.encryptTotpSecret(row.id),
    recoveryCodeHashes: owner.recoveryCodeHashes,
  });
  return { staffId: row.id };
}

// ---------- Sessions ----------

export interface SessionRow {
  id: string;
  staffId: string;
  deviceId: string | null;
  kind: SessionKind;
  expiresAt: Date;
  lastSeenAt: Date;
  stepUpUntil: Date | null;
  revokedAt: Date | null;
  staffDisplayName: string;
  staffRole: StaffRole;
  staffActive: boolean;
  deviceRevokedAt: Date | null;
  deviceLastSeenAt: Date | null;
}

export async function insertSession(
  db: Db,
  input: {
    tokenHash: string;
    staffId: string;
    deviceId: string | null;
    kind: SessionKind;
    expiresAt: Date;
    lastSeenAt: Date;
  },
): Promise<string> {
  const [row] = await db.insert(sessions).values(input).returning({ id: sessions.id });
  if (!row) throw new Error('session insert returned no row');
  return row.id;
}

/** One round trip per authenticated request: the session, its staff member and its device. */
export async function findSessionByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<SessionRow | undefined> {
  const [row] = await db
    .select({
      id: sessions.id,
      staffId: sessions.staffId,
      deviceId: sessions.deviceId,
      kind: sessions.kind,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      stepUpUntil: sessions.stepUpUntil,
      revokedAt: sessions.revokedAt,
      staffDisplayName: staff.displayName,
      staffRole: staff.role,
      staffActive: staff.active,
      deviceRevokedAt: devices.revokedAt,
      deviceLastSeenAt: devices.lastSeenAt,
    })
    .from(sessions)
    .innerJoin(staff, eq(staff.id, sessions.staffId))
    .leftJoin(devices, eq(devices.id, sessions.deviceId))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  return row as SessionRow | undefined;
}

export async function touchSession(db: Db, sessionId: string, at: Date): Promise<void> {
  await db.update(sessions).set({ lastSeenAt: at }).where(eq(sessions.id, sessionId));
}

export async function setSessionStepUp(db: Db, sessionId: string, until: Date): Promise<void> {
  await db.update(sessions).set({ stepUpUntil: until }).where(eq(sessions.id, sessionId));
}

/** Ends every open session of a staff member (a PIN was reset, the authenticator was replaced). */
export async function revokeSessionsForStaff(db: Db, staffId: string, at: Date): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: at })
    .where(and(eq(sessions.staffId, staffId), isNull(sessions.revokedAt)));
}

export async function revokeSession(db: Db, sessionId: string, at: Date): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: at })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}
