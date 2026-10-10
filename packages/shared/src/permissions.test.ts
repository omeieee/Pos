import { expect, test } from 'vitest';
import { STAFF_ROLES } from './enums.ts';
import { hasPermission, PERMISSIONS, requiresStepUp } from './permissions.ts';

test('the owner has every permission', () => {
  for (const p of PERMISSIONS) expect(hasPermission('owner', p)).toBe(true);
});

test('only the owner can change the PromptPay ID, the co-pay scheme, staff or devices, or export data', () => {
  for (const role of STAFF_ROLES) {
    for (const p of [
      'settings.promptpay',
      'settings.gov_copay',
      'settings.receipt',
      'staff.manage',
      'device.manage',
      'data.export',
      'customer.anonymize',
      'order.edit_past',
    ] as const) {
      expect(hasPermission(role, p)).toBe(role === 'owner');
    }
  }
});

test('kitchen can accept and advance orders and mark menu items sold out, nothing else', () => {
  expect(PERMISSIONS.filter((p) => hasPermission('kitchen', p))).toEqual([
    'order.accept',
    'order.advance',
    'menu.availability',
  ]);
});

test('every role may mark an item sold out, but only managers and the owner edit the menu', () => {
  for (const role of STAFF_ROLES) expect(hasPermission(role, 'menu.availability'), role).toBe(true);
  expect(hasPermission('owner', 'menu.edit')).toBe(true);
  expect(hasPermission('manager', 'menu.edit')).toBe(true);
  expect(hasPermission('cashier', 'menu.edit')).toBe(false);
  expect(hasPermission('kitchen', 'menu.edit')).toBe(false);
});

test('cashier confirms payments but cannot void, refund or cancel in-progress orders', () => {
  expect(hasPermission('cashier', 'payment.confirm')).toBe(true);
  expect(hasPermission('cashier', 'payment.void_refund')).toBe(false);
  expect(hasPermission('cashier', 'order.cancel_in_progress')).toBe(false);
});

test('reading settings: the owner, managers and cashiers (they show the PromptPay QR), not the kitchen', () => {
  for (const role of ['owner', 'manager', 'cashier'] as const) {
    expect(hasPermission(role, 'settings.view'), role).toBe(true);
  }
  expect(hasPermission('kitchen', 'settings.view')).toBe(false);
});

test('changing ordinary settings stays with managers and the owner', () => {
  expect(hasPermission('manager', 'settings.edit')).toBe(true);
  expect(hasPermission('cashier', 'settings.edit')).toBe(false);
  expect(hasPermission('manager', 'settings.gov_copay')).toBe(false);
});

test('sensitive actions need step-up', () => {
  expect(PERMISSIONS.filter(requiresStepUp).sort()).toEqual(
    [
      'customer.anonymize',
      'data.export',
      'device.manage',
      'order.edit_past',
      'payment.void_refund',
      'settings.gov_copay',
      'settings.promptpay',
      'settings.receipt',
      'staff.manage',
    ].sort(),
  );
});
