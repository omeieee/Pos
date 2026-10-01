/**
 * Auth timings and limits (02 §7, D-17). One place, so tests can shorten them.
 * Seconds everywhere.
 */
export interface AuthPolicy {
  /** A PIN session ends this long after sign-in (a shift; the owner's "daily PIN"). */
  pinSessionSeconds: number;
  /** ...or after this long without a request. */
  pinIdleSeconds: number;
  ownerSessionSeconds: number;
  ownerIdleSeconds: number;
  /** How long a successful step-up stays valid. */
  stepUpSeconds: number;
  /**
   * 5 wrong PINs lock the account (02 §7). Each repeated lock cycle lasts longer, one rung of this
   * ladder at a time and then the last rung for good: 5 min, 1 h, 24 h. A successful sign-in
   * puts the ladder back at the bottom.
   */
  pinMaxFailures: number;
  pinLockLadderSeconds: readonly number[];
  /** The owner's password login faces the internet, so its lock is longer. */
  ownerMaxFailures: number;
  ownerLockSeconds: number;
  /**
   * Ceiling on /v1/auth/owner and /v1/auth/step-up requests per minute across ALL callers,
   * a backstop against guessing spread over many addresses.
   */
  ownerGlobalRatePerMinute: number;
  stepUpGlobalRatePerMinute: number;
  /** `devices.last_seen_at` is synced to clients, so it is refreshed this rarely. */
  deviceSeenIntervalSeconds: number;
  /** `sessions.last_seen_at` (idle clock) is refreshed at most this often. */
  sessionTouchIntervalSeconds: number;
}

export const DEFAULT_AUTH_POLICY: AuthPolicy = {
  pinSessionSeconds: 12 * 60 * 60,
  pinIdleSeconds: 2 * 60 * 60,
  ownerSessionSeconds: 8 * 60 * 60,
  ownerIdleSeconds: 30 * 60,
  stepUpSeconds: 5 * 60,
  pinMaxFailures: 5,
  pinLockLadderSeconds: [5 * 60, 60 * 60, 24 * 60 * 60],
  ownerMaxFailures: 5,
  ownerLockSeconds: 15 * 60,
  ownerGlobalRatePerMinute: 30,
  stepUpGlobalRatePerMinute: 30,
  deviceSeenIntervalSeconds: 5 * 60,
  sessionTouchIntervalSeconds: 60,
};
