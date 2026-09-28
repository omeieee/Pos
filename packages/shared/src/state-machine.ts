import type { StaffRole } from './enums.ts';
import { hasPermission, type Permission, requiresStepUp } from './permissions.ts';

export type Actor = { kind: 'staff'; role: StaffRole } | { kind: 'customer' } | { kind: 'system' };

export interface TransitionRule<S extends string> {
  from: S;
  to: S;
  /** Staff may make this transition when their role has this permission. */
  staff?: Permission;
  customer?: boolean;
  system?: boolean;
  reasonRequired?: boolean;
}

export interface TransitionContext {
  actor: Actor;
  reason?: string | undefined;
}

export type TransitionError = 'invalid_transition' | 'forbidden' | 'reason_required';

export type TransitionResult =
  | { ok: true; stepUp: boolean }
  | { ok: false; error: TransitionError };

export function makeMachine<S extends string>(rules: readonly TransitionRule<S>[]) {
  const find = (from: S, to: S) => rules.find((r) => r.from === from && r.to === to);

  function transition(from: S, to: S, ctx: TransitionContext): TransitionResult {
    const rule = find(from, to);
    if (!rule) return { ok: false, error: 'invalid_transition' };

    const { actor } = ctx;
    const allowed =
      (actor.kind === 'staff' &&
        rule.staff !== undefined &&
        hasPermission(actor.role, rule.staff)) ||
      (actor.kind === 'customer' && rule.customer === true) ||
      (actor.kind === 'system' && rule.system === true);
    if (!allowed) return { ok: false, error: 'forbidden' };

    if (rule.reasonRequired && !ctx.reason?.trim()) return { ok: false, error: 'reason_required' };

    const stepUp = actor.kind === 'staff' && rule.staff !== undefined && requiresStepUp(rule.staff);
    return { ok: true, stepUp };
  }

  function targets(from: S): S[] {
    return rules.filter((r) => r.from === from).map((r) => r.to);
  }

  return { rules, transition, targets };
}
