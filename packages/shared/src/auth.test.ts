import { describe, expect, test } from 'vitest';
import {
  ownerLoginInputSchema,
  ownerPasswordSchema,
  ownerStepUpInputSchema,
  pinLoginInputSchema,
  pinSchema,
  registerDeviceInputSchema,
  staffStepUpInputSchema,
} from './auth.ts';

const staffId = '0192f3a0-0000-7000-8000-000000000001';

describe('pinSchema', () => {
  test.each(['1234', '12345', '123456', '0000'])('accepts %s', (pin) => {
    expect(pinSchema.safeParse(pin).success).toBe(true);
  });
  test.each(['123', '1234567', '12a4', '12 4', '', 1234])('rejects %j', (pin) => {
    expect(pinSchema.safeParse(pin).success).toBe(false);
  });
});

describe('ownerPasswordSchema (used when a password is chosen)', () => {
  test('needs at least 12 characters', () => {
    expect(ownerPasswordSchema.safeParse('a'.repeat(11)).success).toBe(false);
    expect(ownerPasswordSchema.safeParse('a'.repeat(12)).success).toBe(true);
  });
  test('has an upper bound so a huge body cannot be hashed', () => {
    expect(ownerPasswordSchema.safeParse('a'.repeat(257)).success).toBe(false);
  });
});

describe('registerDeviceInputSchema', () => {
  test('accepts a known kind and trims the name', () => {
    expect(registerDeviceInputSchema.parse({ name: '  iPad counter ', kind: 'ipad' })).toEqual({
      name: 'iPad counter',
      kind: 'ipad',
    });
  });
  test.each([
    { name: '', kind: 'ipad' },
    { name: 'x', kind: 'toaster' },
    { name: 'x'.repeat(61), kind: 'ipad' },
  ])('rejects %j', (v) => {
    expect(registerDeviceInputSchema.safeParse(v).success).toBe(false);
  });
});

describe('pinLoginInputSchema', () => {
  test('needs a staff id and a PIN', () => {
    expect(pinLoginInputSchema.safeParse({ staffId, pin: '1234' }).success).toBe(true);
    expect(pinLoginInputSchema.safeParse({ staffId: 'nope', pin: '1234' }).success).toBe(false);
    expect(pinLoginInputSchema.safeParse({ staffId }).success).toBe(false);
  });
});

describe('ownerLoginInputSchema', () => {
  const base = { email: 'Owner@Example.com', password: 'correct horse battery' };

  test('accepts a TOTP code and lower-cases the e-mail', () => {
    const out = ownerLoginInputSchema.parse({ ...base, totp: '123456' });
    expect(out.email).toBe('owner@example.com');
  });
  test('accepts a recovery code instead of a TOTP code', () => {
    expect(
      ownerLoginInputSchema.safeParse({ ...base, recoveryCode: 'ABCD-EFGH-JKLM-NPQR' }).success,
    ).toBe(true);
  });
  test('accepts a recovery code typed with spaces', () => {
    expect(
      ownerLoginInputSchema.safeParse({ ...base, recoveryCode: 'abcd efgh jklm npqr' }).success,
    ).toBe(true);
    expect(ownerLoginInputSchema.safeParse({ ...base, recoveryCode: "ab'; drop--" }).success).toBe(
      false,
    );
  });
  test('needs exactly one second factor', () => {
    expect(ownerLoginInputSchema.safeParse(base).success).toBe(false);
    expect(
      ownerLoginInputSchema.safeParse({
        ...base,
        totp: '123456',
        recoveryCode: 'ABCD-EFGH-JKLM-NPQR',
      }).success,
    ).toBe(false);
  });
  test.each(['12345', '1234567', 'abcdef'])('rejects the TOTP code %j', (totp) => {
    expect(ownerLoginInputSchema.safeParse({ ...base, totp }).success).toBe(false);
  });
});

describe('step-up inputs', () => {
  test('the owner re-enters the password and a second factor', () => {
    expect(ownerStepUpInputSchema.safeParse({ password: 'x', totp: '123456' }).success).toBe(true);
    expect(ownerStepUpInputSchema.safeParse({ password: 'x' }).success).toBe(false);
    expect(ownerStepUpInputSchema.safeParse({ pin: '1234' }).success).toBe(false);
  });
  test('other roles re-enter their PIN', () => {
    expect(staffStepUpInputSchema.safeParse({ pin: '1234' }).success).toBe(true);
    expect(staffStepUpInputSchema.safeParse({ pin: '12' }).success).toBe(false);
  });
});
