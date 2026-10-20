/**
 * The synthetic fortnight the owner checks by hand (`docs/p7-cash-sample.md`). The expense ledger is
 * that of `docs/p7-pnl-sample.md`; the orders are its orders minus the two platform orders (20.00 and
 * 90.00) plus one partly paid order, so the receipts are 685.00. The opening cash is 500.00 at the
 * start of 24 Sep. If you change a row, change the document, or the owner will be checking figures
 * that no test pins.
 */
import type { OrderChannel, PaymentMethod } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { addIsoDays, cashReport } from './cash.ts';
import { cashCsvRows, toCsv } from './csv.ts';
import type { PnlExpense } from './pnl.ts';
import type { ReportOrder } from './revenue.ts';

interface Row {
  no: number;
  date: string;
  channel: OrderChannel;
  status?: ReportOrder['status'];
  paymentStatus?: ReportOrder['paymentStatus'];
  paid?: { method: PaymentMethod; satang: number; refund?: number };
}

const rows: Row[] = [
  { no: 1, date: '2026-09-24', channel: 'storefront', paid: { method: 'cash', satang: 13000 } },
  { no: 2, date: '2026-09-25', channel: 'line', paid: { method: 'promptpay', satang: 13000 } },
  { no: 3, date: '2026-09-26', channel: 'storefront', paid: { method: 'cash', satang: 6000 } },
  { no: 4, date: '2026-09-27', channel: 'grab', paid: { method: 'platform', satang: 8000 } },
  {
    no: 5,
    date: '2026-09-28',
    channel: 'storefront',
    paid: { method: 'cash', satang: 6000, refund: 1000 },
  },
  { no: 6, date: '2026-09-30', channel: 'storefront', paid: { method: 'gov_copay', satang: 6000 } },
  { no: 7, date: '2026-09-30', channel: 'line', status: 'cancelled', paymentStatus: 'unpaid' },
  { no: 8, date: '2026-10-01', channel: 'storefront', paid: { method: 'cash', satang: 2500 } },
  { no: 9, date: '2026-10-03', channel: 'line', paid: { method: 'promptpay', satang: 12000 } },
  { no: 10, date: '2026-10-07', channel: 'storefront', paid: { method: 'cash', satang: 3000 } },
  // cash taken but the order is not fully paid yet: not counted (as in revenue)
  {
    no: 11,
    date: '2026-10-07',
    channel: 'storefront',
    paymentStatus: 'partially_paid',
    paid: { method: 'cash', satang: 2000 },
  },
];

const toOrder = (r: Row): ReportOrder => ({
  id: `o${r.no}`,
  businessDate: r.date,
  channel: r.channel,
  status: r.status ?? 'completed',
  paymentStatus: r.paymentStatus ?? 'paid',
  totalSatang: r.paid?.satang ?? 0,
  platformCommissionSatang: null,
  placedAt: new Date(`${r.date}T05:00:00Z`),
  payments: r.paid
    ? [{ id: `p${r.no}`, method: r.paid.method, status: 'confirmed', amountSatang: r.paid.satang }]
    : [],
  refunds: r.paid?.refund ? [{ paymentId: `p${r.no}`, amountSatang: r.paid.refund }] : [],
  items: [],
});

const exp = (
  no: number,
  businessDate: string,
  category: string,
  amountSatang: number,
  voided = false,
): PnlExpense => ({ id: `e${no}`, businessDate, category, amountSatang, voided });

const orders = rows.map(toOrder);
const expenses = [
  exp(1, '2026-09-24', 'ingredients', 15000),
  exp(2, '2026-09-26', 'gas', 8000),
  exp(3, '2026-09-28', 'platform_fees', 1500),
  exp(4, '2026-09-29', 'ingredients', 99900, true), // typed wrongly, voided
  exp(5, '2026-10-02', 'ingredients', 10000),
  exp(6, '2026-10-04', 'packaging', 2000),
  exp(7, '2026-10-06', 'other', 1000),
];
const opening = { amountSatang: 50000, asOf: '2026-09-24' };

/** What the API loads for a range: only the rows whose business date is inside it. */
const within = (from: string, to: string) => ({
  orders: orders.filter((o) => o.businessDate >= from && o.businessDate <= to),
  expenses: expenses.filter((e) => e.businessDate >= from && e.businessDate <= to),
});

