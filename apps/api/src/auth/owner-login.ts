/**
 * Auth: owner sign-in (password plus TOTP or a recovery code) and its lockout ladder.
 */
import { authRepo, type Db, insertAudit } from '@sds/db';
import type { OwnerLoginInput, SessionResponse } from '@sds/shared';
import { accountLocked, invalidCredentials, secondFactorUnavailable } from '../errors.ts';
import { type Emit, withTransaction } from '../tx.ts';
import {
  type AuthContext,
  type RequestMeta,
  seconds,
  securityAlert,
  type Track,
} from './context.ts';
import { burnPasswordCheck, decryptSecret, hashRecoveryCode, verifyPassword } from './crypto.ts';
import { issueSession, sessionResponse } from './sessions.ts';
import { verifyTotp } from './totp.ts';

// ---------- Owner attempts (password + TOTP or a recovery code) ----------

interface OwnerFactors {
  password: string;
  totp?: string | undefined;
  recoveryCode?: string | undefined;
}

export type OwnerAttempt =
  | { kind: 'ok'; usedRecoveryCode: boolean; recoveryCodesLeft: number }
  | { kind: 'invalid'; unknownAccount?: true }
  | { kind: 'locked'; until: Date }
  /** The password was right but the stored TOTP secret cannot be decrypted. */
  | { kind: 'unavailable' };

async function secondFactorAccepted(
  tx: Db,
  ctx: AuthContext,
  row: authRepo.OwnerLoginRow,
  factors: OwnerFactors,
): Promise<{ ok: boolean; usedRecoveryCode: boolean; unreadable?: true }> {
  if (factors.totp !== undefined) {
    if (!row.totpSecretEnc) return { ok: false, usedRecoveryCode: false };
    let secret: Buffer;
    try {
      secret = decryptSecret(row.totpSecretEnc, ctx.keys.totpKey, row.staffId);
    } catch {
      // Wrong or lost key. Not a guess, so it is reported but never counted against the owner.
      return { ok: false, usedRecoveryCode: false, unreadable: true };
    }
    const matched = verifyTotp(secret, factors.totp, ctx.now().getTime());
    const ok = matched.ok && (await authRepo.claimTotpStep(tx, row.staffId, matched.step));
    return { ok, usedRecoveryCode: false };
  }
  if (factors.recoveryCode !== undefined) {
    const ok = await authRepo.consumeRecoveryCode(
      tx,
      row.staffId,
      hashRecoveryCode(factors.recoveryCode),
    );
    return { ok, usedRecoveryCode: ok };
  }
  return { ok: false, usedRecoveryCode: false };
}

function ownerCounters(row: authRepo.OwnerLoginRow, track: Track) {
  return track === 'signin'
    ? { failed: row.failedLoginCount, lockedUntil: row.lockedUntil }
    : { failed: row.stepUpFailedCount, lockedUntil: row.stepUpLockedUntil };
}

function saveOwnerCounters(
  tx: Db,
  staffId: string,
  track: Track,
  next: { failed: number; lockedUntil: Date | null },
) {
  return track === 'signin'
    ? authRepo.setOwnerLoginState(tx, staffId, {
        failedLoginCount: next.failed,
        lockedUntil: next.lockedUntil,
      })
    : authRepo.setOwnerStepUpState(tx, staffId, {
        stepUpFailedCount: next.failed,
        stepUpLockedUntil: next.lockedUntil,
      });
}

/**
 * The public sign-in never reveals a lock: an e-mail that does not exist, an account that is
 * locked and the attempt that locks it all answer "invalid" (the locked-from-the-start case also
 * pays for a decoy hash). Step-up needs a session, so its caller may be told.
 */
