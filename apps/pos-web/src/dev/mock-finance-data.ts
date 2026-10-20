/**
 * Made-up figures for the P7 screens in `pnpm dev` and in tests: the profit-and-loss and tax
 * answers of the hand-check samples (`docs/p7-pnl-sample.md`, `docs/p7-tax-sample.md`). Nothing
 * here is real shop data, and the two commission rates behind it are examples only. These are
 * shaped like the real answers (the mock tests parse them with the shared schemas) but they are
 * NOT computed: the real maths lives in `@sds/finance` on the server.
 */
import {
  type ExpenseDto,
  expenseDtoSchema,
  type PnlReport,
  pnlReportSchema,
  type TaxReport,
  taxReportSchema,
} from '@sds/shared';

const uuid = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** The rows of the expense ledger in the P&L sample (row 4 was typed wrongly and voided). */
export const SAMPLE_EXPENSES: readonly ExpenseDto[] = expenseDtoSchema.array().parse(
  [
    ['2026-09-24', 'ingredients', 15000, 'ตลาดสด', null],
    ['2026-09-26', 'gas', 8000, null, null],
    ['2026-09-28', 'platform_fees', 1500, null, 'ค่าธรรมเนียมอื่นนอกจากค่าคอมมิชชัน'],
    ['2026-09-29', 'ingredients', 99900, null, 'พิมพ์ผิด'],
    ['2026-10-02', 'ingredients', 10000, 'ตลาดสด', null],
    ['2026-10-04', 'packaging', 2000, null, null],
    ['2026-10-06', 'other', 1000, null, null],
  ].map(([businessDate, category, amountSatang, vendor, note], index) => {
    const voided = index === 3;
    return {
      id: uuid(7000 + index),
      businessDate: businessDate as string,
      category: category as string,
      amountSatang: amountSatang as number,
      vendor: vendor as string | null,
      note: note as string | null,
      receiptImageKey: null,
      createdByStaffId: null,
      voided,
      voidedAt: voided ? '2026-09-29T09:00:00.000Z' : null,
      voidReason: voided ? 'พิมพ์ยอดผิด' : null,
      version: voided ? 2 : 1,
      rev: 1,
    };
  }),
);

const margin = (costedRevenue: number, cost: number) => ({
  costedOrderCount: 10,
  costedRevenueSatang: costedRevenue,
  costSatang: cost,
  grossProfitSatang: costedRevenue - cost,
  marginBp: 6313,
  uncostedOrderIds: [uuid(3)],
  uncostedRevenueSatang: 6000,
  uncostedMenuItemIds: [uuid(204)],
});

/**
 * The P&L sample over 24 Sep - 7 Oct with both rates set: incomplete because order 3 has no
 * cost. `expensesSatang` and the per-category rows are replaced by the dev shop from its live
 * ledger, so adding or voiding an expense moves the profit.
 */
export const SAMPLE_PNL: PnlReport = pnlReportSchema.parse({
  from: '2026-09-24',
  to: '2026-10-07',
  revenueSatang: 79500,
  orderCount: 11,
  costOfGoodsSatang: 27100,
  uncostedRevenueSatang: 6000,
  grossProfitSatang: 52400,
  commissionSatang: 4550,
  expensesSatang: 37500,
  netProfitSatang: 10350,
  complete: false,
  incompleteReasons: ['orders_uncosted'],
  missing: {
    excludedOrderIds: [],
    uncostedOrderIds: [uuid(3)],
    uncostedMenuItemIds: [uuid(204)],
    rateNotSetOrderIds: [],
    ratesNotSet: [],
  },
  margin: margin(73500, 27100),
  commission: {
    recordedSatang: 300,
    recordedOrderCount: 1,
    estimatedSatang: 4250,
    estimatedOrderCount: 2,
    totalSatang: 4550,
    rateNotSetOrderIds: [],
    ratesNotSet: [],
  },
  expensesByCategory: [
    { category: 'ingredients', totalSatang: 25000, count: 2 },
    { category: 'gas', totalSatang: 8000, count: 1 },
    { category: 'packaging', totalSatang: 2000, count: 1 },
    { category: 'platform_fees', totalSatang: 1500, count: 1 },
    { category: 'other', totalSatang: 1000, count: 1 },
  ],
  voidedExpenseCount: 1,
  platformFeesAlsoCommission: true,
  govCopay: { revenueSatang: 6000, receivable: 'not_built' },
  months: [
    {
      month: '2026-09',
      revenueSatang: 53000,
      orderCount: 7,
      costOfGoodsSatang: 17800,
      uncostedRevenueSatang: 6000,
      grossProfitSatang: 35200,
      commissionSatang: 2300,
      expensesSatang: 24500,
      netProfitSatang: 8400,
      complete: false,
    },
    {
      month: '2026-10',
      revenueSatang: 26500,
      orderCount: 4,
      costOfGoodsSatang: 9300,
      uncostedRevenueSatang: 0,
      grossProfitSatang: 17200,
      commissionSatang: 2250,
      expensesSatang: 13000,
      netProfitSatang: 1950,
      complete: true,
    },
  ],
});

