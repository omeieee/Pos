import { describe, expect, test } from 'vitest';
import {
  appOpenOrdersSchema,
  appOrderCancelInputSchema,
  appOrderEditInputSchema,
  appOrderInputSchema,
  appOrderMergeInputSchema,
  customerSessionRequestSchema,
  customerSlipCheck,
  selectPaymentInputSchema,
  slipNeedsCombineSchema,
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

describe('customerSlipCheck', () => {
  test('no picture is none, whatever the check says', () => {
    expect(customerSlipCheck({ hasSlip: false, slipVerify: null })).toBe('none');
    expect(customerSlipCheck({ hasSlip: false, slipVerify: 'valid' })).toBe('none');
  });

  test('a check still running is checking', () => {
    expect(customerSlipCheck({ hasSlip: true, slipVerify: 'pending' })).toBe('checking');
  });

  test('only a bank-checked amount mismatch is told apart', () => {
    expect(customerSlipCheck({ hasSlip: true, slipVerify: 'amount_mismatch' })).toBe(
      'amount_mismatch',
    );
  });

  test('a valid bank check on a payment that is still open waits for the shop (A2)', () => {
    expect(customerSlipCheck({ hasSlip: true, slipVerify: 'valid' })).toBe('verified_waiting');
  });

  test('every other finished check, and a slip never marked for one, is the same staff_review', () => {
    for (const slipVerify of [
      'receiver_mismatch',
      'date_mismatch',
      'not_found',
      'fraud',
      'unchecked',
      null,
    ]) {
      expect(customerSlipCheck({ hasSlip: true, slipVerify })).toBe('staff_review');
    }
  });
});

describe('edit, cancel, merge and open-order shapes (D-39)', () => {
  const ORDER = '0191a8f0-0000-7000-8000-000000000003';
  const items = [{ menuItemId: ITEM, qty: 1 }];

  test('edit: a version and lines, nothing else, no prices', () => {
    const parsed = appOrderEditInputSchema.parse({ expectedVersion: 2, items });
    expect(parsed.items[0]?.modifierOptionIds).toEqual([]);
    expect(appOrderEditInputSchema.safeParse({ items }).success).toBe(false);
    expect(appOrderEditInputSchema.safeParse({ expectedVersion: 2, items: [] }).success).toBe(
      false,
    );
    expect(
      appOrderEditInputSchema.safeParse({ expectedVersion: 2, items, totalSatang: 1 }).success,
    ).toBe(false);
  });

  test('cancel: only a version', () => {
    expect(appOrderCancelInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(true);
    expect(appOrderCancelInputSchema.safeParse({}).success).toBe(false);
    expect(appOrderCancelInputSchema.safeParse({ expectedVersion: 1, reason: 'x' }).success).toBe(
      false,
    );
  });

  test('merge: the target version, and one version per source', () => {
    const ok = { expectedVersion: 1, sourceIds: [ORDER], expectedVersions: [3] };
    expect(appOrderMergeInputSchema.safeParse(ok).success).toBe(true);
    expect(appOrderMergeInputSchema.safeParse({ ...ok, expectedVersions: [] }).success).toBe(false);
    expect(appOrderMergeInputSchema.safeParse({ ...ok, sourceIds: [] }).success).toBe(false);
    expect(appOrderMergeInputSchema.safeParse({ ...ok, sourceIds: [ORDER, ORDER] }).success).toBe(
      false,
    );
  });

  test('open orders list carries what the checkout warning needs', () => {
    const order = {
      id: ORDER,
      orderNo: 'L-001',
      totalSatang: 5000,
      version: 1,
      businessDate: '2026-10-24',
      deliveryBuilding: 'B1',
      recipientName: 'ฟ้า',
      placedAt: '2026-10-24T03:00:00.000Z',
      items: [{ menuItemId: ITEM, nameTh: 'ก๋วยเตี๋ยว', nameEn: null, qty: 1, modifierOptionIds: [] }],
    };
    expect(appOpenOrdersSchema.safeParse({ orders: [order] }).success).toBe(true);
    expect(
      appOpenOrdersSchema.safeParse({ orders: [{ ...order, totalSatang: 1.5 }] }).success,
    ).toBe(false);
  });

  test('the combine answer names the orders and the total', () => {
    const answer = { orderNos: ['L-001', 'L-002'], orderIds: [ORDER, ITEM], totalSatang: 10000 };
    expect(slipNeedsCombineSchema.safeParse(answer).success).toBe(true);
    expect(slipNeedsCombineSchema.safeParse({ ...answer, orderNos: [] }).success).toBe(false);
  });
});
