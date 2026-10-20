import type { OrderChannel, PaymentMethod } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { addIsoDays, type CashInput, cashReport } from './cash.ts';
import type { PnlExpense } from './pnl.ts';
import { type ReportOrder, revenueByDay } from './revenue.ts';

let n = 0;
const order = (
  date: string,
  paid: { method: PaymentMethod; satang: number; refund?: number | undefined }[],
  over: Partial<ReportOrder> = {},
): ReportOrder => {
  const id = ++n;
  return {
    id: `o${id}`,
    businessDate: date,
    channel: 'storefront' as OrderChannel,
    status: 'completed',
    paymentStatus: 'paid',
    totalSatang: paid.reduce((s, p) => s + p.satang, 0),
    platformCommissionSatang: null,
    placedAt: new Date(`${date}T05:00:00Z`),
    payments: paid.map((p, i) => ({
      id: `p${id}-${i}`,
      method: p.method,
      status: 'confirmed' as const,
      amountSatang: p.satang,
    })),
    refunds: paid.flatMap((p, i) =>
      p.refund ? [{ paymentId: `p${id}-${i}`, amountSatang: p.refund }] : [],
    ),
    items: [],
    ...over,
  };
};
const exp = (date: string, category: string, amountSatang: number, voided = false): PnlExpense => ({
  id: `e${++n}`,
  businessDate: date,
  category,
  amountSatang,
  voided,
});

const base = (over: Partial<CashInput> = {}): CashInput => ({
  from: '2026-10-01',
  to: '2026-10-03',
  orders: [],
  expenses: [],
  excludedOrderIds: [],
  opening: null,
  broughtForwardSatang: 0,
  includeEmptyDays: false,
  ...over,
});

