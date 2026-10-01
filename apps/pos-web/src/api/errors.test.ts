import { t, translator } from '@sds/i18n';
import { describe, expect, test } from 'vitest';
import {
  API_ERROR_KEYS,
  ApiClientError,
  CLIENT_ERROR_KEYS,
  codeFromStatus,
  errorText,
  waitText,
} from './errors.ts';

const th = translator('th');
const en = translator('en');

describe('error code -> message', () => {
  test('every code has a non-empty Thai and English message', () => {
    for (const key of [...Object.values(API_ERROR_KEYS), ...Object.values(CLIENT_ERROR_KEYS)]) {
      expect(t('th', key).trim(), key).not.toBe('');
      expect(t('en', key).trim(), key).not.toBe('');
    }
  });

  test('covers the codes the API sends for orders and auth', () => {
    const needed = [
      'VERSION_CONFLICT',
      'INVALID_TRANSITION',
      'ORDER_INVALID',
      'IDEMPOTENCY_KEY_MISMATCH',
      'IDEMPOTENCY_KEY_REUSED',
      'UNAUTHENTICATED',
      'DEVICE_UNREGISTERED',
      'DEVICE_MISMATCH',
      'INVALID_CREDENTIALS',
      'ACCOUNT_LOCKED',
      'FORBIDDEN',
      'STEP_UP_REQUIRED',
      'SECOND_FACTOR_UNAVAILABLE',
      'VALIDATION_ERROR',
      'RATE_LIMITED',
    ];
    for (const code of needed) expect(Object.hasOwn(API_ERROR_KEYS, code), code).toBe(true);
  });

  test('shows our own text, never the server message', () => {
    const error = new ApiClientError('VERSION_CONFLICT', { status: 409, currentVersion: 4 });
    expect(error.message).toBe('VERSION_CONFLICT');
    expect(errorText(th, error)).toBe(t('th', 'error.versionConflict'));
    expect(errorText(en, error)).toBe(t('en', 'error.versionConflict'));
  });

  test('unknown codes and non-API errors get the generic message', () => {
    expect(errorText(th, new ApiClientError('FST_ERR_SOMETHING'))).toBe(t('th', 'common.error'));
    expect(errorText(th, new Error('boom'))).toBe(t('th', 'common.error'));
    expect(errorText(th, 'text')).toBe(t('th', 'common.error'));
  });

  test('maps a missing code from the HTTP status', () => {
    expect(codeFromStatus(502)).toBe('INTERNAL');
    expect(codeFromStatus(429)).toBe('RATE_LIMITED');
    expect(codeFromStatus(401)).toBe('UNAUTHENTICATED');
    expect(codeFromStatus(418)).toBe('UNKNOWN');
  });
});

describe('sign-in messages', () => {
  const wrong = new ApiClientError('INVALID_CREDENTIALS', { status: 401 });
  const locked = new ApiClientError('ACCOUNT_LOCKED', { status: 423, retryAfterSeconds: 900 });

  test('owner sign-in says the same thing for wrong details and a lock', () => {
    expect(errorText(th, wrong, 'ownerSignIn')).toBe(errorText(th, locked, 'ownerSignIn'));
    expect(errorText(th, wrong, 'ownerSignIn')).toBe(t('th', 'auth.owner.failed'));
    // No minutes, no "locked", no hint about the account.
    expect(errorText(en, locked, 'ownerSignIn')).not.toMatch(/\d|locked/i);
  });

  test('a PIN lock states the wait, built from the server value', () => {
    const lock = (seconds: number) =>
      new ApiClientError('ACCOUNT_LOCKED', { status: 423, retryAfterSeconds: seconds });
    expect(errorText(th, lock(300), 'pin')).toBe('PIN ถูกล็อกชั่วคราว ลองใหม่ได้ในอีก 5 นาที');
    expect(errorText(th, lock(3600), 'pin')).toContain('1 ชั่วโมง');
    expect(errorText(th, lock(86400), 'pin')).toContain('24 ชั่วโมง');
    expect(errorText(en, lock(300), 'pin')).toContain('5 min');
  });

  test('a wrong PIN and a wrong step-up have their own short messages', () => {
    expect(errorText(th, wrong, 'pin')).toBe(t('th', 'auth.pin.wrong'));
    expect(errorText(th, wrong, 'stepUp')).toBe(t('th', 'auth.stepUp.failed'));
  });

  test('a lock without a wait time still gets a calm message', () => {
    const bare = new ApiClientError('ACCOUNT_LOCKED', { status: 423 });
    expect(errorText(th, bare)).toBe(t('th', 'error.accountLocked'));
  });
});

describe('waitText', () => {
  test.each([
    [1, '1 นาที'],
    [60, '1 นาที'],
    [61, '2 นาที'],
    [300, '5 นาที'],
    [3599, '60 นาที'],
    [3600, '1 ชั่วโมง'],
    [3601, '2 ชั่วโมง'],
    [86400, '24 ชั่วโมง'],
  ])('%i s -> %s', (seconds, expected) => {
    expect(waitText(th, seconds)).toBe(expected);
  });
});
