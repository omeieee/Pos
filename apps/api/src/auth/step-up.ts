/**
 * Auth: step-up re-authentication for sensitive actions.
 */
import { authRepo, insertAudit } from '@sds/db';
import { ownerStepUpInputSchema, type StepUpResponse, staffStepUpInputSchema } from '@sds/shared';
import { accountLocked, invalidCredentials, secondFactorUnavailable } from '../errors.ts';
import { withTransaction } from '../tx.ts';
import { parse } from '../validate.ts';
import { type AuthContext, type Principal, type RequestMeta, seconds } from './context.ts';
import { burnPasswordCheck, burnPinCheck } from './crypto.ts';
import { attemptOwner, type OwnerAttempt, recordRecoveryCodeUse } from './owner-login.ts';
import { attemptPin, type PinAttempt } from './pin.ts';

// ---------- Step-up ----------

/**
 * Re-authentication for sensitive actions (R4: a stolen session must not be able to change the
 * PromptPay ID). The factor depends on the ROLE, not on how the session was opened: the owner
 * always gives password + a second factor, even on an iPad unlocked with a PIN; other roles have
 * no password, so they re-enter their PIN. Signing in does not count as step-up.
 */
export async function stepUp(
  ctx: AuthContext,
  principal: Principal,
  body: unknown,
  meta: RequestMeta,
): Promise<StepUpResponse> {
  const credentials =
    principal.role === 'owner'
      ? ({ type: 'owner', factors: parse(ownerStepUpInputSchema, body) } as const)
      : ({ type: 'pin', pin: parse(staffStepUpInputSchema, body).pin } as const);

  const burnDecoy = () =>
    credentials.type === 'owner'
      ? burnPasswordCheck(credentials.factors.password)
      : burnPinCheck(credentials.pin, ctx.keys);
  const where = { deviceId: principal.deviceId, ip: meta.ip };
  const outcome = await withTransaction(ctx, async (tx, emit) => {
    let attempt: PinAttempt | OwnerAttempt;
    let method: string;
    if (credentials.type === 'owner') {
      const row = await authRepo.lockOwnerByStaffId(tx, principal.staffId);
      attempt = await attemptOwner(tx, ctx, emit, row, credentials.factors, where, 'step_up');
      method =
        credentials.factors.recoveryCode === undefined ? 'password+totp' : 'password+recovery_code';
    } else {
      const row = await authRepo.lockStaffForPin(tx, principal.staffId);
      attempt = await attemptPin(tx, ctx, emit, row, credentials.pin, where, 'step_up');
      method = 'pin';
    }
    if (attempt.kind !== 'ok') return attempt;

    const until = new Date(ctx.now().getTime() + seconds(ctx.policy.stepUpSeconds));
    await authRepo.setSessionStepUp(tx, principal.sessionId, until);
    await insertAudit(tx, {
      actorType: 'staff',
      actorId: principal.staffId,
      deviceId: principal.deviceId,
      action: 'auth.step_up',
      entity: 'staff',
      entityId: principal.staffId,
      after: { method, stepUpUntil: until.toISOString(), sessionId: principal.sessionId },
      ip: meta.ip,
    });
    if ('usedRecoveryCode' in attempt && attempt.usedRecoveryCode) {
      await recordRecoveryCodeUse(
        tx,
        ctx,
        emit,
        { staffId: principal.staffId, deviceId: principal.deviceId, ip: meta.ip },
        attempt.recoveryCodesLeft,
      );
    }
    return { kind: 'stepped_up' as const, stepUpUntil: until };
  });
  if (outcome.kind === 'locked') throw accountLocked(outcome.until, ctx.now());
  if (outcome.kind === 'unavailable') throw secondFactorUnavailable();
  if (outcome.kind === 'invalid') {
    if (outcome.unknownAccount) await burnDecoy();
    throw invalidCredentials();
  }
  return { stepUpUntil: outcome.stepUpUntil.toISOString() };
}
