/**
 * Schema v1 (03-data-model). The tables are the source of truth once they exist;
 * keep docs/03-data-model.md in step with them. They live in ./schema/*.ts (one file per
 * group); this file re-exports all of them, and drizzle.config.ts reads this file.
 *
 * - IDs: UUIDv7 from uuid_generate_v7() (portable plpgsql, migration 0000).
 * - Money: bigint satang read as JS number (D-11 note).
 * - Synced tables: `version` (+1 on update) and `rev` (global rev_seq) are set by
 *   the sync trigger (migration 0002); `updated_at` too.
 */
export { revSeq } from './schema/columns.ts';
export { expenses, taxProfiles } from './schema/expenses.ts';
export {
  menuCategories,
  menuItemChannelPrices,
  menuItemModifierGroups,
  menuItemPhotos,
  menuItems,
  modifierGroups,
  modifierOptions,
} from './schema/menu.ts';
export { dailyCounters, orderItems, orders } from './schema/orders.ts';
export { govCopaySchemes, paymentRefunds, payments } from './schema/payments.ts';
export {
  customers,
  devices,
  ownerCredentials,
  sessions,
  staff,
  staffInvites,
} from './schema/people.ts';
export { printJobs } from './schema/printing.ts';
export {
  auditLog,
  lineButtonReplies,
  lineEvents,
  lineMessageLog,
  lineQuotaMonths,
  settings,
  slipVerifyDaily,
} from './schema/settings-line-audit.ts';
export { SYNCED_TABLES } from './schema/synced.ts';
