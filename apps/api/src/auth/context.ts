/**
 * Auth: the types every auth file shares (context, request meta, principal), the permission helpers and `securityAlert`.
 * Imports nothing from its siblings, so no import cycle can start here.
 */
import { hasPermission, PERMISSIONS, type SessionKind, type StaffRole } from '@sds/shared';
import type { AppEvent, SecurityAlertEvent } from '../events.ts';
import type { CoreContext } from '../tx.ts';
import type { AuthKeys } from './crypto.ts';
import type { AuthPolicy } from './policy.ts';

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

export const seconds = (n: number) => n * 1000;

export function permissionsOf(role: StaffRole) {
  return PERMISSIONS.filter((p) => hasPermission(role, p));
}

export function hasFreshStepUp(principal: Principal, now: Date): boolean {
  return principal.stepUpUntil !== null && principal.stepUpUntil > now;
}

export function securityAlert(
  ctx: Pick<AuthContext, 'now'>,
  kind: string,
  severity: SecurityAlertEvent['severity'],
  who: {
    staffId?: string | null;
    deviceId?: string | null;
    subject?: SecurityAlertEvent['subject'];
    orderNo?: string;
    detail?: SecurityAlertEvent['detail'];
    slip2go?: SecurityAlertEvent['slip2go'];
  },
): AppEvent {
  return {
    type: 'alert.security',
    kind,
    severity,
    at: ctx.now().toISOString(),
    staffId: who.staffId ?? null,
    deviceId: who.deviceId ?? null,
    ...(who.subject ? { subject: who.subject } : {}),
    ...(who.orderNo ? { orderNo: who.orderNo } : {}),
    ...(who.detail ? { detail: who.detail } : {}),
    ...(who.slip2go ? { slip2go: who.slip2go } : {}),
  };
}

/**
 * Public sign-in and step-up are counted and locked apart (QA: guessing at one must not lock the
 * other). `signin` is open to anyone with a registered device, `step_up` needs a signed-in session.
 */
export type Track = 'signin' | 'step_up';
