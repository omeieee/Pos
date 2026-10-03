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
 * Not here: slip images (90 days). Nothing stores a slip image yet (`payments.slip_image_key` is
 * never written), so there is nothing to delete; add the job with the upload.
 */
import {
  ANONYMIZED_BUILDING,
  ANONYMIZED_RECIPIENT_NAME,
  ANONYMIZED_ROOM_NO,
  RETENTION_DAYS,
} from '@sds/shared';
import { and, asc, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { insertAudit } from './audit.ts';
import type { Db } from './client.ts';
import { anonymizeCustomer } from './customers.ts';
import { customers, lineEvents, orders } from './schema.ts';

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
          lt(sql`coalesce(${orders.completedAt}, ${orders.cancelledAt})`, args.before),
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
          lt(sql`coalesce(${customers.lastOrderAt}, ${customers.firstSeenAt})`, args.before),
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
