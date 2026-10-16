/**
 * Schema: settings, LINE events and quota, the daily Slip2Go counter, and the audit log.
 */
import { AUDIT_ACTOR_TYPES } from '@sds/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, oneOf, sync, ts } from './columns.ts';
import { orders } from './orders.ts';
import { customers, devices, staff } from './people.ts';

// ---------- Settings, integration, audit ----------

export const settings = pgTable(
  'settings',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    updatedBy: uuid('updated_by').references(() => staff.id),
    ...sync,
  },
  (t) => [index('settings_rev_idx').on(t.rev), index('settings_updated_by_idx').on(t.updatedBy)],
);

/**
 * Webhook dedupe and the retry queue. Personal data (PDPA): a row holds NO raw event, so no chat
 * text and no reply token. `route` is what the router made of the event, cut to ids and fixed
 * words (kind, user id, order id, message id, keyword name), enough to run the handler again.
 * Rows are deleted 30 days after `received_at` (retention job).
 */
export const lineEvents = pgTable('line_events', {
  webhookEventId: text('webhook_event_id').primaryKey(),
  type: text('type').notNull(),
  userId: text('user_id'),
  /** Always null now (the raw event is no longer stored). Dropped in a later contract migration. */
  payload: jsonb('payload'),
  route: jsonb('route'),
  receivedAt: ts('received_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
  error: text('error'),
  /** How many times the retry sweep has run this event (a first, live run is not counted). */
  attempts: integer('attempts').notNull().default(0),
});

/**
 * One row per customer, chat button and business day: the bot answers a rich-menu or keyword button
 * (menu, payment, contact, hours, status) once a day (owner, 2026-10-11). The primary key is the
 * gate: `insert ... on conflict do nothing` lets exactly one of two webhook deliveries reply.
 * Not personal data beyond the customer id; purged after a week.
 */
export const lineButtonReplies = pgTable(
  'line_button_replies',
  {
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    button: text('button').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    repliedAt: ts('replied_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.customerId, t.button, t.businessDate] }),
    index('line_button_replies_business_date_idx').on(t.businessDate),
  ],
);

/**
 * What Slip2Go cost or said today (D-27), one row per business date and kind: `calls` counts the
 * calls made (the daily cap counts here, because a new slip resets the payment's own columns);
 * `alert_account` and `alert_cap` are the owner alerts, sent once a day (the primary key is the
 * gate). Numbers only, no personal data.
 */
export const slipVerifyDaily = pgTable(
  'slip_verify_daily',
  {
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    kind: text('kind').notNull(),
    n: integer('n').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.businessDate, t.kind] }),
    check('slip_verify_daily_kind', oneOf('kind', ['calls', 'alert_account', 'alert_cap'])),
  ],
);

export const lineMessageLog = pgTable(
  'line_message_log',
  {
    id: id(),
    customerId: uuid('customer_id').references(() => customers.id),
    kind: text('kind').notNull(),
    template: text('template').notNull(),
    orderId: uuid('order_id').references(() => orders.id),
    counted: boolean('counted').notNull(),
    sentAt: ts('sent_at').notNull().defaultNow(),
  },
  (t) => [
    index('line_message_log_sent_at_idx').on(t.sentAt),
    index('line_message_log_customer_id_idx').on(t.customerId),
    index('line_message_log_order_id_idx').on(t.orderId),
    check('line_message_log_kind', sql`kind in ('reply', 'push')`),
    // One push per order and template (the "ready + receipt" push goes out once).
    uniqueIndex('line_message_log_one_push_per_order')
      .on(t.orderId, t.template)
      .where(sql`kind = 'push' and order_id is not null`),
  ],
);

/**
 * Pushes used in a LINE plan month (`YYYY-MM`, Asia/Bangkok). The quota-aware sender takes one
 * unit with a single guarded upsert, so two orders cannot both take the last message. Not a
 * synced table: it is a counter, read by `GET /v1/line/quota`.
 */
export const lineQuotaMonths = pgTable('line_quota_months', {
  month: text('month').primaryKey(),
  used: integer('used').notNull().default(0),
  /** When the owner was told the month reached the warning level / the limit (once each). */
  warnAlertedAt: ts('warn_alerted_at'),
  capAlertedAt: ts('cap_alerted_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    at: ts('at').notNull().defaultNow(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    deviceId: uuid('device_id').references(() => devices.id),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
  },
  (t) => [
    index('audit_log_at_idx').on(t.at),
    index('audit_log_device_id_idx').on(t.deviceId),
    index('audit_log_entity_idx').on(t.entity, t.entityId),
    check('audit_log_actor_type', oneOf('actor_type', AUDIT_ACTOR_TYPES)),
  ],
);
