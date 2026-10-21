import { printRepo } from '@sds/db';
import { securityAlert } from '../auth/service.ts';
import { currentPrintingEnabled } from '../settings/service.ts';
import type { JobDeps } from './jobs.ts';

/** A kitchen ticket that nobody has claimed for this long means the print notebook is silent. */
export const PRINT_AGENT_SILENT_MINUTES = 3;
/** While the silence lasts, staff are told again only after this long. */
export const PRINT_AGENT_SILENT_REALERT_MINUTES = 30;

/**
 * When the last `print.agent_silent` alert went out; null once the queue has been clear since.
 * Kept in memory on purpose: one API process runs the jobs, and after a restart a still-silent
 * queue is simply told once more.
 */
let lastAlertAt: Date | null = null;

/** Tests only. */
export function resetPrintAgentSilentState(): void {
  lastAlertAt = null;
}

/**
 * Every two minutes: while printing is on, is some ticket waiting that no print program has
 * claimed for 3 minutes? Then one `warn` alert (no names, no order, no figures). It is not
 * repeated on the next runs; it comes again after 30 minutes of the same silence, or once the
 * queue has been clear in between. Returns counts only (they are logged by the job runner).
 */
export async function checkPrintAgentSilent(deps: JobDeps): Promise<Record<string, number>> {
  const now = deps.now();
  const waiting = (await currentPrintingEnabled(deps.db))
    ? await printRepo.countUnclaimedSince(
        deps.db,
        new Date(now.getTime() - PRINT_AGENT_SILENT_MINUTES * 60_000),
      )
    : 0;
  if (waiting === 0) {
    lastAlertAt = null;
    return { waiting, alerts: 0 };
  }
  if (
    lastAlertAt !== null &&
    now.getTime() - lastAlertAt.getTime() < PRINT_AGENT_SILENT_REALERT_MINUTES * 60_000
  ) {
    return { waiting, alerts: 0 };
  }
  lastAlertAt = now;
  deps.events.publish(securityAlert({ now: deps.now }, 'print.agent_silent', 'warn', {}));
  return { waiting, alerts: 1 };
}
