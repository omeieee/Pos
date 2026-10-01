import { describe, expect, test } from 'vitest';
import { FAKE_EMAIL } from '../test-support/fixtures.ts';
import {
  afterFailedAttempt,
  emptyOwnerDraft,
  type OwnerDraft,
  ownerLoginRequest,
  ownerStepUpRequest,
  sanitizeAppCode,
} from './owner-form.ts';

const filled: OwnerDraft = {
  ...emptyOwnerDraft,
  email: FAKE_EMAIL,
  password: 'not-a-real-password',
  code: '123456',
};

describe('app code input', () => {
  test('keeps digits only, at most 6', () => {
    expect(sanitizeAppCode('12 34-56')).toBe('123456');
    expect(sanitizeAppCode('1234567890')).toBe('123456');
    expect(sanitizeAppCode('abc')).toBe('');
  });
});

describe('sign-in request', () => {
  test('is built only when the shared schema accepts it', () => {
    expect(ownerLoginRequest(emptyOwnerDraft)).toBeNull();
    expect(ownerLoginRequest({ ...filled, email: 'not-an-email' })).toBeNull();
    expect(ownerLoginRequest({ ...filled, password: '' })).toBeNull();
    expect(ownerLoginRequest({ ...filled, code: '12345' })).toBeNull();
    expect(ownerLoginRequest(filled)).toEqual({
      email: FAKE_EMAIL,
      password: 'not-a-real-password',
      totp: '123456',
    });
  });

  test('sends exactly one second factor, the one chosen', () => {
    const withBoth = { ...filled, recoveryCode: 'ABCD-EFGH-JKLM-NPQR' };
    expect(ownerLoginRequest(withBoth)).toMatchObject({ totp: '123456' });
    expect(ownerLoginRequest(withBoth)).not.toHaveProperty('recoveryCode');

    const recovery = { ...withBoth, useRecovery: true };
    expect(ownerLoginRequest(recovery)).toMatchObject({ recoveryCode: 'ABCD-EFGH-JKLM-NPQR' });
    expect(ownerLoginRequest(recovery)).not.toHaveProperty('totp');
    expect(ownerLoginRequest({ ...recovery, recoveryCode: 'short' })).toBeNull();
  });
});

describe('step-up request', () => {
  test('is the password plus one second factor, and no e-mail', () => {
    expect(ownerStepUpRequest(emptyOwnerDraft)).toBeNull();
    const request = ownerStepUpRequest(filled);
    expect(request).toEqual({ password: 'not-a-real-password', totp: '123456' });
    expect(request).not.toHaveProperty('email');
  });
});

describe('after a failed attempt', () => {
  test('clears every secret, keeps the e-mail and the chosen factor', () => {
    const next = afterFailedAttempt({ ...filled, recoveryCode: 'ABCD', useRecovery: true });
    expect(next).toEqual({
      email: FAKE_EMAIL,
      password: '',
      code: '',
      recoveryCode: '',
      useRecovery: true,
    });
  });
});
