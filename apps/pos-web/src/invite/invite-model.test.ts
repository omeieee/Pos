import { describe, expect, test } from 'vitest';
import {
  buildAccept,
  emptyInviteDraft,
  inviteProblems,
  passwordStrength,
  pinHintDigits,
  sanitizeCode,
  sanitizePin,
} from './invite-model.ts';

const good = {
  displayName: ' น้องนก ',
  password: 'a long enough made-up password',
  pin: '1234',
  pin2: '1234',
  code: '123456',
};

describe('the invite form', () => {
  test('a good form builds exactly the shared accept body', () => {
    expect(inviteProblems('cashier', good)).toEqual([]);
    expect(buildAccept('tok', 'cashier', good)).toEqual({
      token: 'tok',
      displayName: 'น้องนก',
      password: 'a long enough made-up password',
      pin: '1234',
      totpCode: '123456',
    });
  });

  test('every field is checked: name, a 12-character password, the PIN of the role, the code', () => {
    expect(inviteProblems('cashier', emptyInviteDraft)).toEqual([
      'displayName',
      'password',
      'pin',
      'code',
    ]);
    expect(inviteProblems('cashier', { ...good, password: 'only eleven' })).toEqual(['password']);
    expect(inviteProblems('cashier', { ...good, code: '12345' })).toEqual(['code']);
    expect(inviteProblems('cashier', { ...good, pin2: '1235' })).toEqual(['pin2']);
    expect(buildAccept('tok', 'cashier', { ...good, password: 'short' })).toBeNull();
  });

  test('the PIN length follows the invited role: all 6 digits for an owner or manager', () => {
    expect(inviteProblems('kitchen', good)).toEqual([]);
    expect(inviteProblems('manager', good)).toEqual(['pin']);
    expect(inviteProblems('owner', good)).toEqual(['pin']);
    expect(inviteProblems('owner', { ...good, pin: '123456', pin2: '123456' })).toEqual([]);
    expect(pinHintDigits('owner')).toBe(6);
    expect(pinHintDigits('manager')).toBe(6);
    expect(pinHintDigits('cashier')).toBe(4);
    expect(pinHintDigits('kitchen')).toBe(4);
  });

  test('the password hint: short below 12, strong from 16', () => {
    expect(passwordStrength('')).toBe('short');
    expect(passwordStrength('x'.repeat(11))).toBe('short');
    expect(passwordStrength('x'.repeat(12))).toBe('fair');
    expect(passwordStrength('x'.repeat(16))).toBe('strong');
  });

  test('the code and the PIN take digits only, at most 6', () => {
    expect(sanitizeCode('123 456 789')).toBe('123456');
    expect(sanitizeCode('12-34')).toBe('1234');
    expect(sanitizePin('12ab34')).toBe('1234');
    expect(sanitizePin('1234567')).toBe('123456');
  });
});
