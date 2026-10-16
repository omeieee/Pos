/**
 * Auth: device tokens (register, authenticate, last seen) and the sign-in staff list.
 */
import { authRepo, insertAudit } from '@sds/db';
import type { RegisterDeviceInput, RegisterDeviceResponse } from '@sds/shared';
import { deviceUnregistered, forbidden } from '../errors.ts';
import { withTransaction } from '../tx.ts';
import {
  type AuthContext,
  type Principal,
  type RequestMeta,
  seconds,
  securityAlert,
} from './context.ts';
import { hashToken, newToken } from './crypto.ts';

// ---------- Devices ----------

/** A registered, non-revoked device. Throws 401 so an unknown device never reaches the staff list. */
export async function authenticateDevice(
  ctx: AuthContext,
  token: string | undefined,
): Promise<authRepo.DeviceRow> {
  if (!token) throw deviceUnregistered();
  const device = await authRepo.findDeviceByTokenHash(ctx.db, hashToken(token));
  if (!device || device.revokedAt) throw deviceUnregistered();
  await touchDevice(ctx, device.id, device.lastSeenAt);
  return device;
}

/** The staff PIN screen runs on tablets, phones and laptops, never on the print agent. */
export function requireStaffDevice(device: authRepo.DeviceRow): void {
  if (device.kind === 'print_agent') throw forbidden();
}

export async function touchDevice(ctx: AuthContext, deviceId: string, lastSeenAt: Date | null) {
  const now = ctx.now();
  if (
    !lastSeenAt ||
    now.getTime() - lastSeenAt.getTime() > seconds(ctx.policy.deviceSeenIntervalSeconds)
  ) {
    await authRepo.markDeviceSeen(ctx.db, deviceId, now);
  }
}

export async function registerDevice(
  ctx: AuthContext,
  actor: Principal,
  input: RegisterDeviceInput,
  meta: RequestMeta,
): Promise<RegisterDeviceResponse> {
  const token = newToken('sds_dev');
  const device = await withTransaction(ctx, async (tx, emit) => {
    const created = await authRepo.insertDevice(tx, { ...input, tokenHash: hashToken(token) });
    await insertAudit(tx, {
      actorType: 'staff',
      actorId: actor.staffId,
      deviceId: actor.deviceId,
      action: 'device.register',
      entity: 'devices',
      entityId: created.id,
      after: { name: created.name, kind: created.kind },
      ip: meta.ip,
    });
    emit(
      securityAlert(ctx, 'device.registered', 'warn', {
        staffId: actor.staffId,
        deviceId: created.id,
      }),
    );
    return created;
  });
  return { device: { id: device.id, name: device.name, kind: device.kind }, deviceToken: token };
}

export async function listLoginStaff(ctx: AuthContext) {
  return { staff: await authRepo.listPinStaff(ctx.db) };
}
