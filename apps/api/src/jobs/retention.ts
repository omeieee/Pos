import { retentionRepo } from '@sds/db';
import { RETENTION_DAYS } from '@sds/shared';
import type { JobDeps } from './jobs.ts';

/**
 * A run does at most `size` x `maxBatches` rows; the rest waits for the next run. One batch is one
 * transaction (see `@sds/db` retention.ts), so a long backlog never holds a long lock.
 */
export const RETENTION_BATCH = { size: 500, maxBatches: 20 } as const;

interface Bounds {
  batchSize?: number;
  maxBatches?: number;
}

const cutoff = (deps: JobDeps, days: number) => new Date(deps.now().getTime() - days * 86_400_000);

/** Runs `batch` until it changes fewer rows than a full batch or the run's limit is reached. */
async function drain(bounds: Bounds, batch: (limit: number) => Promise<number>): Promise<number> {
  const size = bounds.batchSize ?? RETENTION_BATCH.size;
  const maxBatches = bounds.maxBatches ?? RETENTION_BATCH.maxBatches;
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await batch(size);
    total += n;
    if (n < size) break;
  }
  return total;
}

/** `line_events` older than 30 days. */
export async function purgeLineEvents(deps: JobDeps, bounds: Bounds = {}) {
  const before = cutoff(deps, RETENTION_DAYS.lineEvents);
  const deleted = await drain(bounds, (limit) =>
    retentionRepo.purgeLineEventsBatch(deps.db, { before, limit, now: deps.now() }),
  );
  return { deleted };
}

/** Name and building on orders completed (or cancelled) more than 30 days ago. Amounts stay. */
export async function anonymizeOrders(deps: JobDeps, bounds: Bounds = {}) {
  const before = cutoff(deps, RETENTION_DAYS.orderPersonalData);
  const anonymized = await drain(bounds, (limit) =>
    retentionRepo.anonymizeOrderSnapshotsBatch(deps.db, { before, limit, now: deps.now() }),
  );
  return { anonymized };
}

/** Remembered recipients whose last order was more than 30 days ago. */
export async function expireRecipients(deps: JobDeps, bounds: Bounds = {}) {
  const before = cutoff(deps, RETENTION_DAYS.recipientBook);
  const total = { customers: 0, orders: 0 };
  await drain(bounds, async (limit) => {
    const result = await retentionRepo.expireRecipientsBatch(deps.db, {
      before,
      limit,
      now: deps.now(),
    });
    total.customers += result.customers;
    total.orders += result.orders;
    return result.customers;
  });
  return total;
}

/** LINE customers who followed or opened the app 30+ days ago and never ordered or acknowledged. */
export async function expireEmptyLineCustomers(deps: JobDeps, bounds: Bounds = {}) {
  const before = cutoff(deps, RETENTION_DAYS.recipientBook);
  let customers = 0;
  await drain(bounds, async (limit) => {
    const result = await retentionRepo.expireEmptyLineCustomersBatch(deps.db, {
      before,
      limit,
      now: deps.now(),
    });
    customers += result.customers;
    return result.customers;
  });
  return { customers };
}
