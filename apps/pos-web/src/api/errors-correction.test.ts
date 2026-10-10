import { catalogs, translator } from '@sds/i18n';
import { describe, expect, test } from 'vitest';
import { ApiClientError, errorText } from './errors.ts';

const th = catalogs.th;
const en = catalogs.en;
const tr = translator('th');

const say = (code: string, context?: 'correction') =>
  errorText(tr, new ApiClientError(code, { status: 409 }), context);

describe('errors of the owner correction and void', () => {
  test('each code has its own Thai message', () => {
    expect(say('PAYMENT_ACTION_REQUIRED', 'correction')).toBe(th['error.paymentActionRequired']);
    expect(say('NOTHING_TO_CHANGE', 'correction')).toBe(th['error.nothingToChange']);
    expect(say('DISCOUNT_EXCEEDS_SUBTOTAL', 'correction')).toBe(
      th['error.discountExceedsSubtotal'],
    );
    expect(say('UNKNOWN_ORDER_ITEM', 'correction')).toBe(th['error.unknownOrderItem']);
    expect(say('VERSION_CONFLICT', 'correction')).toBe(th['error.versionConflict']);
  });

  test('ORDER_CLOSED means "already voided" here, and keeps its old text elsewhere', () => {
    expect(say('ORDER_CLOSED', 'correction')).toBe(th['order.fix.error.voided']);
    expect(say('ORDER_CLOSED')).toBe(th['error.orderClosed']);
  });

  test('every message exists in English too', () => {
    for (const key of [
      'error.paymentActionRequired',
      'error.nothingToChange',
      'error.discountExceedsSubtotal',
      'error.unknownOrderItem',
      'order.fix.error.voided',
    ] as const) {
      expect(en[key]).not.toBe('');
      expect(en[key]).not.toBe(th[key]);
    }
  });
});
