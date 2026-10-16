/**
 * Schema: the tables that get the sync trigger.
 */

/** Tables that get the sync trigger (rev/version/updated_at). */
export const SYNCED_TABLES = [
  'menu_categories',
  'menu_items',
  'modifier_groups',
  'modifier_options',
  'customers',
  'staff',
  'devices',
  'orders',
  'gov_copay_schemes',
  'payments',
  'expenses',
  'settings',
] as const;
