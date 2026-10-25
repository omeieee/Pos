import { describe, expect, test } from 'vitest';
import { cancelReasonText } from './cancel-reason.ts';

describe('the reason shown on a cancelled order', () => {
  test('the timeout of an unpaid LINE order has its own plain words', () => {
    expect(cancelReasonText('unpaid_timeout')).toEqual({ key: 'order.cancel.why.unpaidTimeout' });
  });

  test('a merged order says which order it went into', () => {
    expect(cancelReasonText('merged:L-012')).toEqual({
      key: 'order.cancel.why.merged',
      params: { orderNo: 'L-012' },
    });
  });

  test('the customer cancelling by themselves has its own words', () => {
    expect(cancelReasonText('customer_cancel')).toEqual({ key: 'order.cancel.why.customer' });
  });

  test('anything staff wrote is shown as written, with the usual label', () => {
    expect(cancelReasonText('ลูกค้าเปลี่ยนใจ')).toEqual({
      key: 'order.cancel.reasonShown',
      params: { reason: 'ลูกค้าเปลี่ยนใจ' },
    });
    // "merged:" with no number is not the server's format: shown as written.
    expect(cancelReasonText('merged:')).toEqual({
      key: 'order.cancel.reasonShown',
      params: { reason: 'merged:' },
    });
  });

  test('no reason, nothing shown', () => {
    expect(cancelReasonText(null)).toBeNull();
    expect(cancelReasonText('')).toBeNull();
  });
});
