export interface PoolWatchdogOptions {
  /** A round trip on the long-lived pool the API serves requests with. */
  checkPool: () => Promise<void>;
  /** A round trip on a brand-new connection: tells a wedged pool from a real database outage. */
  checkFresh: () => Promise<void>;
  /** Called once the pool has failed while fresh connections worked, `threshold` times in a row. */
  onWedged: () => void;
  intervalMs?: number;
  threshold?: number;
  timeoutMs?: number;
}

function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([work, timeout])
    .then(() => undefined)
    .finally(() => clearTimeout(timer));
}

async function succeeds(check: () => Promise<void>, ms: number): Promise<boolean> {
  try {
    await withTimeout(check(), ms);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects a wedged connection pool (the API fails while the database is fine) so the process
 * can exit and Docker restarts it. A real database outage fails the fresh connection too, so
 * it never triggers a restart (see /healthz in app.ts).
 */
export function createPoolWatchdog(options: PoolWatchdogOptions) {
  const {
    checkPool,
    checkFresh,
    onWedged,
    intervalMs = 30_000,
    threshold = 3,
    timeoutMs = 5_000,
  } = options;
  let strikes = 0;
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      if (await succeeds(checkPool, timeoutMs)) {
        strikes = 0;
      } else if (await succeeds(checkFresh, timeoutMs)) {
        strikes += 1;
        if (strikes >= threshold) onWedged();
      } else {
        strikes = 0;
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
