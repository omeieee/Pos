/**
 * Device and staff management (02 §6, rule 9): list devices, revoke one, list staff, create
 * staff, rename or deactivate them, set a PIN. Owner only with step-up (the route guard checks);
 * every change is audited and alerted. A hash, token or PIN never leaves the database layer.
 */
import { authRepo, insertAudit, peopleRepo } from '@sds/db';
import {
  type CreateStaffInput,
  type DeviceDto,
  type ListDevicesResponse,
  type ListStaffResponse,
  type PatchStaffInput,
  pinSchemaFor,
  type SetStaffPinInput,
  type StaffDto,
} from '@sds/shared';
import { z } from 'zod';
import { hashPin } from '../auth/crypto.ts';
import {
  type AuthContext,
  type Principal,
  type RequestMeta,
  securityAlert,
} from '../auth/service.ts';
import { conflict, notFound, versionConflict } from '../errors.ts';
import { withTransaction } from '../tx.ts';
import { parse } from '../validate.ts';

const iso = (date: Date | null) => (date ? date.toISOString() : null);

function toDeviceDto(row: peopleRepo.DeviceListRow): DeviceDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    lastSeenAt: iso(row.lastSeenAt),
    revokedAt: iso(row.revokedAt),
    version: row.version,
  };
}

function toStaffDto(row: peopleRepo.StaffListRow): StaffDto {
  return {
    id: row.id,
    displayName: row.displayName,
    role: row.role,
    active: row.active,
    hasPin: row.hasPin,
    pinLockedUntil: iso(row.lockedUntil),
    version: row.version,
  };
}

const audited = (actor: Principal, meta: RequestMeta) => ({
  actorType: 'staff' as const,
  actorId: actor.staffId,
  deviceId: actor.deviceId,
  ip: meta.ip,
});

// ---------- Devices ----------

export async function listDevices(ctx: AuthContext): Promise<ListDevicesResponse> {
  return { devices: (await peopleRepo.listDevices(ctx.db)).map(toDeviceDto) };
}

/** Stops the device's token and ends what is open on it. Revoking twice changes nothing. */
export async function revokeDevice(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  meta: RequestMeta,
): Promise<DeviceDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await peopleRepo.lockDevice(tx, id);
    if (!row) throw notFound('Device');
    if (row.revokedAt) return toDeviceDto(row);

    const now = ctx.now();
    const revoked = await peopleRepo.revokeDevice(tx, id, now);
    await peopleRepo.revokeSessionsForDevice(tx, id, now);
    await insertAudit(tx, {
      ...audited(actor, meta),
      action: 'device.revoke',
      entity: 'devices',
      entityId: id,
      after: { name: row.name, kind: row.kind },
    });
    emit(securityAlert(ctx, 'device.revoked', 'warn', { staffId: actor.staffId, deviceId: id }));
    emit({ type: 'session.ended', deviceId: id, reason: 'device_revoked' });
    return toDeviceDto(revoked);
  });
}

// ---------- Staff ----------

export async function listStaffMembers(ctx: AuthContext): Promise<ListStaffResponse> {
  return { staff: (await peopleRepo.listStaff(ctx.db)).map(toStaffDto) };
}

export async function createStaffMember(
  ctx: AuthContext,
  actor: Principal,
  input: CreateStaffInput,
  meta: RequestMeta,
): Promise<StaffDto> {
  const pinHash = await hashPin(input.pin, ctx.keys); // slow: not inside the transaction
  return withTransaction(ctx, async (tx, emit) => {
    const row = await peopleRepo.insertStaff(tx, {
      displayName: input.displayName,
      role: input.role,
      pinHash,
    });
    await insertAudit(tx, {
      ...audited(actor, meta),
      action: 'staff.create',
      entity: 'staff',
      entityId: row.id,
      after: { displayName: row.displayName, role: row.role },
    });
    emit(
      securityAlert(ctx, 'staff.created', 'warn', { staffId: row.id, deviceId: actor.deviceId }),
    );
    return toStaffDto(row);
  });
}

/** Name and active flag. Deactivating ends the person's open sessions at once. */
export async function patchStaffMember(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  input: PatchStaffInput,
  meta: RequestMeta,
): Promise<StaffDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await peopleRepo.lockStaff(tx, id);
    if (!row) throw notFound('Staff member');
    if (row.role === 'owner') {
      throw conflict('OWNER_PROTECTED', 'The owner account cannot be changed here');
    }
    if (row.version !== input.expectedVersion) throw versionConflict(row.version);

    const patch: { displayName?: string; active?: boolean } = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (input.displayName !== undefined && input.displayName !== row.displayName) {
      patch.displayName = input.displayName;
      before.displayName = row.displayName;
      after.displayName = input.displayName;
    }
    if (input.active !== undefined && input.active !== row.active) {
      patch.active = input.active;
      before.active = row.active;
      after.active = input.active;
    }
    if (Object.keys(patch).length === 0) return toStaffDto(row); // nothing to change

    const updated = await peopleRepo.updateStaffIfVersion(tx, id, row.version, patch);
    if (!updated) throw versionConflict(row.version); // cannot happen under the row lock
    if (patch.active === false) await authRepo.revokeSessionsForStaff(tx, id, ctx.now());
    await insertAudit(tx, {
      ...audited(actor, meta),
      action: 'staff.update',
      entity: 'staff',
      entityId: id,
      before,
      after,
    });
    if (patch.active === false) {
      emit(
        securityAlert(ctx, 'staff.deactivated', 'warn', { staffId: id, deviceId: actor.deviceId }),
      );
      emit({ type: 'session.ended', staffId: id, reason: 'staff_deactivated' });
    }
    return toStaffDto(updated);
  });
}

/** Sets a new PIN: clears every lock, ends the person's open sessions. The PIN is never stored or logged. */
export async function setStaffPin(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  input: SetStaffPinInput,
  meta: RequestMeta,
): Promise<StaffDto> {
  const known = await peopleRepo.findStaff(ctx.db, id);
  if (!known) throw notFound('Staff member');
  // The owner and managers need all 6 digits; the shared rule says so by role.
  parse(z.object({ pin: pinSchemaFor(known.role) }), { pin: input.pin });
  const pinHash = await hashPin(input.pin, ctx.keys);

  return withTransaction(ctx, async (tx, emit) => {
    const row = await peopleRepo.lockStaff(tx, id);
    if (!row) throw notFound('Staff member');
    await authRepo.setStaffPinHash(tx, id, pinHash);
    await authRepo.revokeSessionsForStaff(tx, id, ctx.now());
    await insertAudit(tx, {
      ...audited(actor, meta),
      action: 'staff.set_pin',
      entity: 'staff',
      entityId: id,
      after: { role: row.role },
    });
    emit(securityAlert(ctx, 'staff.pin_set', 'warn', { staffId: id, deviceId: actor.deviceId }));
    emit({ type: 'session.ended', staffId: id, reason: 'pin_changed' });
    const updated = await peopleRepo.findStaff(tx, id);
    return toStaffDto(updated ?? row);
  });
}