const summary = (r: ReturnType<typeof cashReport>) =>
  r.days.map((d) => [
    d.businessDate,
    d.cashInSatang,
    d.receiptsSatang,
    d.paymentsSatang,
    d.runningNetSatang,
  ]);

describe('the owner cash sample (docs/p7-cash-sample.md)', () => {
  const whole = cashReport({
    from: '2026-09-24',
    to: '2026-10-07',
    orders,
    excludedOrderIds: [],
    expenses,
    opening,
  });

  test('day by day: cash column, all receipts, payments and the running net from the start amount', () => {
    expect(summary(whole)).toEqual([
      ['2026-09-24', 13000, 13000, 15000, 48000],
      ['2026-09-25', 0, 13000, 0, 61000],
      ['2026-09-26', 6000, 6000, 8000, 59000],
      ['2026-09-27', 0, 8000, 0, 67000],
      ['2026-09-28', 5000, 5000, 1500, 70500],
      ['2026-09-30', 0, 6000, 0, 76500],
      ['2026-10-01', 2500, 2500, 0, 79000],
      ['2026-10-02', 0, 0, 10000, 69000],
      ['2026-10-03', 0, 12000, 0, 81000],
      ['2026-10-04', 0, 0, 2000, 79000],
      ['2026-10-06', 0, 0, 1000, 78000],
      ['2026-10-07', 3000, 3000, 0, 81000],
    ]);
  });

  test('totals, the Revenue Department summary line and the tie to the revenue report', () => {
    expect(whole.totals).toMatchObject({
      receiptsByMethod: {
        cash: 29500,
        promptpay: 25000,
        gov_copay: 6000,
        platform: 8000,
        other: 0,
      },
      receiptsSatang: 68500,
      cashInSatang: 29500,
      purchasesSatang: 27000, // ingredients 150.00 + 100.00 and packaging 20.00 (the voided 999.00 is out)
      otherExpensesSatang: 10500, // gas 80.00, platform_fees 15.00, other 10.00
      paymentsSatang: 37500,
      receiptsMinusPaymentsSatang: 31000,
      orderCount: 9,
    });
    expect(whole.runningStartSatang).toBe(50000);
    expect(whole.runningEndSatang).toBe(81000); // 500.00 + 685.00 - 375.00
    expect(whole.reconciliation).toEqual({ revenueReportSatang: 68500, differenceSatang: 0 });
    expect(whole.complete).toBe(true);
  });

  test('month rows: September and October', () => {
    expect(
      whole.months.map((m) => [
        m.month,
        m.receiptsSatang,
        m.cashInSatang,
        m.purchasesSatang,
        m.paymentsSatang,
      ]),
    ).toEqual([
      ['2026-09', 51000, 24000, 15000, 24500],
      ['2026-10', 17500, 5500, 12000, 13000],
    ]);
  });

  test('asking only for 1-7 Oct starts from the brought-forward net of 24-30 Sep (+265.00): same running figures', () => {
    const before = cashReport({
      from: '2026-09-24',
      to: addIsoDays('2026-10-01', -1),
      ...within('2026-09-24', '2026-09-30'),
      excludedOrderIds: [],
      opening: null,
    });
    expect(before.totals.receiptsMinusPaymentsSatang).toBe(26500); // 510.00 - 245.00
    const oct = cashReport({
      from: '2026-10-01',
      to: '2026-10-07',
      ...within('2026-10-01', '2026-10-07'),
      excludedOrderIds: [],
      opening,
      broughtForwardSatang: before.totals.receiptsMinusPaymentsSatang,
    });
    expect(oct.runningStartSatang).toBe(76500);
    expect(oct.days.map((d) => d.runningNetSatang)).toEqual([
      79000, 69000, 81000, 79000, 78000, 81000,
    ]);
  });

  test('the CSV of the whole fortnight, as the accountant would open it', () => {
    const csv = toCsv(
      cashCsvRows(
        whole,
        [
          'date',
          'cash',
          'promptpay',
          'copay',
          'platform',
          'other',
          'receipts',
          'goods',
          'expenses',
          'payments',
          'running',
        ],
        'total',
      ),
    ).split('\r\n');
    expect(csv[1]).toBe('2026-09-24,130.00,0.00,0.00,0.00,0.00,130.00,150.00,0.00,150.00,480.00');
    expect(csv[csv.length - 2]).toBe(
      'total,295.00,250.00,60.00,80.00,0.00,685.00,270.00,105.00,375.00,',
    );
  });
});
