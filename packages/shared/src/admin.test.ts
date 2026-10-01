import { describe, expect, test } from 'vitest';
import {
  createStaffInputSchema,
  deviceDtoSchema,
  idParamSchema,
  patchStaffInputSchema,
  setStaffPinInputSchema,
  staffDtoSchema,
} from './admin.ts';

const uuid = '0192f3a0-0000-7000-8000-000000000001';

describe('createStaffInputSchema', () => {
  test('a cashier or kitchen member may have a 4-digit PIN', () => {
    for (const role of ['cashier', 'kitchen'] as const) {
      expect(
        createStaffInputSchema.safeParse({ displayName: 'น้อย', role, pin: '1234' }).success,
      ).toBe(true);
    }
  });

  test('a manager needs 6 digits', () => {
    const manager = { displayName: 'หัวหน้า', role: 'manager' };
    expect(createStaffInputSchema.safeParse({ ...manager, pin: '123456' }).success).toBe(true);
    expect(createStaffInputSchema.safeParse({ ...manager, pin: '1234' }).success).toBe(false);
    expect(createStaffInputSchema.safeParse({ ...manager, pin: '12345' }).success).toBe(false);
  });

  test('the owner cannot be created here (that is the owner:create command)', () => {
    expect(
      createStaffInputSchema.safeParse({ displayName: 'x', role: 'owner', pin: '123456' }).success,
    ).toBe(false);
  });

  test('trims the name and refuses an empty or very long one', () => {
    expect(
      createStaffInputSchema.parse({ displayName: '  น้อย ', role: 'cashier', pin: '1234' })
        .displayName,
    ).toBe('น้อย');
    expect(
      createStaffInputSchema.safeParse({ displayName: ' ', role: 'cashier', pin: '1234' }).success,
    ).toBe(false);
    expect(
      createStaffInputSchema.safeParse({
        displayName: 'x'.repeat(61),
        role: 'cashier',
        pin: '1234',
      }).success,
    ).toBe(false);
  });

  test('refuses fields it does not know, such as a pre-hashed PIN', () => {
    expect(
      createStaffInputSchema.safeParse({
        displayName: 'x',
        role: 'cashier',
        pin: '1234',
        pinHash: 'abc',
      }).success,
    ).toBe(false);
  });
});

describe('setStaffPinInputSchema', () => {
  test('takes a 4 to 6 digit PIN; the role-specific length is checked against the person', () => {
    expect(setStaffPinInputSchema.safeParse({ pin: '1234' }).success).toBe(true);
    expect(setStaffPinInputSchema.safeParse({ pin: '123' }).success).toBe(false);
    expect(setStaffPinInputSchema.safeParse({ pin: 'abcd' }).success).toBe(false);
  });
});

describe('patchStaffInputSchema', () => {
  test('needs the version and something to change', () => {
    expect(patchStaffInputSchema.safeParse({ expectedVersion: 1, active: false }).success).toBe(
      true,
    );
    expect(
      patchStaffInputSchema.safeParse({ expectedVersion: 1, displayName: 'ใหม่' }).success,
    ).toBe(true);
    expect(patchStaffInputSchema.safeParse({ active: false }).success).toBe(false);
    expect(patchStaffInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
  });

  test('refuses a role change and anything else', () => {
    for (const field of ['role', 'pin', 'pinHash', 'id']) {
      expect(
        patchStaffInputSchema.safeParse({ expectedVersion: 1, active: true, [field]: 'x' }).success,
        field,
      ).toBe(false);
    }
  });
});

describe('response shapes', () => {
  test('a device has no token, hash or secret field', () => {
    expect(Object.keys(deviceDtoSchema.shape).join()).not.toMatch(/token|hash|secret/i);
    expect(
      deviceDtoSchema.safeParse({
        id: uuid,
        name: 'iPad',
        kind: 'ipad',
        lastSeenAt: null,
        revokedAt: null,
        version: 1,
      }).success,
    ).toBe(true);
  });

  test('a staff member shows whether they have a PIN, never the PIN or its counters', () => {
    expect(Object.keys(staffDtoSchema.shape).join()).not.toMatch(/hash|secret|failed|level/i);
    expect(
      staffDtoSchema.safeParse({
        id: uuid,
        displayName: 'น้อย',
        role: 'cashier',
        active: true,
        hasPin: true,
        pinLockedUntil: null,
        version: 3,
      }).success,
    ).toBe(true);
  });

  test('an id parameter must be a uuid', () => {
    expect(idParamSchema.safeParse({ id: uuid }).success).toBe(true);
    expect(idParamSchema.safeParse({ id: 'nope' }).success).toBe(false);
  });
});
