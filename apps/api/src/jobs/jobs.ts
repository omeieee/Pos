import type { LineJobDeps } from '../line/retry.ts';
import { retryLineEvents } from '../line/retry.ts';

/** What every job gets. Jobs are plain functions of this, so tests call them directly. */
export type JobDeps = LineJobDeps;

export interface JobDefinition {
  name: string;
  /** Five-field cron, evaluated in Asia/Bangkok. */
  cron: string;
  /** Must be safe to run twice and must do bounded work. Returns counts only (they are logged). */
  run(deps: JobDeps): Promise<Record<string, number>>;
}

export const JOBS: readonly JobDefinition[] = [
  {
    // Events stored but never handled, or handled with an error (webhook retry sweep).
    name: 'line-events-retry',
    cron: '*/5 * * * *',
    run: async (deps) => ({ ...(await retryLineEvents(deps)) }),
  },
];
