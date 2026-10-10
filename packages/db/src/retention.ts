/**
 * Retention (PDPA, owner decisions 2026-10-03). Each function does ONE bounded batch in ONE
 * transaction and returns what it changed; a batch that changed nothing writes nothing, so running
 * a job twice is harmless. A batch that changed something writes one `system` audit row with
 * counts and the retention period only: never a name, a building, a LINE id or a row id.
 *
 * - `purgeLineEventsBatch`: deletes `line_events` older than the cutoff.
 * - `anonymizeOrderSnapshotsBatch`: replaces recipient name, building and room number on
 *   finished orders (completed, or cancelled) and clears the delivery note. Amounts and items stay (tax records).
 *   The updates go through the sync trigger, so devices catch the change up by rev.
 * - `expireRecipientsBatch`: erases the remembered recipients (counter customers with a recipient)
 *   whose last order is older than the cutoff, the way the owner's erasure request does.
 *
 * - `findDueSlips` and `clearSlipKeys`: slip images (90 days after the payment was confirmed or
 *   cancelled). The files live outside the database, so the job deletes the file FIRST and only
 *   then clears the key here: a file that could not be deleted keeps its key and is tried again.
 */
import {
  ANONYMIZED_BUILDING,
  ANONYMIZED_RECIPIENT_NAME,
  ANONYMIZED_ROOM_NO,
  RETENTION_DAYS,
} from '@sds/shared';
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { insertAudit } from './audit.ts';
import type { Db } from './client.ts';
import { anonymizeCustomer } from './customers.ts';
import { customers, lineEvents, orders, payments, staffInvites } from './schema.ts';

/** Deletes up to `limit` events that arrived before `before`. Returns how many. */
export async function purgeLineEventsBatch(
  db: Db,
  args: { before: Date; limit: number; now: Date },
): Promise<number> {
  return db.transaction(async (tx) => {
    const old = tx
      .select({ id: lineEvents.webhookEventId })
      .from(lineEvents)
      .where(lt(lineEvents.receivedAt, args.before))
      .orderBy(asc(lineEvents.receivedAt))
      .limit(args.limit);
    const deleted = await tx
      .delete(lineEvents)
      .where(inArray(lineEvents.webhookEventId, old))
      .returning({ id: lineEvents.webhookEventId });
    if (deleted.length > 0) {
      await insertAudit(tx, {
        actorType: 'system',
        action: 'retention.line_events.purge',
        entity: 'line_events',
        after: { deleted: deleted.length, olderThanDays: RETENTION_DAYS.lineEvents },
      });
    }
    return deleted.length;
  });
}

/**
 * Deletes up to `limit` invites that ended (accepted, revoked, or expired) before `before`. An
 * invite holds an e-mail, so it is not kept once it is of no use. The audit row has counts only.
 */
export async function purgeStaffInvitesBatch(
  db: Db,
  args: { before: Date; limit: number; now: Date },
): Promise<number> {
  return db.transaction(async (tx) => {
    const endedAt = sql`coalesce(${staffInvites.acceptedAt}, ${staffInvites.revokedAt}, ${staffInvites.expiresAt})`;
    const old = tx
      .select({ id: staffInvites.id })
      .from(staffInvites)
      .where(sql`${endedAt} < ${args.before.toISOString()}::timestamptz`)
      .orderBy(asc(staffInvites.createdAt))
      .limit(args.limit);
    const deleted = await tx
      .delete(staffInvites)
      .where(inArray(staffInvites.id, old))
      .returning({ id: staffInvites.id });
    if (deleted.length > 0) {
      await insertAudit(tx, {
        actorType: 'system',
        action: 'retention.staff_invites.purge',
        entity: 'staff_invites',
        after: { deleted: deleted.length, olderThanDays: RETENTION_DAYS.staffInvites },
      });
    }
    return deleted.length;
  });
}

const isEntrance = sql`${orders.fulfillment} = 'entrance_delivery'`;
// What each personal column should hold once erased. The checks `orders_entrance_delivery_recipient`
// and `orders_room_delivery_room` need a value on those two kinds of order, so a stand-in text is
// written there; every other kind gets null.
const nameAfter = sql`case when ${isEntrance} then ${ANONYMIZED_RECIPIENT_NAME} else null end`;
const buildingAfter = sql`case when ${isEntrance} then ${ANONYMIZED_BUILDING} else null end`;
const roomAfter = sql`case when ${orders.fulfillment} = 'room_delivery' then ${ANONYMIZED_ROOM_NO} else null end`;

/**
 * Anonymises up to `limit` finished orders (completed or cancelled before `before`): recipient
 * name, building, room number and delivery note. An order whose columns already hold the erased
 * values is not selected, so a second run changes nothing and bumps no version.
 */
export async function anonymizeOrderSnapshotsBatch(
  db: Db,
  args: { before: Date; limit: number; now: Date },
): Promise<number> {
  return db.transaction(async (tx) => {
    const due = tx
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          inArray(orders.status, ['completed', 'cancelled']),
          sql`coalesce(${orders.completedAt}, ${orders.cancelledAt}) < ${args.before.toISOString()}::timestamptz`,
          or(
            sql`${orders.recipientName} is distinct from ${nameAfter}`,
            sql`${orders.deliveryBuilding} is distinct from ${buildingAfter}`,
            sql`${orders.roomNo} is distinct from ${roomAfter}`,
            isNotNull(orders.deliveryNote),
          ),
        ),
      )
      .orderBy(asc(orders.id))
      .limit(args.limit);
    const changed = await tx
      .update(orders)
      .set({
        recipientName: nameAfter,
        deliveryBuilding: buildingAfter,
        roomNo: roomAfter,
        deliveryNote: null,
      })
      .where(inArray(orders.id, due))
      .returning({ id: orders.id });
    if (changed.length > 0) {
      await insertAudit(tx, {
        actorType: 'system',
        action: 'retention.orders.anonymize',
        entity: 'orders',
        after: { anonymized: changed.length, afterDays: RETENTION_DAYS.orderPersonalData },
      });
    }
    return changed.length;
  });
}

