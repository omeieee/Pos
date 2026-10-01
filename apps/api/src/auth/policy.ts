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
  /** 5 wrong PINs, then a 5-minute lock (02 §7). */
  pinMaxFailures: number;
  pinLockSeconds: number;
  /** The owner's password login faces the internet, so its lock is longer. */
  ownerMaxFailures: number;
  ownerLockSeconds: number;
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
  pinLockSeconds: 5 * 60,
  ownerMaxFailures: 5,
  ownerLockSeconds: 15 * 60,
  deviceSeenIntervalSeconds: 5 * 60,
  sessionTouchIntervalSeconds: 60,
};
