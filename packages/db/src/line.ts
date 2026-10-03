/**
 * The LINE module's tables: webhook dedupe (`line_events`), the message log and the monthly push
 * counter, and the few customer writes a LINE event causes. Personal data note (PDPA): a
 * `line_events` row holds the user id and a `route` of ids and fixed words, never chat text or a
 * reply token, and is deleted 30 days after it arrived (`retention.ts`).
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { customers, lineEvents, lineMessageLog, lineQuotaMonths } from './schema.ts';

/**
 * Records a webhook event by its `webhookEventId`. True when it is new, false when LINE sent it
 * before (a redelivery): the primary key makes this one atomic statement.
 */
export async function insertEventIfNew(
  db: Db,
  event: { webhookEventId: string; type: string; userId?: string; route: unknown },
): Promise<boolean> {
  const rows = await db
    .insert(lineEvents)
    .values({
      webhookEventId: event.webhookEventId,
      type: event.type,
      userId: event.userId ?? null,
      route: event.route,
    })
    .onConflictDoNothing({ target: lineEvents.webhookEventId })
    .returning({ id: lineEvents.webhookEventId });
  return rows.length > 0;
}

/** Marks an event handled. `error` is a short class name, never a message or a payload. */
export async function markEventProcessed(
  db: Db,
  webhookEventId: string,
  at: Date,
  error?: string,
): Promise<void> {
  await db
    .update(lineEvents)
    .set({ processedAt: at, error: error ?? null })
    .where(eq(lineEvents.webhookEventId, webhookEventId));
}

export interface RetryableEvent {
  webhookEventId: string;
  type: string;
  userId: string | null;
  route: unknown;
  receivedAt: Date;
}

/**
 * Takes the events the retry sweep should run now: stored with a route, never handled or handled
 * with an error, old enough not to race the live handler and recent enough to still matter, and
 * not yet tried `maxAttempts` times. Each one's `attempts` goes up by one in the same statement,
 * so an event that keeps crashing the process still runs out of attempts. Oldest first.
 */
export async function claimRetryableEvents(
  db: Db,
  args: { receivedBefore: Date; receivedAfter: Date; maxAttempts: number; limit: number },
): Promise<RetryableEvent[]> {
  const candidates = db
    .select({ id: lineEvents.webhookEventId })
    .from(lineEvents)
    .where(
      and(
        isNotNull(lineEvents.route),
        or(isNull(lineEvents.processedAt), isNotNull(lineEvents.error)),
        sql`${lineEvents.attempts} < ${args.maxAttempts}`,
        lte(lineEvents.receivedAt, args.receivedBefore),
        gt(lineEvents.receivedAt, args.receivedAfter),
      ),
    )
    .orderBy(asc(lineEvents.receivedAt))
    .limit(args.limit);
  const rows = await db
    .update(lineEvents)
    .set({ attempts: sql`${lineEvents.attempts} + 1` })
    .where(inArray(lineEvents.webhookEventId, candidates))
    .returning({
      webhookEventId: lineEvents.webhookEventId,
      type: lineEvents.type,
      userId: lineEvents.userId,
      route: lineEvents.route,
      receivedAt: lineEvents.receivedAt,
    });
  return rows.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
}

/**
 * True when LINE delivered a later follow or unfollow for the same user: the older one must not
 * be applied again, or it would undo what the later one set.
 */
