import { z } from 'zod';

/** `off`: no pushes. `essential`: only "ready + receipt". `all`: any push staff or the app ask for. */
export type PushPolicy = 'off' | 'essential' | 'all';

export interface LinePolicy {
  push: PushPolicy;
  /** The quota warning level, in percent of the monthly limit. */
  warnAtPercent: number;
  /** Pushes a month on the LINE plan (Thailand free plan: 300, docs/04 §1.2). */
  monthlyLimit: number;
}

export const DEFAULT_LINE_POLICY: LinePolicy = {
  push: 'essential',
  warnAtPercent: 80,
  monthlyLimit: 300,
};

/** The seed and D-09 first used `ready-only` and `always`; they still read as the new names. */
const LEGACY: Record<string, PushPolicy> = { 'ready-only': 'essential', always: 'all' };

const policySchema = z.object({
  push: z
    .enum(['off', 'essential', 'all', 'ready-only', 'always'])
    .transform((p): PushPolicy => LEGACY[p] ?? (p as PushPolicy)),
  warnAtPercent: z.number().int().min(1).max(100).default(DEFAULT_LINE_POLICY.warnAtPercent),
  monthlyLimit: z.number().int().min(1).max(1_000_000).default(DEFAULT_LINE_POLICY.monthlyLimit),
});

/**
 * Reads the `line_policy` setting. Never saved: the default. Saved but unreadable: `off`, because
 * a push costs quota and cannot be taken back, so a broken value must not spend it.
 */
export function parseLinePolicy(raw: unknown): LinePolicy {
  if (raw === undefined) return DEFAULT_LINE_POLICY;
  const parsed = policySchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...DEFAULT_LINE_POLICY, push: 'off' };
}

/** The shop's calendar month, `YYYY-MM`. Bangkok has no daylight saving: a fixed +7 h shift. */
export function quotaMonth(at: Date): string {
  return new Date(at.getTime() + 7 * 3_600_000).toISOString().slice(0, 7);
}

/** Used up to the warning level and to the limit: the levels where the owner is told once. */
export function thresholdCrossed(
  used: number,
  policy: Pick<LinePolicy, 'warnAtPercent' | 'monthlyLimit'>,
): 'warn' | 'cap' | null {
  if (used === policy.monthlyLimit) return 'cap';
  if (used === Math.ceil((policy.monthlyLimit * policy.warnAtPercent) / 100)) return 'warn';
  return null;
}
