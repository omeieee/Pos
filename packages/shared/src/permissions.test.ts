import { expect, test } from 'vitest';
import { STAFF_ROLES } from './enums.ts';
import { hasPermission, PERMISSIONS, requiresStepUp } from './permissions.ts';

test('the owner has every permission', () => {
  for (const p of PERMISSIONS) expect(hasPermission('owner', p)).toBe(true);
});

test('only the owner can change the PromptPay ID, staff or devices, or export data', () => {
  for (const role of STAFF_ROLES) {
    for (const p of [
      'settings.promptpay',
      'staff.manage',
      'device.manage',
      'data.export',
    ] as const) {
      expect(hasPermission(role, p)).toBe(role === 'owner');
    }
  }
});

test('kitchen can only accept and advance orders', () => {
  expect(PERMISSIONS.filter((p) => hasPermission('kitchen', p))).toEqual([
    'order.accept',
    'order.advance',
  ]);
});

test('cashier confirms payments but cannot void, refund or cancel in-progress orders', () => {
  expect(hasPermission('cashier', 'payment.confirm')).toBe(true);
  expect(hasPermission('cashier', 'payment.void_refund')).toBe(false);
  expect(hasPermission('cashier', 'order.cancel_in_progress')).toBe(false);
});

test('sensitive actions need step-up', () => {
  expect(PERMISSIONS.filter(requiresStepUp).sort()).toEqual(
    [
      'data.export',
      'device.manage',
      'payment.void_refund',
      'settings.promptpay',
      'staff.manage',
    ].sort(),
  );
});
