/**
 * Recipient memory (owner, 2026-10-02): every entrance-delivery order remembers who it was for, so
 * the next order can show "Building B1, Fah" and let staff add details. Counter and phone
 * recipients are matched by (building, name key); a LINE customer is keyed by `line_user_id` and
 * is only ever updated, never matched by name. The name key is `recipientKey()` from `@sds/shared`,
 * computed by the caller. This is personal data (PDPA): rows are cleared on anonymisation, and
 * `listRecipients` returns nothing but the five fields staff need.
 */
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.ts';
import { customers } from './schema.ts';

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
