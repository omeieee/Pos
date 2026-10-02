import type { StaffDto } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import {
  buildNewStaff,
  isPinLocked,
  pinProblems,
  staffDisplayState,
  validateNewStaff,
} from './staff-model.ts';

const person = (over: Partial<StaffDto> = {}): StaffDto => ({
  id: '0192f3a0-0000-7000-8000-000000000201',
  displayName: 'น้องเอ',
  role: 'cashier',
  active: true,
  hasPin: true,
  pinLockedUntil: null,
  version: 1,
  ...over,
});

describe('a new person', () => {
  const form = { displayName: 'น้องใหม่', role: 'cashier' as const, pin: '1234', pin2: '1234' };

  test('a good form has no problems and builds exactly the shared create body', () => {
    expect(validateNewStaff(form)).toEqual([]);
    expect(buildNewStaff(form)).toEqual({ displayName: 'น้องใหม่', role: 'cashier', pin: '1234' });
  });

  test('the name is required and trimmed', () => {
    expect(validateNewStaff({ ...form, displayName: '   ' })).toEqual(['displayName']);
    expect(validateNewStaff({ ...form, displayName: 'ก'.repeat(61) })).toEqual(['displayName']);
    expect(buildNewStaff({ ...form, displayName: '  น้องใหม่ ' })?.displayName).toBe('น้องใหม่');
  });

  test('the PIN needs 4 to 6 digits for the counter and kitchen, and all 6 for a manager', () => {
    expect(validateNewStaff({ ...form, pin: '123', pin2: '123' })).toEqual(['pin']);
    expect(validateNewStaff({ ...form, pin: '12345a', pin2: '12345a' })).toEqual(['pin']);
    expect(validateNewStaff({ ...form, role: 'kitchen', pin: '4321', pin2: '4321' })).toEqual([]);
    expect(validateNewStaff({ ...form, role: 'manager' })).toEqual(['pin']);
    expect(validateNewStaff({ ...form, role: 'manager', pin: '123456', pin2: '123456' })).toEqual(
      [],
    );
  });

  test('the PIN typed twice must match', () => {
    expect(validateNewStaff({ ...form, pin2: '1235' })).toEqual(['pin2']);
  });

  test('an invalid form builds nothing', () => {
    expect(buildNewStaff({ ...form, pin2: '9999' })).toBeNull();
  });
});

describe('a new PIN for someone', () => {
  test('follows the role of that person, and must match when typed twice', () => {
    expect(pinProblems('cashier', '1234', '1234')).toEqual([]);
    expect(pinProblems('manager', '1234', '1234')).toEqual(['pin']);
    expect(pinProblems('cashier', '1234', '4321')).toEqual(['pin2']);
  });
});

describe('what a row shows', () => {
  const now = Date.parse('2026-10-03T03:00:00.000Z');

  test('a PIN lock counts only while it is in the future', () => {
    expect(isPinLocked(person({ pinLockedUntil: '2026-10-03T03:05:00.000Z' }), now)).toBe(true);
    expect(isPinLocked(person({ pinLockedUntil: '2026-10-03T02:59:00.000Z' }), now)).toBe(false);
    expect(isPinLocked(person(), now)).toBe(false);
  });

  test('the owner has no actions here; a deactivated person may be switched back on', () => {
    expect(staffDisplayState(person({ role: 'owner' }), now)).toMatchObject({
      canEdit: false,
    });
    expect(staffDisplayState(person(), now)).toMatchObject({
      canEdit: true,
      canDeactivate: true,
      canActivate: false,
    });
    expect(staffDisplayState(person({ active: false }), now)).toMatchObject({
      canDeactivate: false,
      canActivate: true,
    });
  });

  test('a person with no PIN is flagged', () => {
    expect(staffDisplayState(person({ hasPin: false }), now).noPin).toBe(true);
  });
});
