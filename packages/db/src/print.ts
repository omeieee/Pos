/**
 * Queries for the kitchen print queue (P8). Rules (what a ticket holds, who may reprint, when a
 * job fails for good) stay in apps/api and packages/shared; every time comes in as an argument so
 * tests and the API use the same clock.
 */
import type { PrintErrorCode, PrintJobKind } from '@sds/shared';
import { and, count, desc, eq, inArray, lt, lte, max, ne, or, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { orders, printJobs } from './schema.ts';

export type PrintJobRow = typeof printJobs.$inferSelect;

export interface NewPrintJob {
  orderId: string;
  kind: PrintJobKind;
  /** 0 for a kitchen job; a reprint takes `nextReprintSeq`. */
  seq: number;
  clientRequestId?: string | undefined;
  requestedByStaffId?: string | undefined;
  now: Date;
}

/**
 * Inserts a pending job, or returns undefined when the order already has a job with that kind and
 * sequence (or the request id was used): the unique indexes make the insert idempotent.
 */
export async function insertJob(db: Db, input: NewPrintJob): Promise<PrintJobRow | undefined> {
  const [row] = await db
    .insert(printJobs)
    .values({
      orderId: input.orderId,
      kind: input.kind,
      seq: input.seq,
      clientRequestId: input.clientRequestId ?? null,
      requestedByStaffId: input.requestedByStaffId ?? null,
      nextAttemptAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

/** The sequence number of the order's next reprint. Call it while holding the order row lock. */
export async function nextReprintSeq(db: Db, orderId: string): Promise<number> {
  const [row] = await db
    .select({ last: max(printJobs.seq) })
    .from(printJobs)
    .where(and(eq(printJobs.orderId, orderId), eq(printJobs.kind, 'reprint')));
  return (row?.last ?? 0) + 1;
}

export async function findById(db: Db, id: string): Promise<PrintJobRow | undefined> {
  const [row] = await db.select().from(printJobs).where(eq(printJobs.id, id)).limit(1);
  return row;
}

export async function findByClientRequestId(
  db: Db,
  clientRequestId: string,
): Promise<PrintJobRow | undefined> {
  const [row] = await db
    .select()
    .from(printJobs)
    .where(eq(printJobs.clientRequestId, clientRequestId))
    .limit(1);
  return row;
}

/** Locks the job row until the transaction ends, so two acks of one job queue up. */
export async function lockById(db: Db, id: string): Promise<PrintJobRow | undefined> {
  const [row] = await db
    .select()
    .from(printJobs)
    .where(eq(printJobs.id, id))
    .for('update')
    .limit(1);
  return row;
}

/**
 * Marks failed the jobs whose lease ran out after their last allowed attempt (a print program
 * that keeps dying on one job). Returns them so the caller can alert.
 */
export async function failExhausted(
  db: Db,
  input: { now: Date; maxAttempts: number },
): Promise<PrintJobRow[]> {
  return db
    .update(printJobs)
    .set({
      status: 'failed',
      lastError: 'LEASE_EXPIRED',
      leaseUntil: null,
      leaseToken: null,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(printJobs.status, 'claimed'),
        lt(printJobs.leaseUntil, input.now),
        sql`${printJobs.attempts} >= ${input.maxAttempts}`,
      ),
    )
    .returning();
}

/**
 * Finishes, without printing, the kitchen jobs that wait (or whose lease ran out) for an order
 * that was cancelled since. Marked failed with `ORDER_CANCELLED`; the caller raises no alert for
 * these. A reprint is a staff request for paper and is left alone. Returns how many were skipped.
 */
export async function skipCancelledOrders(db: Db, now: Date): Promise<number> {
  const rows = await db
    .update(printJobs)
    .set({
      status: 'failed',
      lastError: 'ORDER_CANCELLED',
      leaseUntil: null,
      leaseToken: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(printJobs.kind, 'kitchen'),
        or(
          eq(printJobs.status, 'pending'),
          and(eq(printJobs.status, 'claimed'), lt(printJobs.leaseUntil, now)),
        ),
        inArray(
          printJobs.orderId,
          db.select({ id: orders.id }).from(orders).where(eq(orders.status, 'cancelled')),
        ),
      ),
    )
    .returning({ id: printJobs.id });
  return rows.length;
}

/**
 * Jobs no print program has ever claimed (`attempts` 0) that have waited since before `olderThan`,
 * not counting a kitchen job of a cancelled order (it will be skipped). A job that was claimed and
 * is waiting for its back-off is not silence: the program is there.
 */
export async function countUnclaimedSince(db: Db, olderThan: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(printJobs)
    .innerJoin(orders, eq(orders.id, printJobs.orderId))
    .where(
      and(
        eq(printJobs.status, 'pending'),
        eq(printJobs.attempts, 0),
        lt(printJobs.createdAt, olderThan),
        sql`not (${printJobs.kind} = 'kitchen' and ${orders.status} = 'cancelled')`,
      ),
    );
  return row?.n ?? 0;
}

/**
 * Leases the oldest job that is due: a pending one whose back-off is over, or a claimed one whose
 * lease ran out with attempts left. `SKIP LOCKED` keeps two callers from taking the same row. Run
 * it inside a transaction.
 */
export async function claimNext(
  db: Db,
  input: {
    deviceId: string;
    leaseToken: string;
    now: Date;
    leaseUntil: Date;
    maxAttempts: number;
  },
): Promise<PrintJobRow | undefined> {
  const [candidate] = await db
    .select({ id: printJobs.id })
    .from(printJobs)
    .where(
      or(
        and(eq(printJobs.status, 'pending'), lte(printJobs.nextAttemptAt, input.now)),
        and(
          eq(printJobs.status, 'claimed'),
          lt(printJobs.leaseUntil, input.now),
          sql`${printJobs.attempts} < ${input.maxAttempts}`,
        ),
      ),
    )
    .orderBy(printJobs.createdAt, printJobs.id)
    .limit(1)
    .for('update', { skipLocked: true });
  if (!candidate) return undefined;
  const [row] = await db
    .update(printJobs)
    .set({
      status: 'claimed',
      claimedByDeviceId: input.deviceId,
      leaseToken: input.leaseToken,
      leaseUntil: input.leaseUntil,
      attempts: sql`${printJobs.attempts} + 1`,
      updatedAt: input.now,
    })
    .where(eq(printJobs.id, candidate.id))
    .returning();
  return row;
}

/** Stamps the job printed. Undefined when it already was: an ack is safe to repeat. */
export async function markPrinted(db: Db, id: string, now: Date): Promise<PrintJobRow | undefined> {
  const [row] = await db
    .update(printJobs)
    .set({ status: 'printed', printedAt: now, leaseUntil: null, leaseToken: null, updatedAt: now })
    .where(and(eq(printJobs.id, id), ne(printJobs.status, 'printed')))
    .returning();
  return row;
}

/** Puts a failed attempt back to pending, not to be claimed before `nextAttemptAt`. */
export async function releaseForRetry(
  db: Db,
  id: string,
  input: { now: Date; nextAttemptAt: Date; errorCode: PrintErrorCode },
): Promise<PrintJobRow | undefined> {
  const [row] = await db
    .update(printJobs)
    .set({
      status: 'pending',
      lastError: input.errorCode,
      nextAttemptAt: input.nextAttemptAt,
      leaseUntil: null,
      leaseToken: null,
      updatedAt: input.now,
    })
    .where(eq(printJobs.id, id))
    .returning();
  return row;
}

export async function markFailed(
  db: Db,
  id: string,
  input: { now: Date; errorCode: PrintErrorCode },
): Promise<PrintJobRow | undefined> {
  const [row] = await db
    .update(printJobs)
    .set({
      status: 'failed',
      lastError: input.errorCode,
      leaseUntil: null,
      leaseToken: null,
      updatedAt: input.now,
    })
    .where(eq(printJobs.id, id))
    .returning();
  return row;
}

/** The newest jobs with their order numbers, for the staff list. */
export async function listRecent(
  db: Db,
  limit: number,
): Promise<{ job: PrintJobRow; orderNo: string }[]> {
  return db
    .select({ job: printJobs, orderNo: orders.orderNo })
    .from(printJobs)
    .innerJoin(orders, eq(orders.id, printJobs.orderId))
    .orderBy(desc(printJobs.createdAt), desc(printJobs.id))
    .limit(limit);
}
