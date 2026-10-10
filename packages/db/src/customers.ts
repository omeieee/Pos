/**
 * Recipient memory (owner, 2026-10-02): every entrance-delivery order remembers who it was for, so
 * the next order can show "Building B1, Fah" and let staff add details. Counter and phone
 * recipients are matched by (building, name key); a LINE customer is keyed by `line_user_id` and
 * is only ever linked to an order, never matched by name and never given recipient details. The
 * name key is `recipientKey()` from `@sds/shared`, computed by the caller.
 *
 * This is personal data (PDPA). `anonymizeCustomer` below erases it on request (owner-only route
 * `POST /v1/customers/{id}/anonymize`). The retention job `expireRecipientsBatch` (retention.ts)
 * erases a recipient 30 days after their last order (owner, 2026-10-03), or the owner does it on
 * request. `listRecipients` returns nothing but the five fields staff need.
 */
import { ANONYMIZED_RECIPIENT_NAME, type MemberProfile } from '@sds/shared';
import { and, desc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { customers, orders, payments } from './schema.ts';

export interface RecipientDetails {
  building: string;
  recipientName: string;
  /** `recipientKey(recipientName)`. */
  recipientKey: string;
  deliveryNote: string | null;
}

/**
 * Finds or creates the customer for an entrance-delivery order and records the order on them, in
 * the caller's transaction: last-used note, `last_order_at`, and `order_count` + 1
 * (`total_spent_satang` is left for the reports). Returns the customer id for the order. A
 * replayed request never gets here, so nothing counts twice; a rolled-back order takes its
 * customer and count with it.
 *
 * `customerId` comes from the client, so it is a hint and never a licence to write recipient
 * details onto someone (reviewer M1, 2026-10-02):
 * - a LINE customer is only LINKED to the order (`last_order_at`, `order_count`); building, name,
 *   note and key are never written onto it;
 * - a counter customer is used only when the order is for the same recipient it already holds
 *   (same building and key), and then only the last-used spelling and note are refreshed;
 * - in every other case (unknown or anonymised id, a different recipient, a customer with no
 *   recipient yet) the id is ignored and the order goes to the customer for (building, key). A
 *   saved recipient is never renamed implicitly.
 *
 * The (building, key) of an existing row therefore never changes here, so no update can hit the
 * unique index; the only statement that can race is the upsert, which is one atomic
 * `INSERT ... ON CONFLICT DO UPDATE` on the unique (building, key) index of counter customers, so
 * two orders at once cannot make two rows and neither fails.
 */
export async function recordRecipientOrder(
  db: Db,
  recipient: RecipientDetails,
  orderedAt: Date,
  customerId?: string,
): Promise<string> {
  const counted = { lastOrderAt: orderedAt, orderCount: sql`${customers.orderCount} + 1` };
  const used = {
    ...counted,
    recipientName: recipient.recipientName,
    deliveryNote: recipient.deliveryNote,
  };

  if (customerId) {
    const [existing] = await db
      .select({
        id: customers.id,
        lineUserId: customers.lineUserId,
        building: customers.building,
        recipientKey: customers.recipientKey,
      })
      .from(customers)
      .where(and(eq(customers.id, customerId), isNull(customers.anonymizedAt)))
      .for('update')
      .limit(1);
    if (existing?.lineUserId != null) {
      await db.update(customers).set(counted).where(eq(customers.id, existing.id));
      return existing.id;
    }
    if (
      existing &&
      existing.building === recipient.building &&
      existing.recipientKey === recipient.recipientKey
    ) {
      await db.update(customers).set(used).where(eq(customers.id, existing.id));
      return existing.id;
    }
  }

  const [row] = await db
    .insert(customers)
    .values({
      building: recipient.building,
      recipientKey: recipient.recipientKey,
      ...used,
      orderCount: 1,
    })
    .onConflictDoUpdate({
      target: [customers.building, customers.recipientKey],
      targetWhere: sql`line_user_id is null`,
      set: used,
    })
    .returning({ id: customers.id });
  if (!row) throw new Error('recipient upsert returned no row');
  return row.id;
}

/** The member profile saved on a live customer (all null when none, or for an unknown id). */
export async function getMemberProfile(db: Db, customerId: string): Promise<MemberProfile> {
  const [row] = await db
    .select({
      fullName: customers.fullName,
      nickname: customers.nickname,
      building: customers.memberBuilding,
      phone: customers.phone,
    })
    .from(customers)
    .where(and(eq(customers.id, customerId), isNull(customers.anonymizedAt)))
    .limit(1);
  return row ?? { fullName: null, nickname: null, building: null, phone: null };
}

/**
 * Saves the member profile on a live customer, in the caller's transaction. Writes nothing when
 * nothing changed, so a repeated form does not bump the customer's rev and version.
 */
export async function saveMemberProfile(
  db: Db,
  customerId: string,
  profile: MemberProfile,
): Promise<void> {
  const saved = await getMemberProfile(db, customerId);
  if (
    saved.fullName === profile.fullName &&
    saved.nickname === profile.nickname &&
    saved.building === profile.building &&
    saved.phone === profile.phone
  ) {
    return;
  }
  await db
    .update(customers)
    .set({
      fullName: profile.fullName,
      nickname: profile.nickname,
      memberBuilding: profile.building,
      phone: profile.phone,
    })
    .where(and(eq(customers.id, customerId), isNull(customers.anonymizedAt)));
}

export type AnonymizeResult =
  | { found: false }
  | {
      found: true;
      /** False when the customer was already anonymised: nothing was written. */
      changed: boolean;
      anonymizedAt: Date;
      version: number;
      /** The orders that were rewritten (and so have a new rev), for the live feed. */
      orderIds: string[];
    };

/**
 * PDPA erasure of one customer, in the caller's transaction. The customer row stays, with its
 * counters (`order_count`, `total_spent_satang`, dates) so the reports still add up, but every field
 * that identifies a person is cleared: LINE id, names, picture, phone, room, note and the saved
 * recipient (building, name, note, key). `anonymized_at` marks it, so it is never matched, listed
 * or used by a new order again.
 *
 * The customer's ORDERS are tax records and stay (rows, totals, items, `delivery_building`). Only
 * the person on them is erased: the member snapshot and `delivery_note` become null and `recipient_name` becomes
 * `ANONYMIZED_RECIPIENT_NAME` on entrance deliveries (the check `orders_entrance_delivery_recipient`
 * needs a non-empty name there, so the check stays as it is) and null elsewhere. The order's own
 * `note` (kitchen note) and `room_no` are not touched. The sync trigger gives each changed row a
 * new rev and version, so the change reaches the feed. Already anonymised: nothing is written.
 */
/**
 * Clears the slip image key of every payment on the customer's orders and returns the keys, so the
 * caller can delete the files once the transaction has committed (a customer's erasure includes
 * the pictures they sent: they show a bank name and account number).
 */
export async function takeCustomerSlipKeys(db: Db, customerId: string): Promise<string[]> {
  const held = await db
    .select({ id: payments.id, key: payments.slipImageKey })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(and(eq(orders.customerId, customerId), isNotNull(payments.slipImageKey)))
    .for('update', { of: payments });
  const keys: string[] = [];
  for (const row of held) {
    if (row.key === null) continue;
    await db.update(payments).set({ slipImageKey: null }).where(eq(payments.id, row.id));
    keys.push(row.key);
  }
  return keys;
}

export async function anonymizeCustomer(db: Db, id: string, at: Date): Promise<AnonymizeResult> {
  const [row] = await db
    .select({ anonymizedAt: customers.anonymizedAt, version: customers.version })
    .from(customers)
    .where(eq(customers.id, id))
    .for('update')
    .limit(1);
  if (!row) return { found: false };
  if (row.anonymizedAt) {
    return {
      found: true,
      changed: false,
      anonymizedAt: row.anonymizedAt,
      version: row.version,
      orderIds: [],
    };
  }
  const [updated] = await db
    .update(customers)
    .set({
      anonymizedAt: at,
      lineUserId: null,
      displayName: null,
      pictureUrl: null,
      nickname: null,
      phone: null,
      fullName: null,
      memberBuilding: null,
      roomNo: null,
      note: null,
      building: null,
      recipientName: null,
      deliveryNote: null,
      recipientKey: null,
    })
    .where(eq(customers.id, id))
    .returning({ version: customers.version });
  const rewritten = await db
    .update(orders)
    .set({
      recipientName: sql`case when ${orders.fulfillment} = 'entrance_delivery' then ${ANONYMIZED_RECIPIENT_NAME} else null end`,
      deliveryNote: null,
      memberFullName: null,
      memberNickname: null,
      memberBuilding: null,
      memberPhone: null,
    })
    .where(
      and(
        eq(orders.customerId, id),
        // Skip orders that already hold the erased text (the retention job may have got there first).
        or(
          isNotNull(orders.memberFullName),
          isNotNull(orders.memberNickname),
          isNotNull(orders.memberBuilding),
          isNotNull(orders.memberPhone),
          and(
            isNotNull(orders.recipientName),
            sql`${orders.recipientName} <> ${ANONYMIZED_RECIPIENT_NAME}`,
          ),
          isNotNull(orders.deliveryNote),
        ),
      ),
    )
    .returning({ id: orders.id });
  return {
    found: true,
    changed: true,
    anonymizedAt: at,
    version: updated?.version ?? row.version + 1,
    orderIds: rewritten.map((r) => r.id),
  };
}

/** What a staff screen may know about a remembered recipient. Never a phone, LINE id or history. */
export interface RecipientRow {
  id: string;
  building: string;
  recipientName: string;
  deliveryNote: string | null;
  lastOrderAt: Date | null;
}

const escapeLike = (text: string) => text.replace(/[\\%_]/gu, (c) => `\\${c}`);

/**
 * Remembered recipients, most recent first. `nameKey` is a `recipientKey()` fragment matched as
 * "contains" (case and spacing already folded); `%`, `_` and `\` in it are plain characters.
 * Anonymised customers and customers without recipient details never appear.
 */
export async function listRecipients(
  db: Db,
  filter: { nameKey?: string; building?: string; limit: number },
): Promise<RecipientRow[]> {
  const conditions = [
    isNotNull(customers.building),
    isNotNull(customers.recipientName),
    isNotNull(customers.recipientKey),
    isNull(customers.anonymizedAt),
  ];
  if (filter.building) conditions.push(eq(customers.building, filter.building));
  if (filter.nameKey) {
    conditions.push(
      sql`${customers.recipientKey} like ${`%${escapeLike(filter.nameKey)}%`} escape '\\'`,
    );
  }
  const rows = await db
    .select({
      id: customers.id,
      building: customers.building,
      recipientName: customers.recipientName,
      deliveryNote: customers.deliveryNote,
      lastOrderAt: customers.lastOrderAt,
    })
    .from(customers)
    .where(and(...conditions))
    .orderBy(sql`${customers.lastOrderAt} desc nulls last`, desc(customers.id))
    .limit(filter.limit);
  return rows.map((r) => ({
    id: r.id,
    building: r.building ?? '',
    recipientName: r.recipientName ?? '',
    deliveryNote: r.deliveryNote,
    lastOrderAt: r.lastOrderAt,
  }));
}
