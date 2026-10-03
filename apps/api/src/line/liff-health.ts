/**
 * Notices when LINE keeps refusing the tokens of the customer app. One bad token is a customer's
 * stale page; many in a row usually mean `LINE_LIFF_ID` points at the wrong channel, so nobody can
 * sign in. The tracker counts refusals in a sliding window, and says so once an hour. It holds
 * counts and times only: never a token, a user id or an address.
 */
export const LIFF_REJECTION_WINDOW_MS = 10 * 60_000;
export const LIFF_REJECTION_THRESHOLD = 5;
export const LIFF_ALERT_EVERY_MS = 60 * 60_000;

export interface LiffHealth {
  /** Records one refusal. `alert` is true for the first one over the threshold in an hour. */
  rejected(now: Date): { count: number; overThreshold: boolean; alert: boolean };
  /** A success clears the streak (the id is evidently right). */
  accepted(): void;
}

export function createLiffHealth(): LiffHealth {
  let times: number[] = [];
  let lastAlert = Number.NEGATIVE_INFINITY;
  return {
    rejected(nowDate) {
      const now = nowDate.getTime();
      times = times.filter((t) => now - t < LIFF_REJECTION_WINDOW_MS);
      times.push(now);
      const overThreshold = times.length >= LIFF_REJECTION_THRESHOLD;
      const alert = overThreshold && now - lastAlert >= LIFF_ALERT_EVERY_MS;
      if (alert) lastAlert = now;
      return { count: times.length, overThreshold, alert };
    },
    accepted() {
      times = [];
    },
  };
}
