/**
 * Schema: money outside orders (expenses and tax profiles).
 */
import { EXPENSE_CATEGORIES } from '@sds/shared';
import { sql } from 'drizzle-orm';
import { check, date, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { id, money, oneOf, sync } from './columns.ts';
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
    createdByStaffId: uuid('created_by_staff_id').references(() => staff.id),
    ...sync,
  },
  (t) => [
    index('expenses_business_date_idx').on(t.businessDate),
    index('expenses_created_by_staff_id_idx').on(t.createdByStaffId),
    index('expenses_rev_idx').on(t.rev),
    check('expenses_category', oneOf('category', EXPENSE_CATEGORIES)),
    check('expenses_amount_nonneg', sql`amount_satang >= 0`),
  ],
);

export const taxProfiles = pgTable('tax_profiles', {
  year: integer('year').primaryKey(),
  filerType: text('filer_type').notNull().default('individual'),
  allowances: jsonb('allowances').notNull().default({}),
  methodPreference: text('method_preference'),
});
