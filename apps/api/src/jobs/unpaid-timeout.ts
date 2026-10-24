import { ordersRepo } from '@sds/db';
import { cancelUnpaidOrder } from '../orders/service.ts';
import { currentUnpaidTimeout } from '../settings/service.ts';
import type { JobDeps } from './jobs.ts';

/** Orders looked at per run; a larger backlog is worked off over the next runs (every 5 minutes). */
const BATCH = 50;

/**
 * D-41, every 5 minutes: while the setting is on, cancels LINE orders that are still `new`, are
 * paid by PromptPay and have no claimed, confirmed or slipped payment, once they are older than the
 * configured minutes. One transaction per order; one that fails (a payment arrived meanwhile) is
 * skipped and never stops the rest. Sends no LINE message. Returns counts only.
 */
export async function cancelUnpaidOrders(deps: JobDeps): Promise<Record<string, number>> {
  try {
    const setting = await currentUnpaidTimeout(deps.db);
    if (!setting.enabled) return { cancelled: 0, skipped: 0, failed: 0 };
    const cutoff = new Date(deps.now().getTime() - setting.minutes * 60_000);
    const candidates = await ordersRepo.listNewLineOrdersPlacedBefore(deps.db, cutoff, BATCH);
    let cancelled = 0;
    let skipped = 0;
    let failed = 0;
    for (const order of candidates) {
      try {
        if (await cancelUnpaidOrder(deps, order.id, cutoff)) cancelled += 1;
        else skipped += 1;
      } catch {
        failed += 1;
      }
    }
    return { cancelled, skipped, failed };
  } catch {
    return { cancelled: 0, skipped: 0, failed: 1 };
  }
}
