/**
 * Authentication rules (D-17, 02 §7): registered devices, staff PINs, the owner's password +
 * TOTP, step-up and sessions. Policy and orchestration live here; SQL lives in `@sds/db`.
 *
 * Every attempt runs in one transaction that holds a row lock on the account being guessed, so
 * parallel guesses are counted one at a time. A wrong guess is returned as a value (not thrown)
 * so its counter and audit row commit, then the caller turns it into the HTTP error.
 */
import { authRepo, type Db, insertAudit } from '@sds/db';
import {
  type AuthMeResponse,
  hasPermission,
  type OwnerLoginInput,
  ownerStepUpInputSchema,
  PERMISSIONS,
  type PinLoginInput,
  type RegisterDeviceInput,
  type RegisterDeviceResponse,
  type SessionKind,
  type SessionResponse,
  type StaffRole,
  type StepUpResponse,
  staffStepUpInputSchema,
} from '@sds/shared';
import {
  accountLocked,
  deviceUnregistered,
  forbidden,
  invalidCredentials,
  secondFactorUnavailable,
} from '../errors.ts';
import type { AppEvent, SecurityAlertEvent } from '../events.ts';
import { type CoreContext, type Emit, withTransaction } from '../tx.ts';
import { parse } from '../validate.ts';
import {
  type AuthKeys,
  burnPasswordCheck,
  burnPinCheck,
  decryptSecret,
  hashRecoveryCode,
  hashToken,
  newToken,
  verifyPassword,
  verifyPin,
} from './crypto.ts';
import type { AuthPolicy } from './policy.ts';
import { verifyTotp } from './totp.ts';

export interface AuthContext extends CoreContext {
  keys: AuthKeys;
  policy: AuthPolicy;
}

/** Where a request came from. The IP goes to audit_log only. */
export interface RequestMeta {
  ip: string | null;
}

/** The signed-in staff member behind a valid session, as the guards and handlers see it. */
export interface Principal {
  sessionId: string;
  staffId: string;
  displayName: string;
  role: StaffRole;
  kind: SessionKind;
  deviceId: string | null;
  expiresAt: Date;
  stepUpUntil: Date | null;
}

const seconds = (n: number) => n * 1000;

export function permissionsOf(role: StaffRole) {
  return PERMISSIONS.filter((p) => hasPermission(role, p));
}

export function hasFreshStepUp(principal: Principal, now: Date): boolean {
  return principal.stepUpUntil !== null && principal.stepUpUntil > now;
}

function securityAlert(
  ctx: AuthContext,
  kind: string,
  severity: SecurityAlertEvent['severity'],
  who: { staffId?: string | null; deviceId?: string | null },
): AppEvent {
  return {
    type: 'alert.security',
    kind,
    severity,
    at: ctx.now().toISOString(),
    staffId: who.staffId ?? null,
    deviceId: who.deviceId ?? null,
  };
}

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

