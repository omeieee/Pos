/**
 * Keeps trying to start the background jobs without ever holding up the caller. A failed start
 * (the queue database unreachable, a bad schema) is reported and retried with growing delays; the
 * API keeps serving meanwhile. What is reported is the error class name and its `code` only: an
 * error message can hold a host name or a password.
 */
export interface JobFailure {
  attempt: number;
  errorName: string;
  /** A string `code` property (for example `ECONNREFUSED` or a Postgres SQLSTATE), when there is one. */
  code?: string;
  nextRetryMs: number;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** 5 s, 10 s, 20 s ... capped at 5 minutes. `attempt` starts at 1. */
export function backoffMs(attempt: number): number {
  return Math.min(5_000 * 2 ** (attempt - 1), 300_000);
}

/**
 * The owner is told on the first failure and then about hourly while it keeps failing (every 12th
 * attempt, at the 5 minute cap), not on every retry.
 */
export function alertOnAttempt(attempt: number): boolean {
  return attempt === 1 || attempt % 12 === 0;
}

export function superviseJobs(args: {
  start: () => Promise<{ stop(): Promise<void> }>;
  onFailure: (failure: JobFailure) => void;
  timers?: Timers;
}): { stop(): Promise<void> } {
  const timers = args.timers ?? realTimers;
  let running: { stop(): Promise<void> } | undefined;
  let timer: unknown;
  let stopped = false;
  let attempt = 0;

  const run = () => {
    timer = undefined;
    void args.start().then(
      (jobs) => {
        // Stopped while starting: do not leave it running.
        if (stopped) void jobs.stop().catch(() => undefined);
        else running = jobs;
      },
      (error: unknown) => {
        if (stopped) return;
        attempt += 1;
        const nextRetryMs = backoffMs(attempt);
        const code = (error as { code?: unknown } | null)?.code;
        args.onFailure({
          attempt,
          errorName: error instanceof Error ? error.name : 'Error',
          ...(typeof code === 'string' ? { code } : {}),
          nextRetryMs,
        });
        timer = timers.set(run, nextRetryMs);
      },
    );
  };
  run();

  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) timers.clear(timer);
      timer = undefined;
      await running?.stop().catch(() => undefined);
    },
  };
}
