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

describe('errors of the partial adjustment', () => {
  const CODES = {
    ADJUST_CLAIM_OPEN: 'error.adjustClaimOpen',
    ADJUST_TOTAL_ZERO: 'error.adjustTotalZero',
    ADJUST_METHOD_NOT_ADJUSTABLE: 'error.adjustMethodNotAdjustable',
    REFUND_DETAILS_REQUIRED: 'error.refundDetailsRequired',
    REFUND_NOT_NEEDED: 'error.refundNotNeeded',
  } as const;

  test.each(Object.entries(CODES))('%s has its own Thai and English message', (code, key) => {
    expect(say(code, 'correction')).toBe(th[key as keyof typeof th]);
    expect(en[key as keyof typeof en]).not.toBe(th[key as keyof typeof th]);
  });

  test('the two that need an action say what to do', () => {
    expect(th['error.adjustClaimOpen']).toContain('หน้าชำระเงิน');
    expect(th['error.adjustMethodNotAdjustable']).toContain('คืนเงินทั้งหมด');
  });
});