async function touchDevice(ctx: AuthContext, deviceId: string, lastSeenAt: Date | null) {
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

// ---------- Sessions ----------

async function issueSession(
  tx: Db,
  ctx: AuthContext,
  s: { staffId: string; deviceId: string | null; kind: SessionKind },
) {
  const token = newToken('sds_ses');
  const now = ctx.now();
  const lifetime = s.kind === 'pin' ? ctx.policy.pinSessionSeconds : ctx.policy.ownerSessionSeconds;
  const expiresAt = new Date(now.getTime() + seconds(lifetime));
  await authRepo.insertSession(tx, {
    tokenHash: hashToken(token),
    staffId: s.staffId,
    deviceId: s.deviceId,
    kind: s.kind,
    expiresAt,
    lastSeenAt: now,
  });
  return { token, expiresAt };
}

function sessionResponse(
  ctx: AuthContext,
  issued: { token: string; expiresAt: Date },
  staff: { id: string; displayName: string; role: StaffRole },
  kind: SessionKind,
): SessionResponse {
  const idle = kind === 'pin' ? ctx.policy.pinIdleSeconds : ctx.policy.ownerIdleSeconds;
  return {
    sessionToken: issued.token,
    expiresAt: issued.expiresAt.toISOString(),
    idleTimeoutSeconds: idle,
    staff: { id: staff.id, displayName: staff.displayName, role: staff.role },
    permissions: permissionsOf(staff.role),
  };
}

/** Resolves a bearer token to a principal, or null if it is unknown, revoked, expired or idle. */
export async function authenticateSession(
  ctx: AuthContext,
  token: string,
): Promise<Principal | null> {
  const row = await authRepo.findSessionByTokenHash(ctx.db, hashToken(token));
  if (!row) return null;
  const now = ctx.now();
  const idleSeconds = row.kind === 'pin' ? ctx.policy.pinIdleSeconds : ctx.policy.ownerIdleSeconds;
  const dead =
    row.revokedAt !== null ||
    row.expiresAt <= now ||
    now.getTime() - row.lastSeenAt.getTime() > seconds(idleSeconds) ||
    !row.staffActive ||
    (row.deviceId !== null && row.deviceRevokedAt !== null);
  if (dead) return null;

  if (now.getTime() - row.lastSeenAt.getTime() > seconds(ctx.policy.sessionTouchIntervalSeconds)) {
    await authRepo.touchSession(ctx.db, row.id, now);
  }
  if (row.deviceId) await touchDevice(ctx, row.deviceId, row.deviceLastSeenAt);

  return {
    sessionId: row.id,
    staffId: row.staffId,
    displayName: row.staffDisplayName,
    role: row.staffRole,
    kind: row.kind,
    deviceId: row.deviceId,
    expiresAt: row.expiresAt,
    stepUpUntil: row.stepUpUntil,
  };
}

export function describeSession(principal: Principal): AuthMeResponse {
  return {
    staff: { id: principal.staffId, displayName: principal.displayName, role: principal.role },
    deviceId: principal.deviceId,
    permissions: permissionsOf(principal.role),
    expiresAt: principal.expiresAt.toISOString(),
    stepUpUntil: principal.stepUpUntil?.toISOString() ?? null,
  };
}

export async function logout(ctx: AuthContext, principal: Principal): Promise<void> {
  await authRepo.revokeSession(ctx.db, principal.sessionId, ctx.now());
}

// ---------- PIN attempts ----------

/**
 * `unknownAccount` asks the caller to pay for one decoy hash AFTER the transaction ends, so a
 * bogus request (no login needed) never holds a database connection while scrypt runs.
 */
type PinAttempt =
  | { kind: 'ok' }
  | { kind: 'invalid'; unknownAccount?: true }
  | { kind: 'locked'; until: Date };

/**
 * Public sign-in and step-up are counted and locked apart (QA: guessing at one must not lock the
 * other). `signin` is open to anyone with a registered device, `step_up` needs a signed-in session.
 */
type Track = 'signin' | 'step_up';

function pinCounters(row: authRepo.StaffPinRow, track: Track) {
  return track === 'signin'
    ? { failed: row.failedPinCount, lockedUntil: row.lockedUntil }
    : { failed: row.stepUpFailedCount, lockedUntil: row.stepUpLockedUntil };
}

function savePinCounters(
  tx: Db,
  staffId: string,
  track: Track,
  next: { failed: number; lockedUntil: Date | null },
) {
  return track === 'signin'
    ? authRepo.setStaffPinState(tx, staffId, {
        failedPinCount: next.failed,
        lockedUntil: next.lockedUntil,
      })
    : authRepo.setStaffStepUpState(tx, staffId, {
        stepUpFailedCount: next.failed,
        stepUpLockedUntil: next.lockedUntil,
      });
}

async function attemptPin(
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
    if (current.failed !== 0 || current.lockedUntil) {
      await savePinCounters(tx, row.id, track, { failed: 0, lockedUntil: null });
    }
    return { kind: 'ok' };
  }

  const failures = earlier + 1;
  if (failures >= ctx.policy.pinMaxFailures) {
    const until = new Date(now.getTime() + seconds(ctx.policy.pinLockSeconds));
    await savePinCounters(tx, row.id, track, { failed: failures, lockedUntil: until });
    await insertAudit(tx, {
      actorType: 'system',
      deviceId: where.deviceId,
      action: track === 'signin' ? 'auth.pin_locked' : 'auth.pin_step_up_locked',
      entity: 'staff',
      entityId: row.id,
      after: { failedAttempts: failures, lockedUntil: until.toISOString() },
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
  await savePinCounters(tx, row.id, track, { failed: failures, lockedUntil: null });
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

// ---------- Owner attempts (password + TOTP or a recovery code) ----------

interface OwnerFactors {
  password: string;
  totp?: string | undefined;
  recoveryCode?: string | undefined;
}

type OwnerAttempt =
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
async function attemptOwner(
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
async function recordRecoveryCodeUse(
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