/**
 * Erases up to `limit` remembered recipients whose last order (or, with no order, the day they
 * were saved) is before `before`. LINE customers, customers with no recipient (phone-only) and
 * customers with an open order are left alone. Their orders lose the name as in an erasure request.
 */
export async function expireRecipientsBatch(
  db: Db,
  args: { before: Date; limit: number; now: Date },
): Promise<{ customers: number; orders: number }> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          isNull(customers.anonymizedAt),
          isNull(customers.lineUserId),
          or(
            isNotNull(customers.building),
            isNotNull(customers.recipientName),
            isNotNull(customers.recipientKey),
          ),
          sql`coalesce(${customers.lastOrderAt}, ${customers.firstSeenAt}) < ${args.before.toISOString()}::timestamptz`,
          sql`not exists (select 1 from ${orders} where ${orders.customerId} = ${customers.id} and ${orders.status} in ('new', 'preparing', 'ready'))`,
        ),
      )
      .orderBy(asc(customers.id))
      .limit(args.limit)
      .for('update', { of: customers, skipLocked: true });

    let rewritten = 0;
    let erased = 0;
    for (const { id } of due) {
      const result = await anonymizeCustomer(tx, id, args.now);
      if (result.found && result.changed) {
        erased += 1;
        rewritten += result.orderIds.length;
      }
    }
    if (erased > 0) {
      await insertAudit(tx, {
        actorType: 'system',
        action: 'retention.recipients.expire',
        entity: 'customers',
        after: { customers: erased, orders: rewritten, afterDays: RETENTION_DAYS.recipientBook },
      });
    }
    return { customers: erased, orders: rewritten };
  });
}

/**
 * Erases up to `limit` LINE customers who never ordered and never acknowledged the privacy notice
 * and were first seen before `before` (30 days): people who followed the OA or opened the app and
 * went no further. The row stays anonymised (no LINE id) so nothing else breaks; one `system`
 * audit row says how many, never who.
 */
export async function expireEmptyLineCustomersBatch(
  db: Db,
  args: { before: Date; limit: number; now: Date },
): Promise<{ customers: number }> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          isNull(customers.anonymizedAt),
          isNotNull(customers.lineUserId),
          isNull(customers.privacyAckAt),
          lt(customers.firstSeenAt, args.before),
          sql`not exists (select 1 from ${orders} where ${orders.customerId} = ${customers.id})`,
        ),
      )
      .orderBy(asc(customers.id))
      .limit(args.limit)
      .for('update', { of: customers, skipLocked: true });
    let erased = 0;
    for (const { id } of due) {
      const result = await anonymizeCustomer(tx, id, args.now);
      if (result.found && result.changed) erased += 1;
    }
    if (erased > 0) {
      await insertAudit(tx, {
        actorType: 'system',
        action: 'retention.line_customers.expire',
        entity: 'customers',
        after: { customers: erased, afterDays: RETENTION_DAYS.recipientBook },
      });
    }
    return { customers: erased };
  });
}

/**
 * Payments that still hold a slip image key and ended before `before`: confirmed (the day staff
 * confirmed it, which a later void or refund does not move) or cancelled, voided or refunded
 * (the last change). A claimed payment (a slip that staff never confirmed or cancelled) is due
 * once it has not changed for that long, so it cannot keep a slip forever. Only the key goes: the
 * payment's status is never touched here.
 */
export async function findDueSlips(
  db: Db,
  args: { before: Date; limit: number },
): Promise<{ id: string; key: string }[]> {
  const rows = await db
    .select({ id: payments.id, key: payments.slipImageKey })
    .from(payments)
    .where(
      and(
        isNotNull(payments.slipImageKey),
        inArray(payments.status, ['confirmed', 'claimed', 'cancelled', 'voided', 'refunded']),
        sql`coalesce(${payments.confirmedAt}, ${payments.updatedAt}) < ${args.before.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(payments.id))
    .limit(args.limit);
  return rows.flatMap((r) => (r.key === null ? [] : [{ id: r.id, key: r.key }]));
}

/** Which of these slip keys some payment still points to (the orphan sweep deletes the others). */
export async function findReferencedSlipKeys(db: Db, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db
    .select({ key: payments.slipImageKey })
    .from(payments)
    .where(inArray(payments.slipImageKey, keys));
  return new Set(rows.flatMap((r) => (r.key === null ? [] : [r.key])));
}

/**
 * Clears the key of payments whose file is gone, in ONE transaction, and writes one `system`
 * audit row with the count and the retention period only. A payment whose key changed in the
 * meantime (a new slip) is left alone. The update goes through the sync trigger.
 */
export async function clearSlipKeys(
  db: Db,
  args: { slips: { id: string; key: string }[]; now: Date },
): Promise<number> {
  if (args.slips.length === 0) return 0;
  return db.transaction(async (tx) => {
    let cleared = 0;
    for (const slip of args.slips) {
      const done = await tx
        .update(payments)
        .set({ slipImageKey: null })
        .where(and(eq(payments.id, slip.id), eq(payments.slipImageKey, slip.key)))
        .returning({ id: payments.id });
      cleared += done.length;
    }
    if (cleared > 0) {
      await insertAudit(tx, {
        actorType: 'system',
        action: 'retention.slips.delete',
        entity: 'payments',
        after: { deleted: cleared, afterDays: RETENTION_DAYS.slipImages },
      });
    }
    return cleared;
  });
}
