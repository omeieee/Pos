/**
 * Schema: Web Push subscriptions (P8 phone alerts), one per device. Not a synced table: no rev or
 * version. The endpoint and keys are credentials-like (whoever holds them can push to that
 * browser): they are never returned by an API or written to a log.
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, ts } from './columns.ts';
import { devices, staff } from './people.ts';

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: id(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    /** Who was signed in when the device subscribed (information only; the device is the key). */
    staffId: uuid('staff_id').references(() => staff.id),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: ts('created_at').notNull(),
    lastSuccessAt: ts('last_success_at'),
    /** Consecutive sends the push service did not accept (not counting a refused key or payload). */
    failureCount: integer('failure_count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('push_subscriptions_device_id_key').on(t.deviceId),
    index('push_subscriptions_staff_id_idx').on(t.staffId),
    check('push_subscriptions_failure_count', sql`failure_count >= 0`),
  ],
);
