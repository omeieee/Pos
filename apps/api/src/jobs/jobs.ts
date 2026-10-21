import { type LineJobDeps, retryLineEvents } from '../line/retry.ts';
import { activeSlipChecker } from '../slips/checker.ts';
import type { SlipStore } from '../slips/store.ts';
import { checkPrintAgentSilent } from './print-agent-silent.ts';
import {
  anonymizeOrders,
  expireEmptyLineCustomers,
  expireMemberProfiles,
  expireRecipients,
  purgeButtonReplies,
  purgeLineEvents,
  purgeSlips,
  purgeStaffInvites,
  sweepOrphanSlips,
} from './retention.ts';
import { checkSlip2goAccount } from './slip2go.ts';
import { checkStorageUsage } from './storage-usage.ts';

/** What every job gets. Jobs are plain functions of this, so tests call them directly. */
export type JobDeps = LineJobDeps & {
  /** Where expense receipt photos live (D-36). No job deletes from it; the usage check only measures it. */
  receipts?: SlipStore;
};

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
  // Slips still waiting for the automatic amount reading (D-26): after a restart, or a full queue.
  // Without a reader (SLIP_OCR=off) there is nothing to do.
  {
    name: 'slip-check-sweep',
    cron: '* * * * *',
    run: async () => ({ read: (await activeSlipChecker()?.sweep()) ?? 0 }),
  },
  // The Slip2Go account (D-27): slips left and package end, 08:00 Bangkok. Not charged; a no-op when
  // the bank check is off.
  { name: 'slip2go-account-check', cron: '0 8 * * *', run: checkSlip2goAccount },
  // Printing is on and a kitchen ticket has waited 3 minutes with no print program claiming it: one
  // warn alert, repeated only after 30 minutes or after the queue was clear (D-37). No-op when off.
  { name: 'print-agent-silent-check', cron: '*/2 * * * *', run: checkPrintAgentSilent },
  // Retention (owner decisions 2026-10-03), nightly, staggered. Each is idempotent and bounded.
  { name: 'retention-line-events', cron: '30 3 * * *', run: purgeLineEvents },
  { name: 'retention-orders', cron: '40 3 * * *', run: anonymizeOrders },
  { name: 'retention-recipients', cron: '50 3 * * *', run: expireRecipients },
  // Followers and app visitors who never ordered or acknowledged the notice.
  { name: 'retention-line-customers', cron: '55 3 * * *', run: expireEmptyLineCustomers },
  // Member profile (name, nickname, phone, building) of customers with no order for 24 months.
  { name: 'retention-member-profiles', cron: '56 3 * * *', run: expireMemberProfiles },
  // Chat-button reply marks (once a day per button) older than a week.
  { name: 'retention-button-replies', cron: '57 3 * * *', run: purgeButtonReplies },
  // Invites of no use any more (they hold an e-mail).
  { name: 'retention-staff-invites', cron: '58 3 * * *', run: purgeStaffInvites },
  // Transfer slip pictures, 90 days after the payment was confirmed or cancelled (file first, then the key).
  { name: 'retention-slips', cron: '5 4 * * *', run: purgeSlips },
  // Slip files no payment points to (after the purge above), older than a day.
  { name: 'retention-slip-orphans', cron: '15 4 * * *', run: sweepOrphanSlips },
  // How much the slip and receipt stores hold against the free R2 quota (D-36); warns the owner at 70%.
  { name: 'storage-usage-check', cron: '30 4 * * *', run: checkStorageUsage },
];
