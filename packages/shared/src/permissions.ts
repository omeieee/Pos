import type { StaffRole } from './enums.ts';

/** Staff permissions (D-17). The API checks these; UIs only hide what is not allowed. */
export const PERMISSIONS = [
  'order.create',
  'order.accept',
  'order.advance',
  'order.cancel_new',
  'order.cancel_in_progress',
  'payment.record',
  'payment.confirm',
  'payment.cancel_claimed',
  'payment.void_refund',
  'menu.edit',
  'customer.view',
  'report.view',
  'expense.edit',
  'settings.edit',
  'settings.promptpay',
  'staff.manage',
  'device.manage',
  'data.export',
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
  'customer.view',
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
  kitchen: new Set<Permission>(['order.accept', 'order.advance']),
};

/** Sensitive actions: re-authentication (step-up) plus an audit_log row (CLAUDE.md rule 9). */
export const STEP_UP_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'settings.promptpay',
  'payment.void_refund',
  'staff.manage',
  'device.manage',
  'data.export',
]);

export function hasPermission(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function requiresStepUp(permission: Permission): boolean {
  return STEP_UP_PERMISSIONS.has(permission);
}
