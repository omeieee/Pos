/**
 * Queries for managing devices and staff (owner screens). Reads never select token or PIN
 * hashes; apps/api decides who may call them.
 */
import type { DeviceKind, StaffRole } from '@sds/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from './client.ts';
import { devices, sessions, staff } from './schema.ts';

// ---------- Devices ----------

export interface DeviceListRow {
  id: string;
  name: string;
  kind: DeviceKind;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  version: number;
}

const deviceColumns = {
  id: devices.id,
  name: devices.name,
  kind: devices.kind,
  lastSeenAt: devices.lastSeenAt,
  revokedAt: devices.revokedAt,
  version: devices.version,
};

export async function listDevices(db: Db): Promise<DeviceListRow[]> {
  const rows = await db
    .select(deviceColumns)
    .from(devices)
    .orderBy(asc(devices.name), asc(devices.id));
  return rows as DeviceListRow[];
}

export async function lockDevice(db: Db, id: string): Promise<DeviceListRow | undefined> {
  const [row] = await db
    .select(deviceColumns)
    .from(devices)
    .where(eq(devices.id, id))
    .for('update')
    .limit(1);
  return row as DeviceListRow | undefined;
}

export async function revokeDevice(db: Db, id: string, at: Date): Promise<DeviceListRow> {
  const [row] = await db
    .update(devices)
    .set({ revokedAt: at })
    .where(eq(devices.id, id))
    .returning(deviceColumns);
  if (!row) throw new Error('device vanished while locked');
  return row as DeviceListRow;
}

/** Ends every open session that was opened on this device. */
export async function revokeSessionsForDevice(db: Db, deviceId: string, at: Date): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: at })
    .where(and(eq(sessions.deviceId, deviceId), isNull(sessions.revokedAt)));
}

// ---------- Staff ----------

export interface StaffListRow {
  id: string;
  displayName: string;
  role: StaffRole;
  active: boolean;
  hasPin: boolean;
  lockedUntil: Date | null;
  version: number;
}

const staffColumns = {
  id: staff.id,
  displayName: staff.displayName,
  role: staff.role,
  active: staff.active,
  pinHash: staff.pinHash,
  lockedUntil: staff.lockedUntil,
  version: staff.version,
};

/** The hash itself is read only to say whether one exists, and is dropped here. */
function toListRow(row: {
  id: string;
  displayName: string;
  role: string;
  active: boolean;
  pinHash: string | null;
  lockedUntil: Date | null;
  version: number;
}): StaffListRow {
  const { pinHash, ...rest } = row;
  return { ...rest, role: rest.role as StaffRole, hasPin: pinHash !== null };
}

export async function listStaff(db: Db): Promise<StaffListRow[]> {
  const rows = await db
    .select(staffColumns)
    .from(staff)
    .orderBy(asc(staff.displayName), asc(staff.id));
  return rows.map(toListRow);
}

export async function lockStaff(db: Db, id: string): Promise<StaffListRow | undefined> {
  const [row] = await db
    .select(staffColumns)
    .from(staff)
    .where(eq(staff.id, id))
    .for('update')
    .limit(1);
  return row ? toListRow(row) : undefined;
}

export async function insertStaff(
  db: Db,
  input: { displayName: string; role: StaffRole; pinHash: string },
): Promise<StaffListRow> {
  const [row] = await db.insert(staff).values(input).returning(staffColumns);
  if (!row) throw new Error('staff insert returned no row');
  return toListRow(row);
}

/** One UPDATE guarded by the version the caller saw; no row back means it changed since. */
export async function updateStaffIfVersion(
  db: Db,
  id: string,
  expectedVersion: number,
  patch: { displayName?: string; active?: boolean },
): Promise<StaffListRow | undefined> {
  const [row] = await db
    .update(staff)
    .set(patch)
    .where(and(eq(staff.id, id), eq(staff.version, expectedVersion)))
    .returning(staffColumns);
  return row ? toListRow(row) : undefined;
}

/** The row after a PIN change (setStaffPinHash in auth.ts does the write and clears the locks). */
export async function findStaff(db: Db, id: string): Promise<StaffListRow | undefined> {
  const [row] = await db.select(staffColumns).from(staff).where(eq(staff.id, id)).limit(1);
  return row ? toListRow(row) : undefined;
}
