import type { MyOrder } from '@sds/shared';

/** The pop-up stays at least this long, even when the answer is already there. */
export const SLIP_PROGRESS_MIN_MS = 5000;
/** Quick polling while a slip check is running. */
export const SLIP_POLL_FAST_MS = 2000;
/** After this long the quick rate ends and the page's normal rate takes over. */
export const SLIP_POLL_FAST_FOR_MS = 60_000;
/** With no result by now the pop-up gives up and shows the neutral staff-checking text. */
export const SLIP_PROGRESS_GIVE_UP_MS = 6 * 60_000;

/** In the checking phase for this long, the pop-up adds a line that it may take a minute. */
export const SLIP_PROGRESS_SLOW_HINT_AFTER_MS = 8000;

export type SlipProgressPhase = 'checking' | 'paid' | 'staff_review';

type Seen = Pick<MyOrder, 'paymentStatus' | 'slipCheck'>;

/** Whether the server has an answer: money received, or any finished check (all neutral). */
export function slipResolved(order: Seen | null): boolean {
  return order !== null && (order.paymentStatus === 'paid' || order.slipCheck === 'staff_review');
}

/**
 * What the pop-up shows. Never a failure: every non-success result and a timeout are the same
 * `staff_review`. An answer that arrives early is held back until the minimum time has passed.
 */
export function slipProgressPhase(elapsedMs: number, order: Seen | null): SlipProgressPhase {
  if (elapsedMs < SLIP_PROGRESS_MIN_MS) return 'checking';
  if (order?.paymentStatus === 'paid') return 'paid';
  if (order?.slipCheck === 'staff_review' || elapsedMs >= SLIP_PROGRESS_GIVE_UP_MS) {
    return 'staff_review';
  }
  return 'checking';
}

/** Whether the "may take about a minute" line shows: only while checking, after the threshold. */
export function slipSlowHintShown(elapsedMs: number, phase: SlipProgressPhase): boolean {
  return phase === 'checking' && elapsedMs >= SLIP_PROGRESS_SLOW_HINT_AFTER_MS;
}

/** How long until the minimum display time is over (0 when it already is). */
export function msUntilMinShown(elapsedMs: number): number {
  return Math.max(0, SLIP_PROGRESS_MIN_MS - elapsedMs);
}

/**
 * Poll delay while a slip check runs, or null to use the page's normal rate (no check running,
 * answered already, or past the quick window). Failures double the delay, so a bad connection
 * is not hammered.
 */
export function slipPollDelayMs(
  elapsedMs: number | null,
  order: Seen | null,
  failures: number,
): number | null {
  if (elapsedMs === null || elapsedMs >= SLIP_POLL_FAST_FOR_MS || slipResolved(order)) return null;
  return Math.min(30_000, SLIP_POLL_FAST_MS * 2 ** Math.min(failures, 4));
}
