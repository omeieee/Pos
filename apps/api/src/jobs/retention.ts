import { insertAudit, retentionRepo } from '@sds/db';
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

/** Invites that were accepted, revoked or expired more than 30 days ago. */
export async function purgeStaffInvites(deps: JobDeps, bounds: Bounds = {}) {
  const before = cutoff(deps, RETENTION_DAYS.staffInvites);
  const deleted = await drain(bounds, (limit) =>
    retentionRepo.purgeStaffInvitesBatch(deps.db, { before, limit, now: deps.now() }),
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

/** A slip file is written just before its payment row points to it: younger files are left alone. */
export const SLIP_ORPHAN_GRACE_MS = 86_400_000;

/**
 * Slip files that no payment points to (an upload that failed half way, a crash between the file
 * and the row) and that are older than the grace period. Looks at no more than `size` x
 * `maxBatches` files per run, oldest first. Counts only.
 */
export async function sweepOrphanSlips(deps: JobDeps, bounds: Bounds = {}) {
  const size = bounds.batchSize ?? RETENTION_BATCH.size;
  const maxBatches = bounds.maxBatches ?? RETENTION_BATCH.maxBatches;
  const olderThan = deps.now().getTime() - SLIP_ORPHAN_GRACE_MS;
  const old = (await deps.slips.list())
    .filter((file) => file.modifiedAt.getTime() < olderThan)
    .sort((a, b) => a.modifiedAt.getTime() - b.modifiedAt.getTime())
    .slice(0, size * maxBatches);
  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < old.length; i += size) {
    const keys = old.slice(i, i + size).map((file) => file.key);
    const referenced = await retentionRepo.findReferencedSlipKeys(deps.db, keys);
    for (const key of keys) {
      if (referenced.has(key)) continue;
      try {
        await deps.slips.delete(key);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
  }
  // One `system` audit row per run that did something: counts only, never a key.
  if (deleted > 0 || failed > 0) {
    await insertAudit(deps.db, {
      actorType: 'system',
      action: 'retention.slip_orphans.delete',
      entity: 'slip_files',
      after: { deleted, failed },
    });
  }
  return { deleted, failed };
}

/**
 * Slip images of payments confirmed, cancelled, or left claimed, more than 90 days ago. The FILE is deleted
 * first and the key cleared after: a file that will not go keeps its key and is tried again at
 * the next run, so a failure can never leave an image that nothing points to. Counts only.
 */
export async function purgeSlips(deps: JobDeps, bounds: Bounds = {}) {
  const before = cutoff(deps, RETENTION_DAYS.slipImages);
  const size = bounds.batchSize ?? RETENTION_BATCH.size;
  const maxBatches = bounds.maxBatches ?? RETENTION_BATCH.maxBatches;
  let deleted = 0;
  let failed = 0;
  // Skipped ids are not selected again in this run, so one stuck file cannot spin the loop.
  const skipped = new Set<string>();
  for (let i = 0; i < maxBatches; i++) {
    const due = (
      await retentionRepo.findDueSlips(deps.db, { before, limit: size + skipped.size })
    ).filter((slip) => !skipped.has(slip.id));
    if (due.length === 0) break;
    const gone: { id: string; key: string }[] = [];
    for (const slip of due.slice(0, size)) {
      try {
        await deps.slips.delete(slip.key);
        gone.push(slip);
      } catch {
        skipped.add(slip.id);
        failed += 1;
      }
    }
    deleted += await retentionRepo.clearSlipKeys(deps.db, { slips: gone, now: deps.now() });
    if (gone.length < size) break;
  }
  return { deleted, failed };
}
