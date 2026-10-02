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

  test('covers every code the API can send for menu, orders and payments', () => {
    const needed = [
      // payments
      'TENDERED_BELOW_TOTAL',
      'AMOUNT_TOO_LARGE',
      'PROMPTPAY_NOT_CONFIGURED',
      'PROMPTPAY_PAYLOAD_INVALID',
      'GOV_COPAY_UNAVAILABLE',
      'METHOD_DISABLED',
      'PAYMENT_ALREADY_OPEN',
      'ORDER_ALREADY_PAID',
      'NOTHING_TO_PAY',
      'PAYMENT_NOT_PENDING',
      'METHOD_UNCHANGED',
      'QR_NOT_AVAILABLE',
      'QR_LINK_INVALID',
      'QR_LINK_EXPIRED',
      'ORDER_HAS_PAYMENT',
      // pricing (they travel inside ORDER_INVALID, and a client may meet them on their own)
      'UNKNOWN_ITEM',
      'ITEM_UNAVAILABLE',
      'ITEM_NOT_ON_CHANNEL',
      'UNKNOWN_OPTION',
      'OPTION_UNAVAILABLE',
      'DUPLICATE_OPTION',
      'GROUP_TOO_FEW',
      'GROUP_TOO_MANY',
      'INVALID_PRICE',
      // menu, staff and the socket route
      'UNKNOWN_CATEGORY',
      'UNKNOWN_GROUP',
      'OWNER_PROTECTED',
      'UPGRADE_REQUIRED',
      'BAD_REQUEST',
    ];
    for (const code of needed) expect(Object.hasOwn(API_ERROR_KEYS, code), code).toBe(true);
  });

  test('an entrance order refused for its fulfilment or building says so, in both languages', () => {
    for (const [code, key] of [
      ['FULFILLMENT_NOT_OFFERED', 'error.fulfillmentNotOffered'],
      ['UNKNOWN_BUILDING', 'error.unknownBuilding'],
    ] as const) {
      const error = new ApiClientError(code, { status: 422 });
      expect(errorText(th, error)).toBe(t('th', key));
      expect(errorText(en, error)).toBe(t('en', key));
      expect(errorText(th, error)).not.toBe(t('th', 'common.error'));
    }
  });

  test('an order refused for one line says what is wrong with it, not just "invalid"', () => {
    const soldOut = new ApiClientError('ORDER_INVALID', {
      status: 422,
      lineErrors: [{ code: 'ITEM_UNAVAILABLE', lineIndex: 1 }],
    });
    expect(errorText(th, soldOut)).toBe(t('th', 'error.itemUnavailable'));
    expect(errorText(en, soldOut)).toBe(t('en', 'error.itemUnavailable'));
    const unknown = new ApiClientError('ORDER_INVALID', {
      status: 422,
      lineErrors: [{ code: 'SOMETHING_NEW', lineIndex: 0 }],
    });
    expect(errorText(th, unknown)).toBe(t('th', 'error.orderInvalid'));
    expect(errorText(th, new ApiClientError('ORDER_INVALID', { status: 422 }))).toBe(
      t('th', 'error.orderInvalid'),
    );
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

  test('an invalid transition on a payment says payment, not order', () => {
    const refused = new ApiClientError('INVALID_TRANSITION', { status: 409 });
    expect(errorText(th, refused)).toBe(t('th', 'error.invalidTransition'));
    expect(errorText(th, refused, 'payment')).toBe(t('th', 'error.paymentInvalidTransition'));
    expect(errorText(en, refused, 'payment')).toBe(t('en', 'error.paymentInvalidTransition'));
  });

  test('PromptPay not configured tells staff to ask the owner', () => {
    const refused = new ApiClientError('PROMPTPAY_NOT_CONFIGURED', { status: 409 });
    expect(errorText(th, refused)).toContain('เจ้าของร้าน');
    expect(errorText(en, refused).toLowerCase()).toContain('owner');
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
