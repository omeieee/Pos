import { describe, expect, test } from 'vitest';
import {
  appOrderInputSchema,
  customerSessionRequestSchema,
  selectPaymentInputSchema,
} from './customer-app.ts';

const REQ = '0191a8f0-0000-7000-8000-000000000001';
const ITEM = '0191a8f0-0000-7000-8000-000000000002';
const valid = {
  clientRequestId: REQ,
  items: [{ menuItemId: ITEM, qty: 2 }],
  deliveryBuilding: 'B1',
  recipientName: 'ฟ้า',
  paymentMethod: 'promptpay',
};

describe('appOrderInputSchema', () => {
  test('accepts a plain order and defaults the option list', () => {
    const parsed = appOrderInputSchema.parse(valid);
    expect(parsed.items[0]?.modifierOptionIds).toEqual([]);
  });

  test('refuses everything the server alone decides: prices, totals, channel, fulfilment, customer, staff', () => {
    for (const extra of [
      { totalSatang: 1 },
      { total: 1 },
      { channel: 'storefront' },
      { fulfillment: 'takeaway' },
      { customerId: ITEM },
      { originalStaffId: ITEM },
      { status: 'preparing' },
    ]) {
      expect(
        appOrderInputSchema.safeParse({ ...valid, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
    // a price on a line is dropped by the line schema? no: it must not be accepted as a price field
    const withPrice = appOrderInputSchema.parse({
      ...valid,
      items: [{ menuItemId: ITEM, qty: 1, priceSatang: 1 }],
    });
    expect(JSON.stringify(withPrice)).not.toContain('priceSatang');
  });

  test('needs a building, a name and a method the customer can choose', () => {
    expect(appOrderInputSchema.safeParse({ ...valid, deliveryBuilding: undefined }).success).toBe(
      false,
    );
    expect(appOrderInputSchema.safeParse({ ...valid, recipientName: ' ' }).success).toBe(false);
    expect(appOrderInputSchema.safeParse({ ...valid, paymentMethod: 'platform' }).success).toBe(
      false,
    );
  });
});

describe('selectPaymentInputSchema and customerSessionRequestSchema', () => {
  test('a method, an optional request id, nothing else', () => {
    expect(selectPaymentInputSchema.safeParse({ method: 'cash' }).success).toBe(true);
    expect(selectPaymentInputSchema.safeParse({ method: 'cash', amountSatang: 1 }).success).toBe(
      false,
    );
  });
  test('the session body holds exactly one token and never a user id', () => {
    const token = 'x'.repeat(40);
    expect(customerSessionRequestSchema.safeParse({ idToken: token }).success).toBe(true);
    expect(customerSessionRequestSchema.safeParse({ accessToken: token }).success).toBe(true);
    expect(customerSessionRequestSchema.safeParse({ idToken: token, userId: 'U1' }).success).toBe(
      false,
    );
    expect(customerSessionRequestSchema.safeParse({ userId: 'U1' }).success).toBe(false);
  });
});
