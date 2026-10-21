/**
 * Schema: the kitchen print queue (P8). Not a synced table: no rev or version, devices read it
 * through the print routes. It holds ids, counters and an error code only, never a ticket or a
 * customer detail (the ticket is built from the order when the print program claims the job).
 */
import { PRINT_ERROR_CODES, PRINT_JOB_KINDS, PRINT_JOB_STATUSES } from '@sds/shared';
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, oneOf, ts } from './columns.ts';
import { orders } from './orders.ts';
import { devices, staff } from './people.ts';

export const printJobs = pgTable(
  'print_jobs',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    kind: text('kind').notNull(),
    /**
     * 0 for the kitchen print; a reprint takes the next number, so one order and kind never has
     * two jobs with the same sequence (the unique index below is the idempotency of the queue).
     */
    seq: integer('seq').notNull().default(0),
    status: text('status').notNull().default('pending'),
    /** Claims so far, counting each claim of an expired lease. */
    attempts: integer('attempts').notNull().default(0),
    claimedByDeviceId: uuid('claimed_by_device_id').references(() => devices.id),
    leaseUntil: ts('lease_until'),
    /** Handed out with each claim; a failed ack must send it back. */
    leaseToken: uuid('lease_token'),
    /** A pending job is not claimed before this instant (retry back-off). */
    nextAttemptAt: ts('next_attempt_at').notNull(),
    /** A code from `PRINT_ERROR_CODES`, never text. */
    lastError: text('last_error'),
    /** The reprint request's id, so a retried request returns the same job. Null for kitchen jobs. */
    clientRequestId: uuid('client_request_id'),
    requestedByStaffId: uuid('requested_by_staff_id').references(() => staff.id),
    createdAt: ts('created_at').notNull(),
    printedAt: ts('printed_at'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('print_jobs_order_kind_seq_key').on(t.orderId, t.kind, t.seq),
    uniqueIndex('print_jobs_client_request_id_key').on(t.clientRequestId),
    index('print_jobs_claimed_by_device_id_idx').on(t.claimedByDeviceId),
    index('print_jobs_requested_by_staff_id_idx').on(t.requestedByStaffId),
    index('print_jobs_waiting_idx').on(t.createdAt).where(sql`status in ('pending', 'claimed')`),
    index('print_jobs_created_at_idx').on(t.createdAt),
    check('print_jobs_kind', oneOf('kind', PRINT_JOB_KINDS)),
    check('print_jobs_status', oneOf('status', PRINT_JOB_STATUSES)),
    check(
      'print_jobs_last_error',
      sql`last_error is null or ${oneOf('last_error', PRINT_ERROR_CODES)}`,
    ),
    check('print_jobs_seq', sql`(kind = 'kitchen' and seq = 0) or (kind = 'reprint' and seq >= 1)`),
  ],
);
