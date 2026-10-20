/**
 * The worksheet the owner (or an accountant) checks by hand: `docs/p7-tax-sample.md`. The figures
 * here are that worksheet's, in baht. If you change one, change the other. The shop figures are
 * made up; the rules are tax year 2569 (rate table, 30,000 half-year allowance, 60% flat rate).
 */
import { describe, expect, test } from 'vitest';
import type { ReportOrder } from './revenue.ts';
import { estimateTax, incomingPromptpayTransfers, type TaxInput } from './tax.ts';
import { thPit2569 } from './tax-rules/th-pit-2569.ts';

const B = (baht: number) => baht * 100;

const halfYear: TaxInput = {
  rules: thPit2569,
  period: 'half',
  range: { from: '2026-01-01', to: '2026-06-30' },
  asOf: '2026-10-20',
  grossIncomeSatang: B(540_000),
  expenses: {
    costOfGoodsSatang: B(150_000),
    commissionSatang: B(18_000),
    // rent 60,000 + gas 30,000 + utilities 24,000 + packaging 18,000 + other 12,000
    ledgerSatang: B(144_000),
    ingredientsLedgerSatang: 0,
  },
  pnlComplete: true,
  allowanceItems: [],
  methodPreference: 'actual',
  incomingTransfers: null,
};

describe('worksheet A: half-year, Jan-Jun 2569, ภ.ง.ด.94 basis', () => {
  const e = estimateTax(halfYear);
  test('actual expenses: 312,000 expenses, 228,000 net, 198,000 taxable, tax 2,400', () => {
    expect(e.methods.actual).toMatchObject({
      expenseSatang: B(312_000),
      netBeforeAllowancesSatang: B(228_000),
      allowancesSatang: B(30_000),
      taxableNetSatang: B(198_000),
      bracketTaxSatang: B(2_400),
      payableSatang: B(2_400),
    });
  });
  test('flat 60%: 324,000 expenses, 216,000 net, 186,000 taxable, tax 1,800', () => {
    expect(e.methods.flat).toMatchObject({
      expenseSatang: B(324_000),
      netBeforeAllowancesSatang: B(216_000),
      taxableNetSatang: B(186_000),
      payableSatang: B(1_800),
    });
  });
  test('chosen actual pays 2,400; flat would be cheaper by 600; 0.5% is 2,700 and does not apply', () => {
    expect(e.taxPayableSatang).toBe(B(2_400));
    expect(e.cheaperMethod).toBe('flat');
    expect(e.halfPercent).toBeNull();
  });
  test('must file (540,000 is over 60,000) and the window ended 30 Sep 2026', () => {
    expect(e.filing).toMatchObject({ mustFile: true, pastDue: true });
  });
  test('VAT is 30% of the threshold: below', () => {
    expect(e.watch.vat).toMatchObject({ status: 'below', percentOfThreshold: 30 });
  });
});

describe('worksheet B: a year with revenue over 1,000,000 (0.5% method)', () => {
  const e = estimateTax({
    ...halfYear,
    period: 'annual',
    range: { from: '2026-01-01', to: '2026-12-31' },
    asOf: '2026-12-31',
    grossIncomeSatang: B(1_200_000),
    expenses: {
      costOfGoodsSatang: B(600_000),
      commissionSatang: B(100_000),
      ledgerSatang: B(450_000),
      ingredientsLedgerSatang: 0,
    },
  });
  test('actual: net 50,000 less 60,000 is 0 normal tax, but 0.5% of 1,200,000 is 6,000, paid', () => {
    expect(e.methods.actual.taxableNetSatang).toBe(0);
    expect(e.halfPercent?.taxSatang).toBe(B(6_000));
    expect(e.taxPayableSatang).toBe(B(6_000));
  });
  test('flat: 720,000 expenses, 480,000 net, 420,000 taxable, 19,500 tax', () => {
    expect(e.methods.flat.taxableNetSatang).toBe(B(420_000));
    expect(e.methods.flat.payableSatang).toBe(B(19_500));
  });
});

describe('incomingPromptpayTransfers', () => {
  const order = (id: string, over: Partial<ReportOrder>): ReportOrder => ({
    id,
    businessDate: '2026-03-01',
    channel: 'storefront',
    status: 'completed',
    paymentStatus: 'paid',
    totalSatang: 6_000,
    platformCommissionSatang: null,
    placedAt: new Date('2026-03-01T05:00:00Z'),
    payments: [{ id: `${id}p`, method: 'promptpay', status: 'confirmed', amountSatang: 6_000 }],
    refunds: [],
    items: [],
    ...over,
  });
  test('counts confirmed PromptPay payments of counted orders only', () => {
    const orders = [
      order('a', {}),
      order('b', {
        payments: [
          { id: 'b1', method: 'promptpay', status: 'confirmed', amountSatang: 4_000 },
          { id: 'b2', method: 'cash', status: 'confirmed', amountSatang: 2_000 },
        ],
      }),
      order('c', { paymentStatus: 'unpaid' }),
      order('d', { status: 'cancelled' }),
      order('e', {
        payments: [{ id: 'e1', method: 'promptpay', status: 'pending', amountSatang: 6_000 }],
      }),
    ];
    expect(incomingPromptpayTransfers(orders)).toEqual({ count: 2, totalSatang: 10_000 });
  });
});
