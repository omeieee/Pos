/**
 * Schema: money outside orders (expenses and tax profiles).
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, money, sync, ts } from './columns.ts';
import { staff } from './people.ts';

// ---------- Money outside orders ----------

export const expenses = pgTable(
  'expenses',
  {
    id: id(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    category: text('category').notNull(),
    amountSatang: money('amount_satang').notNull(),
    vendor: text('vendor'),
    note: text('note'),
    receiptImageKey: text('receipt_image_key'),
    /**
     * Idempotency of the receipt upload (migration 0039): the Idempotency-Key and the SHA-256 of the
     * picture received with it. A repeat with both equal changes nothing. Both null without a receipt.
     */
    receiptRequestId: uuid('receipt_request_id'),
    receiptRequestHash: text('receipt_request_hash'),
    createdByStaffId: uuid('created_by_staff_id').references(() => staff.id),
    /**
     * Idempotency of the create route (migration 0037): a client request id and the fingerprint of
     * the request that carried it. Both null on a row made without one.
     */
    clientRequestId: uuid('client_request_id'),
    requestHash: text('request_hash'),
    /** A voided expense stays in the ledger (rows are never deleted) and is left out of totals. */
    voidedAt: ts('voided_at'),
    voidedByStaffId: uuid('voided_by_staff_id').references(() => staff.id),
    voidReason: text('void_reason'),
    ...sync,
  },
  (t) => [
    index('expenses_business_date_idx').on(t.businessDate),
    index('expenses_created_by_staff_id_idx').on(t.createdByStaffId),
    index('expenses_voided_by_staff_id_idx').on(t.voidedByStaffId),
    index('expenses_rev_idx').on(t.rev),
    uniqueIndex('expenses_client_request_id_key').on(t.clientRequestId),
    check('expenses_amount_nonneg', sql`amount_satang >= 0`),
  ],
);

export const taxProfiles = pgTable('tax_profiles', {
  year: integer('year').primaryKey(),
  filerType: text('filer_type').notNull().default('individual'),
  allowances: jsonb('allowances').notNull().default({}),
  methodPreference: text('method_preference'),
});
