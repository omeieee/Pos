import type { StaffDto } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import {
  buildInvite,
  buildNewStaff,
  canBecomeOwner,
  isPinLocked,
  pinProblems,
  roleChangeNeedsPin,
  roleChangePin,
  staffDisplayState,
  validateInvite,
  validateNewStaff,
  validateRoleChange,
} from './staff-model.ts';

const person = (over: Partial<StaffDto> = {}): StaffDto => ({
  id: '0192f3a0-0000-7000-8000-000000000201',
  displayName: 'น้องเอ',
  role: 'cashier',
  active: true,
  email: null,
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

  test('nobody changes their own row; another owner can be changed; a deactivated person may be switched back on', () => {
    const me = person({ role: 'owner' });
    expect(staffDisplayState(me, now, me.id)).toMatchObject({
      isSelf: true,
      canEdit: false,
      canChangeRole: false,
      canDeactivate: false,
      canActivate: false,
    });
    expect(staffDisplayState(me, now, 'someone-else')).toMatchObject({
      isSelf: false,
      canEdit: true,
      canChangeRole: true,
      canDeactivate: true,
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

describe('an invite', () => {
  const form = { email: ' Nok@Example.test ', displayName: '', role: 'cashier' as const };

  test('a good form builds exactly the shared body: e-mail trimmed and lower-cased, no empty name', () => {
    expect(validateInvite(form)).toEqual([]);
    expect(buildInvite(form)).toEqual({ email: 'nok@example.test', role: 'cashier' });
    expect(buildInvite({ ...form, displayName: ' น้องนก ', role: 'owner' })).toEqual({
      email: 'nok@example.test',
      displayName: 'น้องนก',
      role: 'owner',
    });
  });

  test('a bad e-mail or a long name builds nothing', () => {
    expect(validateInvite({ ...form, email: 'nope' })).toEqual(['email']);
    expect(validateInvite({ ...form, email: '' })).toEqual(['email']);
    expect(validateInvite({ ...form, displayName: 'ก'.repeat(61) })).toEqual(['displayName']);
    expect(buildInvite({ ...form, email: 'nope' })).toBeNull();
  });
});

describe('a role change', () => {
  const p = (over: Partial<StaffDto> = {}) => person({ email: 'a@example.test', ...over });

  test('needs a PIN when the new role needs more digits, or the person has none (owner excepted)', () => {
    expect(roleChangeNeedsPin(p(), 'cashier')).toBe(false); // same role
    expect(roleChangeNeedsPin(p(), 'kitchen')).toBe(false); // 4 -> 4
    expect(roleChangeNeedsPin(p(), 'manager')).toBe(true); // 4 -> 6
    expect(roleChangeNeedsPin(p(), 'owner')).toBe(true); // 4 -> 6
    expect(roleChangeNeedsPin(p({ role: 'manager' }), 'cashier')).toBe(false); // 6 -> 4
    expect(roleChangeNeedsPin(p({ role: 'manager' }), 'owner')).toBe(false); // 6 -> 6
    expect(roleChangeNeedsPin(p({ hasPin: false }), 'kitchen')).toBe(true);
    expect(roleChangeNeedsPin(p({ hasPin: false, role: 'manager' }), 'owner')).toBe(false);
  });

  test('only a person with an e-mail account can become an owner', () => {
    expect(canBecomeOwner(person({ email: null }))).toBe(false);
    expect(canBecomeOwner(person({ email: 'a@example.test' }))).toBe(true);
    expect(
      validateRoleChange(person({ email: null }), { role: 'owner', pin: '', pin2: '' }),
    ).toEqual(['role']);
  });

  test('the same role is refused; a needed PIN follows the new role and is typed twice', () => {
    expect(validateRoleChange(p(), { role: 'cashier', pin: '', pin2: '' })).toEqual(['role']);
    expect(validateRoleChange(p(), { role: 'kitchen', pin: '', pin2: '' })).toEqual([]);
    expect(validateRoleChange(p(), { role: 'manager', pin: '1234', pin2: '1234' })).toEqual([
      'pin',
    ]);
    expect(validateRoleChange(p(), { role: 'manager', pin: '123456', pin2: '123457' })).toEqual([
      'pin2',
    ]);
    expect(validateRoleChange(p(), { role: 'manager', pin: '123456', pin2: '123456' })).toEqual([]);
  });

  test('the PIN is sent only when it is needed', () => {
    expect(roleChangePin(p(), { role: 'kitchen', pin: '9999' })).toBeUndefined();
    expect(roleChangePin(p(), { role: 'manager', pin: '123456' })).toBe('123456');
  });
});
