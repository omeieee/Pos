import { type LineJobDeps, retryLineEvents } from '../line/retry.ts';
import {
  anonymizeOrders,
  expireEmptyLineCustomers,
  expireRecipients,
  purgeLineEvents,
  purgeSlips,
  purgeStaffInvites,
  sweepOrphanSlips,
} from './retention.ts';

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
  // Retention (owner decisions 2026-10-03), nightly, staggered. Each is idempotent and bounded.
  { name: 'retention-line-events', cron: '30 3 * * *', run: purgeLineEvents },
  { name: 'retention-orders', cron: '40 3 * * *', run: anonymizeOrders },
  { name: 'retention-recipients', cron: '50 3 * * *', run: expireRecipients },
  // Followers and app visitors who never ordered or acknowledged the notice.
  { name: 'retention-line-customers', cron: '55 3 * * *', run: expireEmptyLineCustomers },
  // Invites of no use any more (they hold an e-mail).
  { name: 'retention-staff-invites', cron: '58 3 * * *', run: purgeStaffInvites },
  // Transfer slip pictures, 90 days after the payment was confirmed or cancelled (file first, then the key).
  { name: 'retention-slips', cron: '5 4 * * *', run: purgeSlips },
  // Slip files no payment points to (after the purge above), older than a day.
  { name: 'retention-slip-orphans', cron: '15 4 * * *', run: sweepOrphanSlips },
];
