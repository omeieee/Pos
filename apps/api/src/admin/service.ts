/**
 * Device and staff management (02 §6, rule 9): list devices, revoke one, list staff, create
 * staff, rename or deactivate them, set a PIN. Owner only with step-up (the route guard checks);
 * every change is audited and alerted. A hash, token or PIN never leaves the database layer.
 */
import { authRepo, findAuditByRequestId, insertAudit, peopleRepo } from '@sds/db';
import {
  type ChangeRoleInput,
  type CreateStaffInput,
  type DeviceDto,
  type ListDevicesResponse,
  type ListStaffResponse,
  type OutboxRecoveryInput,
  type OutboxRecoveryResponse,
  type PatchStaffInput,
  PIN_MIN_DIGITS,
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
import { conflict, forbidden, notFound, versionConflict } from '../errors.ts';
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
    email: row.email,
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

/**
 * The owner took over or cleared other people's offline outbox entries on a device (the entries
 * live in the browser; this records that it happened). Counts only: no names, no contents. A retry
 * with the same `clientRequestId` answers the same and writes and alerts nothing more.
 */
export async function recordOutboxRecovery(
  ctx: AuthContext,
  actor: Principal,
  deviceId: string,
  input: OutboxRecoveryInput,
  meta: RequestMeta,
): Promise<{ result: OutboxRecoveryResponse; replay: boolean }> {
  const action = `device.outbox_${input.action}`;
  const result: OutboxRecoveryResponse = {
    deviceId,
    action: input.action,
    orders: input.orders,
    payments: input.payments,
  };
  return withTransaction(ctx, async (tx, emit) => {
    // The device row lock queues two requests for one device, so both cannot miss the other's row.
    if (!(await peopleRepo.lockDevice(tx, deviceId))) throw notFound('Device');
    const seen = await findAuditByRequestId(tx, 'devices', deviceId, input.clientRequestId);
    if (seen) {
      const was = (seen.after ?? {}) as { orders?: number; payments?: number };
      if (
        seen.action !== action ||
        was.orders !== input.orders ||
        was.payments !== input.payments
      ) {
        throw conflict(
          'IDEMPOTENCY_KEY_REUSED',
          'This request id was already used for a different recovery',
        );
      }
      return { result, replay: true };
    }
    await insertAudit(tx, {
      ...audited(actor, meta),
      deviceId,
      action,
      entity: 'devices',
      entityId: deviceId,
      after: {
        clientRequestId: input.clientRequestId,
        orders: input.orders,
        payments: input.payments,
      },
    });
    emit(
      securityAlert(ctx, 'device.outbox_recovery', 'warn', { staffId: actor.staffId, deviceId }),
    );
    return { result, replay: false };
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

const selfChange = () =>
  conflict('SELF_CHANGE', 'You cannot change your own account here. Ask another owner');
const lastOwner = () =>
  conflict('LAST_OWNER', 'The last active owner cannot lose the owner role or be deactivated');

/**
 * Name and active flag. Deactivating ends the person's open sessions at once. Another owner may
 * rename or deactivate an owner; nobody changes themselves, and the last active owner stays (D-23).
 * Lock order is always the active owners first, then the person.
 */
export async function patchStaffMember(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  input: PatchStaffInput,
  meta: RequestMeta,
): Promise<StaffDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const owners = await peopleRepo.lockActiveOwners(tx);
    const row = await peopleRepo.lockStaff(tx, id);
    if (!row) throw notFound('Staff member');
    if (id === actor.staffId) throw selfChange();
    if (row.version !== input.expectedVersion) throw versionConflict(row.version);
    const isLastOwner = row.role === 'owner' && row.active && owners.length <= 1;
    if (input.active === false && isLastOwner) throw lastOwner();
    if (!owners.includes(actor.staffId)) throw forbidden(); // the actor lost the owner role meanwhile

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
  const pinHash = await hashPin(input.pin, ctx.keys); // slow: not inside the transaction

  return withTransaction(ctx, async (tx, emit) => {
    const row = await peopleRepo.lockStaff(tx, id);
    if (!row) throw notFound('Staff member');
    // An owner sets their own PIN only: setting another owner's would let the setter sign in as them.
    if (row.role === 'owner' && id !== actor.staffId) {
      throw conflict('OWNER_PROTECTED', "Another owner's PIN can only be set by that owner");
    }
    // The owner and managers need all 6 digits; judged against the row as locked, not as read earlier.
    parse(z.object({ pin: pinSchemaFor(row.role) }), { pin: input.pin });
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

/**
 * Changes a person's role (D-23). Not yourself; the last active owner keeps the owner role; a PIN
 * of the new role's length is needed when that role's minimum is longer than the old one's (or the
 * person has no PIN and the new role steps up with a PIN). Someone can become an owner only if they
 * already sign in with an e-mail account. Ends the person's open sessions.
 */
export async function changeStaffRole(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  input: ChangeRoleInput,
  meta: RequestMeta,
): Promise<StaffDto> {
  if (id === actor.staffId) throw selfChange();
  // Slow, so before the transaction; whether it is needed and whether it fits is judged inside.
  const hashed = input.pin === undefined ? undefined : await hashPin(input.pin, ctx.keys);

  return withTransaction(ctx, async (tx, emit) => {
    const owners = await peopleRepo.lockActiveOwners(tx);
    const row = await peopleRepo.lockStaff(tx, id);
    if (!row) throw notFound('Staff member');
    if (row.version !== input.expectedVersion) throw versionConflict(row.version);
    if (row.role === input.role) return toStaffDto(row); // nothing to change
    // Judged against the row as locked. Validated against the NEW role: a missing or too short PIN
    // is a 400 on the field `pin`.
    const needsPin =
      PIN_MIN_DIGITS[input.role] > PIN_MIN_DIGITS[row.role] ||
      (!row.hasPin && input.role !== 'owner');
    if (needsPin || input.pin !== undefined) {
      parse(z.object({ pin: pinSchemaFor(input.role) }), { pin: input.pin });
    }
    const pinHash = hashed;
    if (row.role === 'owner' && row.active && owners.length <= 1) throw lastOwner();
    if (!owners.includes(actor.staffId)) throw forbidden(); // the actor lost the owner role meanwhile
    if (input.role === 'owner' && !(await peopleRepo.hasCredentials(tx, id))) {
      throw conflict(
        'OWNER_NEEDS_ACCOUNT',
        'Only a person with an e-mail account can be an owner. Invite them by e-mail instead',
      );
    }

    const updated = await peopleRepo.updateStaffIfVersion(tx, id, row.version, {
      role: input.role,
    });
    if (!updated) throw versionConflict(row.version); // cannot happen under the row lock
    if (pinHash !== undefined) await authRepo.setStaffPinHash(tx, id, pinHash);
    await authRepo.revokeSessionsForStaff(tx, id, ctx.now());
    await insertAudit(tx, {
      ...audited(actor, meta),
      action: 'staff.role_change',
      entity: 'staff',
      entityId: id,
      before: { role: row.role },
      after: { role: input.role, pinSet: pinHash !== undefined },
    });
    emit(
      securityAlert(ctx, 'staff.role_changed', 'warn', { staffId: id, deviceId: actor.deviceId }),
    );
    emit({ type: 'session.ended', staffId: id, reason: 'role_changed' });
    return toStaffDto((await peopleRepo.findStaff(tx, id)) ?? updated);
  });
}
