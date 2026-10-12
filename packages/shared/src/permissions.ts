import type { StaffRole } from './enums.ts';

/** Staff permissions (D-17). The API checks these; UIs only hide what is not allowed. */
export const PERMISSIONS = [
  'order.create',
  'order.accept',
  'order.advance',
  'order.cancel_new',
  'order.cancel_in_progress',
  /** Edit or void any order, including a paid or finished one (owner decision 2026-10-11). */
  'order.edit_past',
  'payment.record',
  'payment.confirm',
  'payment.cancel_claimed',
  'payment.void_refund',
  /** Lift the slip block of an order after a "fake slip" answer, with a reason. Owner only. */
  'payment.slip_block_clear',
  'menu.edit',
  'menu.availability',
  'customer.view',
  'report.view',
  'expense.edit',
  'settings.view',
  'settings.edit',
  'settings.promptpay',
  'settings.gov_copay',
  /** The shop's tax ID and address printed on receipts. */
  'settings.receipt',
  /** The shop's receiving bank account number, used only to check slip receivers (D-26). */
  'settings.bank_account',
  'staff.manage',
  'device.manage',
  'data.export',
  /** Erase a customer's personal data (PDPA). Irreversible, so owner only, with step-up. */
  'customer.anonymize',
  /** Clear a customer's slip flag, with a reason. Owner only. */
  'customer.slip_flag_clear',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const CASHIER: readonly Permission[] = [
  'order.create',
  'order.accept',
  'order.advance',
  'order.cancel_new',
  'payment.record',
  'payment.confirm',
  'payment.cancel_claimed',
  'menu.availability',
  'customer.view',
  'settings.view',
];

const MANAGER: readonly Permission[] = [
  ...CASHIER,
  'order.cancel_in_progress',
  'payment.void_refund',
  'menu.edit',
  'report.view',
  'expense.edit',
  'settings.edit',
];

export const ROLE_PERMISSIONS: Record<StaffRole, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  manager: new Set(MANAGER),
  cashier: new Set(CASHIER),
  kitchen: new Set<Permission>(['order.accept', 'order.advance', 'menu.availability']),
};

/** Sensitive actions: re-authentication (step-up) plus an audit_log row (CLAUDE.md rule 9). */
export const STEP_UP_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'settings.promptpay',
  'settings.gov_copay',
  'settings.receipt',
  'settings.bank_account',
  'payment.void_refund',
  'order.edit_past',
  'staff.manage',
  'device.manage',
  'data.export',
  'customer.anonymize',
  'payment.slip_block_clear',
  'customer.slip_flag_clear',
]);

export function hasPermission(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function requiresStepUp(permission: Permission): boolean {
  return STEP_UP_PERMISSIONS.has(permission);
}