const SOURCES = [
  {
    rule: 'brackets',
    url: 'https://www.rd.go.th/fileadmin/tax_pdf/pit/2569/Ins94_160669.pdf',
    checkedOn: '2026-10-20',
    says: 'p.17 table 1: rate table, cumulative tax column',
  },
  {
    rule: 'flatExpense',
    url: 'https://www.rd.go.th/fileadmin/tax_pdf/pit/2569/Ins94_160669.pdf',
    checkedOn: '2026-10-20',
    says: 'p.17 table 2 item (9) restaurant, food and drink: 60 percent',
  },
  {
    rule: 'allowances',
    url: 'https://www.rd.go.th/61549.html',
    checkedOn: '2026-10-20',
    says: 'half-year return: allowances only half',
  },
];

/** Worksheet A of the tax sample (Jan-Jun 2569, ภ.ง.ด.94), or the same shop over the whole year. */
export function sampleTax(period: 'annual' | 'half', year = 2569): TaxReport {
  const half = period === 'half';
  const gregorian = year - 543;
  const personal = half ? 3_000_000 : 6_000_000;
  return taxReportSchema.parse({
    ruleYear: 2569,
    status: 'proposed - confirm with the Revenue Department',
    estimateOnly: true,
    disclaimerKey: 'tax.disclaimer',
    period,
    form: half ? 'ภ.ง.ด.94' : 'ภ.ง.ด.90',
    range: {
      from: `${gregorian}-01-01`,
      to: half ? `${gregorian}-06-30` : `${gregorian}-12-31`,
    },
    coversThrough: half ? `${gregorian}-06-30` : `${gregorian}-10-20`,
    income: { assessableSatang: 54_000_000 },
    methods: {
      actual: {
        expenseSatang: 31_200_000,
        netBeforeAllowancesSatang: 22_800_000,
        allowancesSatang: personal,
        taxableNetSatang: 22_800_000 - personal,
        bracketTaxSatang: half ? 240_000 : 0,
        payableSatang: half ? 240_000 : 0,
      },
      flat: {
        expenseSatang: 32_400_000,
        netBeforeAllowancesSatang: 21_600_000,
        allowancesSatang: personal,
        taxableNetSatang: 21_600_000 - personal,
        bracketTaxSatang: half ? 180_000 : 0,
        payableSatang: half ? 180_000 : 0,
      },
    },
    chosenMethod: 'actual',
    chosenBy: 'default_actual',
    cheaperMethod: half ? 'flat' : 'actual',
    halfPercent: null,
    taxPayableSatang: half ? 240_000 : 0,
    allowances: { personalSatang: personal, items: [], totalSatang: personal },
    pnlComplete: false,
    incompleteReasons: ['orders_uncosted'],
    foodCostMayBeCountedTwice: false,
    filing: {
      mustFile: true,
      incomeOverSatang: half ? 6_000_000 : 12_000_000,
      window: half
        ? { from: `${gregorian}-07-01`, to: `${gregorian}-09-30` }
        : { from: `${gregorian + 1}-01-01`, to: `${gregorian + 1}-03-31` },
      pastDue: half,
    },
    watch: {
      vat: {
        status: 'below',
        revenueSatang: 54_000_000,
        registrationOverSatang: 180_000_000,
        percentOfThreshold: 30,
      },
      ePayment: {
        status: 'below',
        count: 120,
        totalSatang: 18_000_000,
        transferCount: 400,
        altTransferCount: 200,
        altTotalSatang: 300_000_000,
      },
    },
    notes: [
      'tax.note.pnlIncomplete',
      'tax.note.costOfGoodsEstimated',
      'tax.note.expensesNeedRecords',
      half ? 'tax.note.filingLate' : 'tax.note.halfYearCredit',
    ],
    sources: SOURCES,
  });
}