export async function attemptOwner(
  tx: Db,
  ctx: AuthContext,
  emit: Emit,
  row: authRepo.OwnerLoginRow | undefined,
  factors: OwnerFactors,
  where: { deviceId: string | null; ip: string | null },
  track: Track,
): Promise<OwnerAttempt> {
  // Nothing to count or audit against an unknown account; the per-IP rate limit covers it.
  if (!row?.active) return { kind: 'invalid', unknownAccount: true };
  const now = ctx.now();
  const current = ownerCounters(row, track);
  if (current.lockedUntil && current.lockedUntil > now) {
    return track === 'signin'
      ? { kind: 'invalid', unknownAccount: true }
      : { kind: 'locked', until: current.lockedUntil };
  }

  const earlier = current.lockedUntil ? 0 : current.failed;
  let second: Awaited<ReturnType<typeof secondFactorAccepted>> = {
    ok: false,
    usedRecoveryCode: false,
  };
  if (await verifyPassword(row.passwordHash, factors.password)) {
    second = await secondFactorAccepted(tx, ctx, row, factors);
  }
  if (second.unreadable) {
    await insertAudit(tx, {
      actorType: 'system',
      deviceId: where.deviceId,
      action: 'auth.totp_unreadable',
      entity: 'staff',
      entityId: row.staffId,
      after: {
        hint: 'the stored TOTP secret does not decrypt; use a recovery code, then owner:reset',
      },
      ip: where.ip,
    });
    emit(
      securityAlert(ctx, 'owner.totp_unreadable', 'critical', {
        staffId: row.staffId,
        deviceId: where.deviceId,
      }),
    );
    return { kind: 'unavailable' };
  }
  if (second.ok) {
    if (current.failed !== 0 || current.lockedUntil) {
      await saveOwnerCounters(tx, row.staffId, track, { failed: 0, lockedUntil: null });
    }
    return {
      kind: 'ok',
      usedRecoveryCode: second.usedRecoveryCode,
      recoveryCodesLeft: row.recoveryCodeHashes.length - (second.usedRecoveryCode ? 1 : 0),
    };
  }

  const failures = earlier + 1;
  const locks = failures >= ctx.policy.ownerMaxFailures;
  const until = locks ? new Date(now.getTime() + seconds(ctx.policy.ownerLockSeconds)) : null;
  await saveOwnerCounters(tx, row.staffId, track, { failed: failures, lockedUntil: until });
  await insertAudit(tx, {
    actorType: 'system',
    deviceId: where.deviceId,
    action: locks
      ? track === 'signin'
        ? 'auth.owner_locked'
        : 'auth.step_up_locked'
      : track === 'signin'
        ? 'auth.owner_login_failed'
        : 'auth.step_up_failed',
    entity: 'staff',
    entityId: row.staffId,
    after: { failedAttempts: failures, ...(until ? { lockedUntil: until.toISOString() } : {}) },
    ip: where.ip,
  });
  if (until) {
    emit(
      securityAlert(
        ctx,
        track === 'signin' ? 'owner.login_locked' : 'owner.step_up_locked',
        'critical',
        { staffId: row.staffId, deviceId: where.deviceId },
      ),
    );
    return track === 'signin' ? { kind: 'invalid' } : { kind: 'locked', until };
  }
  return { kind: 'invalid' };
}

/** A recovery code is a break-glass login: always audited and the owner is alerted. */
export async function recordRecoveryCodeUse(
  tx: Db,
  ctx: AuthContext,
  emit: Emit,
  who: { staffId: string; deviceId: string | null; ip: string | null },
  recoveryCodesLeft: number,
) {
  await insertAudit(tx, {
    actorType: 'staff',
    actorId: who.staffId,
    deviceId: who.deviceId,
    action: 'auth.recovery_code_used',
    entity: 'staff',
    entityId: who.staffId,
    after: { remaining: recoveryCodesLeft },
    ip: who.ip,
  });
  emit(
    securityAlert(ctx, 'owner.recovery_code_used', 'warn', {
      staffId: who.staffId,
      deviceId: who.deviceId,
    }),
  );
}

export async function ownerLogin(
  ctx: AuthContext,
  device: authRepo.DeviceRow | null,
  input: OwnerLoginInput,
  meta: RequestMeta,
): Promise<SessionResponse> {
  const deviceId = device?.id ?? null;
  const outcome = await withTransaction(ctx, async (tx, emit) => {
    const row = await authRepo.lockOwnerByEmail(tx, input.email);
    const attempt = await attemptOwner(
      tx,
      ctx,
      emit,
      row,
      input,
      { deviceId, ip: meta.ip },
      'signin',
    );
    if (attempt.kind !== 'ok') return attempt;
    if (!row) throw new Error('an attempt cannot succeed without an account');

    const issued = await issueSession(tx, ctx, { staffId: row.staffId, deviceId, kind: 'owner' });
    await insertAudit(tx, {
      actorType: 'staff',
      actorId: row.staffId,
      deviceId,
      action: 'auth.owner_login',
      entity: 'staff',
      entityId: row.staffId,
      after: { method: attempt.usedRecoveryCode ? 'password+recovery_code' : 'password+totp' },
      ip: meta.ip,
    });
    if (attempt.usedRecoveryCode) {
      const who = { staffId: row.staffId, deviceId, ip: meta.ip };
      await recordRecoveryCodeUse(tx, ctx, emit, who, attempt.recoveryCodesLeft);
    }
    const staff = { id: row.staffId, displayName: row.displayName, role: row.role };
    return { kind: 'signed_in' as const, response: sessionResponse(ctx, issued, staff, 'owner') };
  });
  if (outcome.kind === 'locked') throw accountLocked(outcome.until, ctx.now());
  if (outcome.kind === 'unavailable') throw secondFactorUnavailable();
  if (outcome.kind === 'invalid') {
    // Same cost as a real check, so response time does not reveal which e-mails exist.
    if (outcome.unknownAccount) await burnPasswordCheck(input.password);
    throw invalidCredentials();
  }
  return outcome.response;
}