export async function hasLaterFollowEvent(
  db: Db,
  event: { webhookEventId: string; userId: string; receivedAt: Date },
): Promise<boolean> {
  const [row] = await db
    .select({ id: lineEvents.webhookEventId })
    .from(lineEvents)
    .where(
      and(
        eq(lineEvents.userId, event.userId),
        inArray(lineEvents.type, ['follow', 'unfollow']),
        gt(lineEvents.receivedAt, event.receivedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** A new or returning follower. Clears `unfollowed_at`. Returns the customer id. */
export async function upsertFollower(db: Db, lineUserId: string): Promise<string> {
  const [row] = await db
    .insert(customers)
    .values({ lineUserId })
    .onConflictDoUpdate({ target: customers.lineUserId, set: { unfollowedAt: null } })
    .returning({ id: customers.id });
  if (!row) throw new Error('customer upsert returned no row');
  return row.id;
}

export async function markUnfollowed(db: Db, lineUserId: string, at: Date): Promise<void> {
  await db.update(customers).set({ unfollowedAt: at }).where(eq(customers.lineUserId, lineUserId));
}

/**
 * Stores that the customer acknowledged the privacy notice. The first acknowledgement stays: a
 * second tap does not move the time. Creates the customer if the "I understand" button came
 * before a follow event was seen. Returns the customer id.
 */
export async function acknowledgePrivacy(db: Db, lineUserId: string, at: Date): Promise<string> {
  const [row] = await db
    .insert(customers)
    .values({ lineUserId, privacyAckAt: at })
    .onConflictDoUpdate({
      target: customers.lineUserId,
      set: {
        privacyAckAt: sql`coalesce(${customers.privacyAckAt}, ${at.toISOString()}::timestamptz)`,
      },
    })
    .returning({ id: customers.id });
  if (!row) throw new Error('customer upsert returned no row');
  return row.id;
}

class RollbackReservation extends Error {
  constructor(readonly reason: 'capped' | 'duplicate') {
    super(reason);
  }
}

export type PushReservation =
  | { status: 'reserved'; used: number; logId: string }
  | { status: 'capped' }
  | { status: 'duplicate' };

/**
 * Takes one unit of the month's quota and writes the counted log row, in one transaction. The
 * counter upsert only succeeds while `used < limit`, so concurrent callers cannot pass the cap;
 * the unique index on (order, template) turns a second push for the same order into `duplicate`
 * and rolls the unit back.
 */
export async function reservePush(
  db: Db,
  args: { month: string; limit: number; template: string; customerId?: string; orderId?: string },
): Promise<PushReservation> {
  try {
    return await db.transaction(async (tx) => {
      const [counter] = await tx
        .insert(lineQuotaMonths)
        .values({ month: args.month, used: 1 })
        .onConflictDoUpdate({
          target: lineQuotaMonths.month,
          set: { used: sql`${lineQuotaMonths.used} + 1`, updatedAt: sql`now()` },
          setWhere: sql`${lineQuotaMonths.used} < ${args.limit}`,
        })
        .returning({ used: lineQuotaMonths.used });
      if (!counter) throw new RollbackReservation('capped');

      const [log] = await tx
        .insert(lineMessageLog)
        .values({
          kind: 'push',
          template: args.template,
          customerId: args.customerId ?? null,
          orderId: args.orderId ?? null,
          counted: true,
        })
        .onConflictDoNothing()
        .returning({ id: lineMessageLog.id });
      if (!log) throw new RollbackReservation('duplicate');
      return { status: 'reserved', used: counter.used, logId: log.id } as const;
    });
  } catch (error) {
    if (error instanceof RollbackReservation) return { status: error.reason };
    throw error;
  }
}

/** LINE refused the push: remove its log row and give the unit back. */
export async function releasePush(db: Db, args: { month: string; logId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(lineMessageLog)
      .where(and(eq(lineMessageLog.id, args.logId), eq(lineMessageLog.kind, 'push')))
      .returning({ id: lineMessageLog.id });
    if (removed.length === 0) return;
    await tx
      .update(lineQuotaMonths)
      .set({ used: sql`greatest(${lineQuotaMonths.used} - 1, 0)`, updatedAt: sql`now()` })
      .where(eq(lineQuotaMonths.month, args.month));
  });
}

/** A free reply, logged as uncounted. */
export async function logReply(
  db: Db,
  args: { template: string; customerId?: string; orderId?: string },
): Promise<void> {
  await db.insert(lineMessageLog).values({
    kind: 'reply',
    template: args.template,
    customerId: args.customerId ?? null,
    orderId: args.orderId ?? null,
    counted: false,
  });
}

/** Pushes used so far in `month` (0 when none were sent). */
export async function getMonthUsage(db: Db, month: string): Promise<number> {
  const [row] = await db
    .select({ used: lineQuotaMonths.used })
    .from(lineQuotaMonths)
    .where(eq(lineQuotaMonths.month, month))
    .limit(1);
  return row?.used ?? 0;
}
