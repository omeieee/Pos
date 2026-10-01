import { describe, expect, test } from 'vitest';
import { MAX_CASH_SATANG } from './cash.ts';
import {
  changePaymentMethodInputSchema,
  claimPaymentInputSchema,
  confirmPaymentInputSchema,
  createPaymentInputSchema,
  paymentDtoSchema,
  paymentReasonInputSchema,
} from './payments.ts';

let counter = 0;
const id = () => {
  counter += 1;
  return `0192f3a0-0000-7000-8000-${String(counter).padStart(12, '0')}`;
};

describe('createPaymentInputSchema', () => {
  test('cash needs tendered; every other method must not send it', () => {
    expect(
      createPaymentInputSchema.safeParse({ clientRequestId: id(), method: 'cash' }).success,
    ).toBe(false);
    expect(
      createPaymentInputSchema.safeParse({ clientRequestId: id(), method: 'cash', tendered: 10000 })
        .success,
    ).toBe(true);
    for (const method of ['promptpay', 'gov_copay', 'platform', 'other']) {
      expect(createPaymentInputSchema.safeParse({ clientRequestId: id(), method }).success).toBe(
        true,
      );
      expect(
        createPaymentInputSchema.safeParse({ clientRequestId: id(), method, tendered: 10000 })
          .success,
      ).toBe(false);
    }
  });

  test('never accepts an amount, a total or a change from the client', () => {
    for (const extra of [
      { amountSatang: 5000 },
      { amount: 5000 },
      { totalSatang: 5000 },
      { changeSatang: 100 },
      { status: 'confirmed' },
      { qrPayload: '000201' },
    ]) {
      expect(
        createPaymentInputSchema.safeParse({
          clientRequestId: id(),
          method: 'cash',
          tendered: 10000,
          ...extra,
        }).success,
      ).toBe(false);
      expect(
        createPaymentInputSchema.safeParse({ clientRequestId: id(), method: 'promptpay', ...extra })
          .success,
      ).toBe(false);
    }
  });

  test('tendered is a whole number of satang within the cash limit', () => {
    const base = { clientRequestId: id(), method: 'cash' };
    for (const tendered of [-1, 10.5, MAX_CASH_SATANG + 1, '100', null]) {
      expect(createPaymentInputSchema.safeParse({ ...base, tendered }).success).toBe(false);
    }
    expect(createPaymentInputSchema.safeParse({ ...base, tendered: 0 }).success).toBe(true);
    expect(createPaymentInputSchema.safeParse({ ...base, tendered: MAX_CASH_SATANG }).success).toBe(
      true,
    );
  });

  test('needs a UUID request id, a known method and a short non-empty note', () => {
    expect(createPaymentInputSchema.safeParse({ method: 'promptpay' }).success).toBe(false);
    expect(
      createPaymentInputSchema.safeParse({ clientRequestId: 'abc', method: 'promptpay' }).success,
    ).toBe(false);
    expect(
      createPaymentInputSchema.safeParse({ clientRequestId: id(), method: 'bitcoin' }).success,
    ).toBe(false);
    expect(
      createPaymentInputSchema.safeParse({
        clientRequestId: id(),
        method: 'other',
        referenceNote: '   ',
      }).success,
    ).toBe(false);
    const ok = createPaymentInputSchema.safeParse({
      clientRequestId: id(),
      method: 'other',
      referenceNote: '  voucher 12  ',
    });
    expect(ok.success && ok.data.referenceNote).toBe('voucher 12');
  });
});

describe('changePaymentMethodInputSchema', () => {
  test('is the same choice plus an optional expectedVersion', () => {
    expect(
      changePaymentMethodInputSchema.safeParse({
        clientRequestId: id(),
        method: 'cash',
        tendered: 5000,
        expectedVersion: 2,
      }).success,
    ).toBe(true);
    expect(
      changePaymentMethodInputSchema.safeParse({ clientRequestId: id(), method: 'promptpay' })
        .success,
    ).toBe(true);
    expect(
      changePaymentMethodInputSchema.safeParse({
        clientRequestId: id(),
        method: 'promptpay',
        expectedVersion: 0,
      }).success,
    ).toBe(false);
    expect(
      changePaymentMethodInputSchema.safeParse({
        clientRequestId: id(),
        method: 'cash',
      }).success,
    ).toBe(false);
  });
});

describe('transition inputs', () => {
  test('claim and confirm carry nothing but an optional version (and a reference for confirm)', () => {
    expect(claimPaymentInputSchema.safeParse({}).success).toBe(true);
    expect(claimPaymentInputSchema.safeParse({ expectedVersion: 3 }).success).toBe(true);
    expect(claimPaymentInputSchema.safeParse({ amountSatang: 1 }).success).toBe(false);
    expect(confirmPaymentInputSchema.safeParse({ referenceNote: 'ถุงเงิน 8841' }).success).toBe(true);
    expect(confirmPaymentInputSchema.safeParse({ amountSatang: 1 }).success).toBe(false);
  });

  test('cancel-claimed, void and refund need a reason', () => {
    expect(paymentReasonInputSchema.safeParse({}).success).toBe(false);
    expect(paymentReasonInputSchema.safeParse({ reason: '  ' }).success).toBe(false);
    expect(paymentReasonInputSchema.safeParse({ reason: 'x'.repeat(201) }).success).toBe(false);
    expect(paymentReasonInputSchema.safeParse({ reason: 'ลูกค้าเปลี่ยนใจ' }).success).toBe(true);
  });
});

describe('paymentDtoSchema', () => {
  const dto = {
    id: id(),
    orderId: id(),
    method: 'promptpay',
    status: 'pending',
    amountSatang: 7500,
    tenderedSatang: null,
    changeSatang: null,
    promptpayTargetMasked: '******4321',
    schemeId: null,
    estGovShareSatang: null,
    estCustomerShareSatang: null,
    referenceNote: null,
    claimedAt: null,
    confirmedByStaffId: null,
    confirmedAt: null,
    reason: null,
    version: 1,
    rev: 12,
  };

  test('parses a payment and drops anything not in the contract (a QR payload, a slip key)', () => {
    const parsed = paymentDtoSchema.parse({
      ...dto,
      qrPayload: '00020101021229370016A000000677010111011300660812345678',
      slipImageKey: 'slips/secret.jpg',
      clientRequestId: id(),
    });
    expect(parsed).toEqual(dto);
    expect(JSON.stringify(parsed)).not.toMatch(/qrPayload|slip|clientRequestId/);
  });

  test('refuses an unknown method or status', () => {
    expect(paymentDtoSchema.safeParse({ ...dto, method: 'card' }).success).toBe(false);
    expect(paymentDtoSchema.safeParse({ ...dto, status: 'paid' }).success).toBe(false);
  });
});
