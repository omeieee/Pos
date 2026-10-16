/**
 * Auth: PIN sign-in and the PIN lockout ladder.
 */
import { authRepo, type Db, insertAudit } from '@sds/db';
import type { PinLoginInput, SessionResponse } from '@sds/shared';
import { accountLocked, invalidCredentials } from '../errors.ts';
import { type Emit, withTransaction } from '../tx.ts';
import {
  type AuthContext,
  type RequestMeta,
  seconds,
  securityAlert,
  type Track,
} from './context.ts';
import { burnPinCheck, verifyPin } from './crypto.ts';
import { issueSession, sessionResponse } from './sessions.ts';

// ---------- PIN attempts ----------

/**
 * `unknownAccount` asks the caller to pay for one decoy hash AFTER the transaction ends, so a
 * bogus request (no login needed) never holds a database connection while scrypt runs.
 */
export type PinAttempt =
  | { kind: 'ok' }
  | { kind: 'invalid'; unknownAccount?: true }
  | { kind: 'locked'; until: Date };

function pinCounters(row: authRepo.StaffPinRow, track: Track) {
  return track === 'signin'
    ? { failed: row.failedPinCount, lockedUntil: row.lockedUntil, level: row.pinLockLevel }
    : {
        failed: row.stepUpFailedCount,
        lockedUntil: row.stepUpLockedUntil,
        level: row.stepUpLockLevel,
      };
}

function savePinCounters(
  tx: Db,
  staffId: string,
  track: Track,
  next: { failed: number; lockedUntil: Date | null; level: number },
) {
  return track === 'signin'
    ? authRepo.setStaffPinState(tx, staffId, {
        failedPinCount: next.failed,
        lockedUntil: next.lockedUntil,
        pinLockLevel: next.level,
      })
    : authRepo.setStaffStepUpState(tx, staffId, {
        stepUpFailedCount: next.failed,
        stepUpLockedUntil: next.lockedUntil,
        stepUpLockLevel: next.level,
      });
}

export async function attemptPin(
  tx: Db,
  ctx: AuthContext,
  emit: Emit,
  row: authRepo.StaffPinRow | undefined,
  pin: string,
  where: { deviceId: string | null; ip: string | null },
  track: Track,
): Promise<PinAttempt> {
  if (!row?.active || !row.pinHash) return { kind: 'invalid', unknownAccount: true };
  const now = ctx.now();
  const current = pinCounters(row, track);
  if (current.lockedUntil && current.lockedUntil > now) {
    return { kind: 'locked', until: current.lockedUntil };
  }

  // An expired lock starts the count again.
  const earlier = current.lockedUntil ? 0 : current.failed;
  if (await verifyPin(row.pinHash, pin, ctx.keys)) {
    if (current.failed !== 0 || current.lockedUntil || current.level !== 0) {
      await savePinCounters(tx, row.id, track, { failed: 0, lockedUntil: null, level: 0 });
    }
    return { kind: 'ok' };
  }

  const failures = earlier + 1;
  if (failures >= ctx.policy.pinMaxFailures) {
    // Each lock cycle since the last success climbs one rung; the top rung repeats.
    const ladder = ctx.policy.pinLockLadderSeconds;
    const level = Math.min(current.level + 1, ladder.length);
    const until = new Date(now.getTime() + seconds(ladder[level - 1] ?? 0));
    await savePinCounters(tx, row.id, track, { failed: failures, lockedUntil: until, level });
    await insertAudit(tx, {
      actorType: 'system',
      deviceId: where.deviceId,
      action: track === 'signin' ? 'auth.pin_locked' : 'auth.pin_step_up_locked',
      entity: 'staff',
      entityId: row.id,
      after: { failedAttempts: failures, lockedUntil: until.toISOString(), lockLevel: level },
      ip: where.ip,
    });
    emit(
      securityAlert(ctx, track === 'signin' ? 'staff.pin_locked' : 'staff.step_up_locked', 'warn', {
        staffId: row.id,
        deviceId: where.deviceId,
      }),
    );
    return { kind: 'locked', until };
  }
  await savePinCounters(tx, row.id, track, {
    failed: failures,
    lockedUntil: null,
    level: current.level,
  });
  return { kind: 'invalid' };
}

export async function pinLogin(
  ctx: AuthContext,
  device: authRepo.DeviceRow,
  input: PinLoginInput,
  meta: RequestMeta,
): Promise<SessionResponse> {
  const outcome = await withTransaction(ctx, async (tx, emit) => {
    const row = await authRepo.lockStaffForPin(tx, input.staffId);
    const attempt = await attemptPin(
      tx,
      ctx,
      emit,
      row,
      input.pin,
      { deviceId: device.id, ip: meta.ip },
      'signin',
    );
    if (attempt.kind !== 'ok') return attempt;
    if (!row) throw new Error('an attempt cannot succeed without an account');
    const issued = await issueSession(tx, ctx, {
      staffId: row.id,
      deviceId: device.id,
      kind: 'pin',
    });
    return { kind: 'signed_in' as const, response: sessionResponse(ctx, issued, row, 'pin') };
  });
  if (outcome.kind === 'locked') throw accountLocked(outcome.until, ctx.now());
  if (outcome.kind === 'invalid') {
    // Same cost as a real check, so response time does not reveal which ids exist.
    if (outcome.unknownAccount) await burnPinCheck(input.pin, ctx.keys);
    throw invalidCredentials();
  }
  return outcome.response;
}