describe('addIsoDays', () => {
  test('moves an ISO date over month and year ends', () => {
    expect(addIsoDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addIsoDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addIsoDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('cashReport receipts and payments', () => {
  test('cash in is the confirmed cash payments minus cash refunds; other methods get their own column', () => {
    const r = cashReport(
      base({
        orders: [
          order('2026-10-01', [{ method: 'cash', satang: 6000, refund: 1000 }]),
          order('2026-10-01', [{ method: 'promptpay', satang: 13000 }]),
          order('2026-10-01', [{ method: 'gov_copay', satang: 6000 }]),
          order('2026-10-01', [{ method: 'platform', satang: 8000 }]),
        ],
      }),
    );
    expect(r.days).toHaveLength(1);
    expect(r.days[0]).toMatchObject({
      businessDate: '2026-10-01',
      cashInSatang: 5000,
      receiptsByMethod: { cash: 5000, promptpay: 13000, gov_copay: 6000, platform: 8000, other: 0 },
      receiptsSatang: 32000,
      orderCount: 4,
      paymentsSatang: 0,
    });
  });

  test('a refund counts against the original order date, and an order that is not fully paid counts nothing', () => {
    const r = cashReport(
      base({
        orders: [
          order('2026-10-01', [{ method: 'cash', satang: 5000, refund: 5000 }]),
          order('2026-10-02', [{ method: 'cash', satang: 4000 }], {
            paymentStatus: 'partially_paid',
          }),
          order('2026-10-02', [{ method: 'cash', satang: 4000 }], { status: 'cancelled' }),
        ],
      }),
    );
    // order 1 nets to 0 on 1 Oct but still has a day row with its order; the others add nothing
    expect(r.totals.receiptsSatang).toBe(0);
    expect(r.days.map((d) => d.businessDate)).toEqual(['2026-10-01']);
  });

  test('payments split purchases (ingredients, packaging) from other expenses; voided rows are left out', () => {
    const r = cashReport(
      base({
        expenses: [
          exp('2026-10-02', 'ingredients', 15000),
          exp('2026-10-02', 'gas', 8000),
          exp('2026-10-02', 'ingredients', 99900, true),
          exp('2026-10-03', 'lunch_boxes', 2000), // an owner-added category is "other"
        ],
      }),
    );
    expect(r.days.map((d) => [d.businessDate, d.purchasesSatang, d.otherExpensesSatang])).toEqual([
      ['2026-10-02', 15000, 8000],
      ['2026-10-03', 0, 2000],
    ]);
    expect(r.totals).toMatchObject({
      purchasesSatang: 15000,
      otherExpensesSatang: 10000,
      paymentsSatang: 25000,
    });
  });

  test('the purchase categories can be given; the default is ingredients and packaging', () => {
    const rows = [exp('2026-10-01', 'packaging', 2000), exp('2026-10-01', 'lunch_boxes', 500)];
    expect(cashReport(base({ expenses: rows })).totals.purchasesSatang).toBe(2000);
    expect(
      cashReport(base({ expenses: rows, purchaseCategories: ['lunch_boxes'] })).totals
        .purchasesSatang,
    ).toBe(500);
    expect(
      cashReport(base({ expenses: rows, purchaseCategories: [] })).totals.purchasesSatang,
    ).toBe(0);
  });

  test('a day with only a voided expense has no row; empty days can be asked for', () => {
    const input = base({ expenses: [exp('2026-10-02', 'gas', 100, true)] });
    expect(cashReport(input).days).toEqual([]);
    const all = cashReport({ ...input, includeEmptyDays: true });
    expect(all.days.map((d) => d.businessDate)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(all.days.every((d) => d.receiptsSatang === 0 && d.paymentsSatang === 0)).toBe(true);
  });

  test('refuses a non-integer amount', () => {
    expect(() => cashReport(base({ expenses: [exp('2026-10-01', 'gas', 1.5)] }))).toThrow(
      RangeError,
    );
  });

  test('a day net is receipts minus payments, whatever the method', () => {
    const r = cashReport(
      base({
        orders: [order('2026-10-01', [{ method: 'promptpay', satang: 10000 }])],
        expenses: [exp('2026-10-01', 'gas', 2500)],
      }),
    );
    expect(r.days[0]?.netSatang).toBe(7500);
    expect(r.days[0]?.cashInSatang).toBe(0); // the per-method column is still there
  });

  test('summary: receipts minus payments, like the Revenue Department form', () => {
    const r = cashReport(
      base({
        orders: [order('2026-10-01', [{ method: 'cash', satang: 10000 }])],
        expenses: [exp('2026-10-01', 'gas', 2500)],
      }),
    );
    expect(r.totals.receiptsMinusPaymentsSatang).toBe(7500);
  });
});

describe('cashReport running net from the start amount', () => {
  const orders = [
    order('2026-10-01', [{ method: 'cash', satang: 10000 }]),
    order('2026-10-02', [{ method: 'promptpay', satang: 50000 }]),
    order('2026-10-03', [{ method: 'cash', satang: 3000 }]),
  ];
  const expenses = [exp('2026-10-02', 'gas', 4000), exp('2026-10-03', 'ingredients', 20000)];

  test('start amount not set: no running figure anywhere and the flag says so (never 0)', () => {
    const r = cashReport(base({ orders, expenses }));
    expect(r.openingNotSet).toBe(true);
    expect(r.runningStartSatang).toBeNull();
    expect(r.runningEndSatang).toBeNull();
    expect(r.days.every((d) => d.runningNetSatang === null)).toBe(true);
  });

  test('the start amount is the figure at the start of its day; receipts of EVERY method move it, expenses reduce it', () => {
    const r = cashReport(
      base({ orders, expenses, opening: { amountSatang: 100000, asOf: '2026-10-01' } }),
    );
    expect(r.openingNotSet).toBe(false);
    expect(r.runningStartSatang).toBe(100000);
    // 1 Oct +100.00 -> 1100.00; 2 Oct +500.00 -40.00 -> 1560.00; 3 Oct +30.00 -200.00 -> 1390.00
    expect(r.days.map((d) => d.netSatang)).toEqual([10000, 46000, -17000]);
    expect(r.days.map((d) => d.runningNetSatang)).toEqual([110000, 156000, 139000]);
    expect(r.runningEndSatang).toBe(139000);
    expect(r.totals.receiptsMinusPaymentsSatang).toBe(10000 + 50000 + 3000 - 4000 - 20000);
  });

  test('a co-pay or platform receipt moves the running net on the sale date', () => {
    const r = cashReport(
      base({
        orders: [
          order('2026-10-01', [{ method: 'gov_copay', satang: 6000 }]),
          order('2026-10-01', [{ method: 'platform', satang: 8000, refund: 1000 }]),
        ],
        opening: { amountSatang: 0, asOf: '2026-10-01' },
      }),
    );
    expect(r.days[0]?.runningNetSatang).toBe(13000);
  });

  test('days before the as-of date have no running figure, and their activity is not in it', () => {
    const r = cashReport(
      base({ orders, expenses, opening: { amountSatang: 100000, asOf: '2026-10-02' } }),
    );
    expect(r.days.map((d) => d.runningNetSatang)).toEqual([null, 146000, 129000]);
    expect(r.runningStartSatang).toBeNull(); // the range starts before the start date
    expect(r.runningEndSatang).toBe(129000);
  });

  test('an as-of date after the range: no running figure in this range', () => {
    const r = cashReport(
      base({ orders, expenses, opening: { amountSatang: 100000, asOf: '2026-11-01' } }),
    );
    expect(r.openingNotSet).toBe(false);
    expect(r.days.every((d) => d.runningNetSatang === null)).toBe(true);
    expect(r.runningEndSatang).toBeNull();
  });

  test('a range that starts after the as-of date starts from the brought-forward net', () => {
    const r = cashReport(
      base({
        from: '2026-10-02',
        orders: orders.slice(1),
        expenses,
        opening: { amountSatang: 100000, asOf: '2026-09-20' },
        broughtForwardSatang: -2500,
      }),
    );
    expect(r.runningStartSatang).toBe(97500);
    expect(r.days.map((d) => d.runningNetSatang)).toEqual([143500, 126500]);
  });

  test('the running net can go negative and is kept as a negative number', () => {
    const r = cashReport(
      base({
        expenses: [exp('2026-10-01', 'gas', 5000)],
        opening: { amountSatang: 1000, asOf: '2026-10-01' },
      }),
    );
    expect(r.days[0]?.runningNetSatang).toBe(-4000);
  });

  test('empty days carry the running net forward', () => {
    const r = cashReport(
      base({
        orders: [order('2026-10-01', [{ method: 'promptpay', satang: 100 }])],
        opening: { amountSatang: 0, asOf: '2026-10-01' },
        includeEmptyDays: true,
      }),
    );
    expect(r.days.map((d) => d.runningNetSatang)).toEqual([100, 100, 100]);
  });
});

describe('cashReport completeness and months', () => {
  test('orders set aside as inconsistent make it incomplete and are named', () => {
    const r = cashReport(base({ excludedOrderIds: ['x1'] }));
    expect(r.complete).toBe(false);
    expect(r.excludedOrderIds).toEqual(['x1']);
    expect(cashReport(base()).complete).toBe(true);
  });

  test('a range over more than one month has a row per month that has data', () => {
    const r = cashReport(
      base({
        from: '2026-09-28',
        to: '2026-10-02',
        orders: [
          order('2026-09-29', [{ method: 'cash', satang: 1000 }]),
          order('2026-10-02', [{ method: 'promptpay', satang: 2000 }]),
        ],
        expenses: [exp('2026-09-30', 'ingredients', 300)],
      }),
    );
    expect(
      r.months.map((m) => [m.month, m.receiptsSatang, m.cashInSatang, m.purchasesSatang]),
    ).toEqual([
      ['2026-09', 1000, 1000, 300],
      ['2026-10', 2000, 0, 0],
    ]);
    expect(cashReport(base()).months).toEqual([]);
  });
});

describe('cashReport reconciles with the revenue report (property)', () => {
  const methods: PaymentMethod[] = ['cash', 'promptpay', 'gov_copay', 'platform', 'other'];
  // fast-check is not a dependency: a few thousand cases from a small seeded generator.
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test('for any orders, every method column adds up to the revenue of the same day and in total', () => {
    const next = rng(20261021);
    const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
    for (let round = 0; round < 1500; round++) {
      const orders: ReportOrder[] = [];
      for (let i = 0, count = int(0, 12); i < count; i++) {
        const lines = Array.from({ length: int(1, 3) }, () => {
          const satang = int(1, 500_000);
          return {
            method: methods[int(0, 4)] as PaymentMethod,
            satang,
            refund: next() < 0.3 ? int(0, satang) : undefined,
          };
        });
        const state = next();
        orders.push(
          order(`2026-10-0${int(1, 5)}`, lines, {
            status: state < 0.1 ? 'cancelled' : 'completed',
            paymentStatus: state > 0.85 ? 'partially_paid' : 'paid',
          }),
        );
      }
      const r = cashReport(base({ from: '2026-10-01', to: '2026-10-05', orders }));
      const revenue = revenueByDay(orders);
      for (const d of r.days) {
        const day = revenue.find((x) => x.businessDate === d.businessDate);
        expect(d.receiptsSatang).toBe(day?.revenueSatang ?? 0);
        expect(Object.values(d.receiptsByMethod).reduce((s, v) => s + v, 0)).toBe(d.receiptsSatang);
        expect(Number.isInteger(d.cashInSatang)).toBe(true);
      }
      const total = revenue.reduce((s, d) => s + d.revenueSatang, 0);
      expect(r.totals.receiptsSatang).toBe(total);
      expect(r.reconciliation).toEqual({ revenueReportSatang: total, differenceSatang: 0 });
    }
  });

  test('the running net after the last day is start + brought forward + receipts - payments (any mix of methods)', () => {
    const next = rng(7);
    const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
    for (let round = 0; round < 1000; round++) {
      const orders = Array.from({ length: int(0, 8) }, () =>
        order(`2026-10-0${int(1, 5)}`, [
          { method: methods[int(0, 4)] as PaymentMethod, satang: int(1, 90_000) },
        ]),
      );
      const expenses = Array.from({ length: int(0, 8) }, () =>
        exp(
          `2026-10-0${int(1, 5)}`,
          next() < 0.5 ? 'ingredients' : 'gas',
          int(1, 90_000),
          next() < 0.2,
        ),
      );
      const opening = int(0, 1_000_000);
      const carry = int(-50_000, 50_000);
      const r = cashReport(
        base({
          from: '2026-10-01',
          to: '2026-10-05',
          orders,
          expenses,
          opening: { amountSatang: opening, asOf: '2026-09-01' },
          broughtForwardSatang: carry,
        }),
      );
      expect(r.runningEndSatang).toBe(
        opening + carry + r.totals.receiptsSatang - r.totals.paymentsSatang,
      );
      expect(r.days.reduce((sum, d) => sum + d.netSatang, 0)).toBe(
        r.totals.receiptsMinusPaymentsSatang,
      );
    }
  });
});
