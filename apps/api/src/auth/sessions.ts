/**
 * Auth: sessions (open, authenticate, peek, describe, logout).
 */
import { timingSafeEqual } from 'node:crypto';
import { authRepo, type Db } from '@sds/db';
import type { AuthMeResponse, SessionKind, SessionResponse, StaffRole } from '@sds/shared';
import { deviceMismatch } from '../errors.ts';
import { type AuthContext, type Principal, permissionsOf, seconds } from './context.ts';
import { hashToken, newToken } from './crypto.ts';
import { touchDevice } from './devices.ts';

// ---------- Sessions ----------

export async function issueSession(
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

export function sessionResponse(
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

function sameDevice(storedHash: string | null, deviceToken: string | undefined): boolean {
  if (!storedHash || !deviceToken) return false;
  const given = Buffer.from(hashToken(deviceToken));
  const stored = Buffer.from(storedHash);
  return given.length === stored.length && timingSafeEqual(given, stored);
}

/**
 * The one set of rules for "is this session alive": unknown, revoked, expired, idle, a deactivated
 * person or a revoked device all give null, and a PIN session without its device's token throws
 * DEVICE_MISMATCH. It writes nothing. The REST guard adds the activity touches on top of it
 * (`authenticateSession`); the WebSocket re-checks with it as it is (`peekSession`).
 */
async function liveSession(
  ctx: AuthContext,
  token: string,
  deviceToken: string | undefined,
): Promise<authRepo.SessionRow | null> {
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

  // A PIN session is bound to the device it was opened on: it only works together with that
  // device's token, so a stolen session token is no use on its own. Owner sessions are not bound.
  if (row.kind === 'pin' && !sameDevice(row.deviceTokenHash, deviceToken)) {
    throw deviceMismatch();
  }
  return row;
}

function principalOfSession(row: authRepo.SessionRow): Principal {
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

/** Resolves a bearer token to a principal, or null if it is unknown, revoked, expired or idle. */
export async function authenticateSession(
  ctx: AuthContext,
  token: string,
  deviceToken: string | undefined,
): Promise<Principal | null> {
  const row = await liveSession(ctx, token, deviceToken);
  if (!row) return null;
  const now = ctx.now();
  if (now.getTime() - row.lastSeenAt.getTime() > seconds(ctx.policy.sessionTouchIntervalSeconds)) {
    await authRepo.touchSession(ctx.db, row.id, now);
  }
  if (row.deviceId) await touchDevice(ctx, row.deviceId, row.deviceLastSeenAt);
  return principalOfSession(row);
}

/**
 * The same check as `authenticateSession` with no writes: it does not extend the idle clock and
 * does not touch the device (which would also burn a sync rev). The WebSocket uses it, so an open
 * socket never keeps a session alive: logout, expiry, idleness, revocation and a deactivated
 * account all end it.
 */
export async function peekSession(
  ctx: AuthContext,
  token: string,
  deviceToken: string | undefined,
): Promise<Principal | null> {
  const row = await liveSession(ctx, token, deviceToken);
  return row ? principalOfSession(row) : null;
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
  // After the write: an open WebSocket on this session closes at once instead of at its next check.
  ctx.events.publish({ type: 'session.ended', sessionId: principal.sessionId, reason: 'logout' });
}
