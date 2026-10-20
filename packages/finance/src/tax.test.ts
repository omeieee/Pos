/**
 * Thai personal income tax estimator (P7, D-34). Golden numbers are the Revenue Department's own:
 *  - rate table 1, cumulative column: RD "วิธีกรอกแบบ ภ.ง.ด.94 ปีภาษี 2569" p.17
 *    https://www.rd.go.th/fileadmin/tax_pdf/pit/2569/Ins94_160669.pdf
 *  - 520,000 baht net income gives 30,500 baht: RD FAQ Q6.7
 *    https://www.rd.go.th/61549.html (also https://www.rd.go.th/60580.html)
 *  - the three 48(1) / 48(2) comparison cases (tax year 2552):
 *    https://www.rd.go.th/31847.html
 * The scenario tests are hand-computed in the comments, in baht.
 */
import { describe, expect, test } from 'vitest';
import { bracketTax, estimateTax, payableTax, type TaxInput } from './tax.ts';
import { thPit2569 } from './tax-rules/th-pit-2569.ts';
import type { TaxRules } from './tax-rules/types.ts';

const B = (baht: number) => baht * 100;

describe('bracketTax: the RD rate table', () => {
  // INS94 p.17 table 1, "ภาษีสะสมสูงสุดของขั้น" (cumulative tax at the top of each step), baht.
  test.each([
    [0, 0],
    [150_000, 0],
    [300_000, 7_500],
    [500_000, 27_500],
    [750_000, 65_000],
    [1_000_000, 115_000],
    [2_000_000, 365_000],
    [5_000_000, 1_265_000],
  ])('net income %i baht gives %i baht', (net, tax) => {
    expect(bracketTax(B(net), thPit2569)).toBe(B(tax));
  });

  test('RD FAQ Q6.7: 520,000 baht gives 30,500 baht (0 + 7,500 + 20,000 + 3,000)', () => {
    expect(bracketTax(B(520_000), thPit2569)).toBe(B(30_500));
  });

  test('above 5,000,000 the rate is 35%: 6,000,000 gives 1,265,000 + 350,000', () => {
    expect(bracketTax(B(6_000_000), thPit2569)).toBe(B(1_615_000));
  });

  test('rounds once, half up, to a whole satang', () => {
    // 10 satang over 150,000 baht at 5% = 0.5 satang -> 1; 9 satang = 0.45 -> 0
    expect(bracketTax(B(150_000) + 10, thPit2569)).toBe(1);
    expect(bracketTax(B(150_000) + 9, thPit2569)).toBe(0);
  });

  test('never decreases as income grows and never exceeds 35% of it (grid)', () => {
    let last = 0;
    for (let net = 0; net <= B(7_000_000); net += B(997)) {
      const tax = bracketTax(net, thPit2569);
      expect(tax).toBeGreaterThanOrEqual(last);
      expect(tax).toBeLessThanOrEqual(Math.round(net * 0.35));
      last = tax;
    }
  });

  test('refuses a negative or fractional amount', () => {
    expect(() => bracketTax(-1, thPit2569)).toThrow(RangeError);
    expect(() => bracketTax(1.5, thPit2569)).toThrow(RangeError);
  });
});

describe('payableTax: normal tax against 0.5% of gross (section 48(2))', () => {
  // https://www.rd.go.th/31847.html, the three cases (48(1) amounts are the page's own).
  test('case 1: gross 800,000, 0.5% = 4,000 (not over 5,000), normal tax 0: pays 0', () => {
    const r = payableTax(0, B(800_000), thPit2569);
    expect(r.payableSatang).toBe(0);
    expect(r.halfPercent).toBeNull();
  });

  test('case 2: gross 1,000,000, 0.5% = 5,000 exactly (inclusive), normal tax 2,000: pays 2,000', () => {
    const r = payableTax(B(2_000), B(1_000_000), thPit2569);
    expect(r.payableSatang).toBe(B(2_000));
    expect(r.halfPercent).toBeNull();
  });

  test('case 3: gross 1,100,000, 0.5% = 5,500 over 5,000, normal tax 4,000: pays 5,500', () => {
    const r = payableTax(B(4_000), B(1_100_000), thPit2569);
    expect(r.payableSatang).toBe(B(5_500));
    expect(r.halfPercent).toMatchObject({
      taxSatang: B(5_500),
      status: 'applied',
      thresholdSatang: B(120_000),
    });
  });

  test('when the normal tax is the higher one it is paid, and the 0.5% block still shows', () => {
    const r = payableTax(B(9_000), B(1_100_000), thPit2569);
    expect(r.payableSatang).toBe(B(9_000));
    expect(r.halfPercent?.taxSatang).toBe(B(5_500));
  });

  test('the 5,000 limit is compared exactly: one baht over gross 1,000,000 is over', () => {
    expect(payableTax(0, B(1_000_000), thPit2569).halfPercent).toBeNull();
    // 1,000,001 baht x 0.5% = 5,000.005 baht = 500,000.5 satang -> half up 500,001
    const r = payableTax(0, B(1_000_001), thPit2569);
    expect(r.halfPercent?.taxSatang).toBe(500_001);
    expect(r.payableSatang).toBe(500_001);
  });

  test('boundary: gross exactly 1,000,000 baht (0.5% equals the ceiling) is the normal tax; one satang over is the 0.5% method', () => {
    const at = payableTax(B(3_000), 100_000_000, thPit2569);
    expect(at.halfPercent).toBeNull();
    expect(at.payableSatang).toBe(B(3_000));
    const under = payableTax(B(3_000), 99_999_999, thPit2569);
    expect(under.halfPercent).toBeNull();
    // 100,000,001 satang x 0.5% = 500,000.005 satang -> half up 500,000 (5,000 baht)
    const over = payableTax(B(3_000), 100_000_001, thPit2569);
    expect(over.halfPercent).toMatchObject({ status: 'applied', taxSatang: 500_000 });
    expect(over.payableSatang).toBe(500_000);
  });

  test('a threshold that RD pages disagree on: between the two figures the method is NOT applied, and is named', () => {
    const rules: TaxRules = {
      ...thPit2569,
      halfPercent: { ...thPit2569.halfPercent, exemptCeilingSatang: B(100) },
    };
    // gross 100,000: 0.5% = 500 baht, over this rules set's 100 baht ceiling, above the 60,000 figure
    // but under the 120,000 figure
    const r = payableTax(B(40), B(100_000), rules);
    expect(r.payableSatang).toBe(B(40));
    expect(r.halfPercent).toMatchObject({
      status: 'not_applied_threshold_unconfirmed',
      taxSatang: B(500),
    });
  });

  test('below every threshold nothing is said', () => {
    const rules: TaxRules = {
      ...thPit2569,
      halfPercent: { ...thPit2569.halfPercent, exemptCeilingSatang: 0 },
    };
    expect(payableTax(B(1), B(50_000), rules).halfPercent).toBeNull();
  });
});

const base = (over: Partial<TaxInput> = {}): TaxInput => ({
  rules: thPit2569,
  period: 'half',
  range: { from: '2026-01-01', to: '2026-06-30' },
  asOf: '2026-10-20',
  grossIncomeSatang: B(900_000),
  expenses: {
    costOfGoodsSatang: B(300_000),
    commissionSatang: B(50_000),
    ledgerSatang: B(150_000),
    ingredientsLedgerSatang: 0,
    platformFeesLedgerSatang: 0,
  },
  pnlComplete: true,
  allowanceItems: [],
  methodPreference: null,
  incomingTransfers: null,
  ...over,
});

describe('estimateTax: owner scenario, Jan-Jun 2569 (hand-computed, baht)', () => {
  // Gross 900,000. Actual expenses 300,000 + 50,000 + 150,000 = 500,000.
  // Actual: net 400,000, less half-year personal allowance 30,000 = 370,000.
  //   tax = 7,500 (150-300k) + 70,000 x 10% = 14,500.
  // Flat 60%: expense 540,000, net 360,000 - 30,000 = 330,000 -> 7,500 + 30,000 x 10% = 10,500.
  // 0.5% of 900,000 = 4,500, not over 5,000: not used.
  const e = estimateTax(base());

  test('headline: rule year, status, estimate flag, disclaimer key, period', () => {
    expect(e.ruleYear).toBe(2569);
    expect(e.status).toBe('proposed - confirm with the Revenue Department');
    expect(e.estimateOnly).toBe(true);
    expect(e.disclaimerKey).toBe('tax.disclaimer');
    expect(e.period).toBe('half');
    expect(e.form).toBe('ภ.ง.ด.94');
  });

  test('actual expenses', () => {
    expect(e.methods.actual).toMatchObject({
      expenseSatang: B(500_000),
      netBeforeAllowancesSatang: B(400_000),
      allowancesSatang: B(30_000),
      taxableNetSatang: B(370_000),
      bracketTaxSatang: B(14_500),
      payableSatang: B(14_500),
    });
  });

  test('flat 60%', () => {
    expect(e.methods.flat).toMatchObject({
      expenseSatang: B(540_000),
      netBeforeAllowancesSatang: B(360_000),
      taxableNetSatang: B(330_000),
      bracketTaxSatang: B(10_500),
      payableSatang: B(10_500),
    });
  });

  test('the owner chose actual expenses; the cheaper method is named, not forced', () => {
    expect(e.chosenMethod).toBe('actual');
    expect(e.chosenBy).toBe('default_actual');
    expect(e.cheaperMethod).toBe('flat');
    expect(e.taxPayableSatang).toBe(B(14_500));
    expect(e.halfPercent).toBeNull();
  });

  test('allowance lines and watches', () => {
    expect(e.allowances).toEqual({ personalSatang: B(30_000), items: [], totalSatang: B(30_000) });
    expect(e.income).toEqual({ assessableSatang: B(900_000) });
  });

  test('a saved preference wins', () => {
    const f = estimateTax(base({ methodPreference: 'flat' }));
    expect(f.chosenMethod).toBe('flat');
    expect(f.chosenBy).toBe('preference');
    expect(f.taxPayableSatang).toBe(B(10_500));
  });
});

describe('estimateTax: annual return, same year', () => {
  // Same income and expenses; annual personal allowance 60,000.
  // Actual: 400,000 - 60,000 = 340,000 -> 7,500 + 40,000 x 10% = 11,500.
  // Flat:   360,000 - 60,000 = 300,000 -> 7,500.
  const e = estimateTax(
    base({ period: 'annual', range: { from: '2026-01-01', to: '2026-12-31' }, asOf: '2026-12-31' }),
  );
  test('uses the full-year allowance and the annual form', () => {
    expect(e.form).toBe('ภ.ง.ด.90');
    expect(e.allowances.personalSatang).toBe(B(60_000));
    expect(e.methods.actual.bracketTaxSatang).toBe(B(11_500));
    expect(e.methods.flat.bracketTaxSatang).toBe(B(7_500));
  });
});

describe('estimateTax: owner-entered allowances', () => {
  const items = [
    { label: 'ประกันสุขภาพ', annualSatang: B(20_000) },
    { label: 'ประกันสังคม', annualSatang: B(9_000) },
  ];
  test('annual: counted as entered', () => {
    const e = estimateTax(base({ period: 'annual', allowanceItems: items }));
    expect(e.allowances.items).toEqual([
      { label: 'ประกันสุขภาพ', annualSatang: B(20_000), appliedSatang: B(20_000) },
      { label: 'ประกันสังคม', annualSatang: B(9_000), appliedSatang: B(9_000) },
    ]);
    expect(e.allowances.totalSatang).toBe(B(60_000 + 29_000));
    expect(e.notes).toContain('tax.note.allowancesUnchecked');
  });
  test('half-year: half of the annual figure, rounded down, and flagged as an assumption', () => {
    const e = estimateTax(base({ allowanceItems: [{ label: 'x', annualSatang: 10_001 }] }));
    expect(e.allowances.items[0]?.appliedSatang).toBe(5_000);
    expect(e.notes).toContain('tax.note.halfYearAllowancesHalved');
  });
});

describe('estimateTax: loss, the 0.5% rule, a different year', () => {
  test('a loss: no tax, the negative figure is kept, the flat method still computes', () => {
    const e = estimateTax(
      base({
        grossIncomeSatang: B(100_000),
        expenses: {
          costOfGoodsSatang: B(80_000),
          commissionSatang: 0,
          ledgerSatang: B(70_000),
          ingredientsLedgerSatang: 0,
          platformFeesLedgerSatang: 0,
        },
      }),
    );
    expect(e.methods.actual.netBeforeAllowancesSatang).toBe(-B(50_000));
    expect(e.methods.actual.taxableNetSatang).toBe(0);
    expect(e.taxPayableSatang).toBe(0);
  });

  // Gross 1,200,000, actual expenses 1,150,000 -> net 50,000 -> taxable 0 (annual) -> normal tax 0.
  // 0.5% x 1,200,000 = 6,000 over 5,000 -> pays 6,000 on actual. Flat: net 480,000 - 60,000 = 420,000
  // -> 7,500 + 120,000 x 10% = 19,500, which is higher than 6,000, so flat pays 19,500.
  test('0.5% method applies and is shown, with the threshold-source note', () => {
    const e = estimateTax(
      base({
        period: 'annual',
        range: { from: '2026-01-01', to: '2026-12-31' },
        grossIncomeSatang: B(1_200_000),
        expenses: {
          costOfGoodsSatang: B(600_000),
          commissionSatang: B(100_000),
          ledgerSatang: B(450_000),
          ingredientsLedgerSatang: 0,
          platformFeesLedgerSatang: 0,
        },
      }),
    );
    expect(e.methods.actual.bracketTaxSatang).toBe(0);
    expect(e.methods.actual.payableSatang).toBe(B(6_000));
    expect(e.methods.flat.payableSatang).toBe(B(19_500));
    expect(e.halfPercent).toMatchObject({ taxSatang: B(6_000), status: 'applied' });
    expect(e.taxPayableSatang).toBe(B(6_000));
    expect(e.notes).toContain('tax.note.halfPercentThresholdSources');
  });

  test('0.5% block absent and no note when it does not apply', () => {
    const e = estimateTax(base());
    expect(e.halfPercent).toBeNull();
    expect(e.notes).not.toContain('tax.note.halfPercentThresholdSources');
  });

  test('a new year is data only: other rules, same code, other answer', () => {
    const next: TaxRules = {
      ...thPit2569,
      ruleYear: 2570,
      brackets: {
        ...thPit2569.brackets,
        tiers: [
          { overSatang: 0, ratePercent: 0 },
          { overSatang: B(200_000), ratePercent: 10 },
        ],
      },
      allowances: { ...thPit2569.allowances, personalHalfYearSatang: B(40_000) },
    };
    const e = estimateTax(base({ rules: next }));
    expect(e.ruleYear).toBe(2570);
    // actual: 400,000 - 40,000 = 360,000 -> 160,000 x 10% = 16,000
    expect(e.methods.actual.bracketTaxSatang).toBe(B(16_000));
  });
});

describe('estimateTax: the 1,000,000 baht edge of the 0.5% method', () => {
  const at = (gross: number) =>
    estimateTax(
      base({
        grossIncomeSatang: gross,
        period: 'annual',
        range: { from: '2026-01-01', to: '2026-12-31' },
        expenses: {
          costOfGoodsSatang: 0,
          commissionSatang: 0,
          ledgerSatang: 0,
          ingredientsLedgerSatang: 0,
          platformFeesLedgerSatang: 0,
        },
      }),
    );

  test('gross exactly 1,000,000 baht: no 0.5% block, no 0.5% note', () => {
    const e = at(100_000_000);
    expect(e.halfPercent).toBeNull();
    expect(e.notes).not.toContain('tax.note.halfPercentThresholdSources');
    expect(e.taxPayableSatang).toBe(e.methods.actual.payableSatang);
  });

  test('one satang over: the 0.5% block appears and is applied', () => {
    const e = at(100_000_001);
    expect(e.halfPercent).toMatchObject({ status: 'applied' });
    expect(e.notes).toContain('tax.note.halfPercentThresholdSources');
  });
});

describe('estimateTax: notes the owner must see', () => {
  test('incomplete P&L: expenses may be understated, so the tax may be too high', () => {
    expect(estimateTax(base({ pnlComplete: false })).notes).toContain('tax.note.pnlIncomplete');
    expect(estimateTax(base()).notes).not.toContain('tax.note.pnlIncomplete');
  });

  test('food cost, cost of goods larger: only cost of goods is deducted and the note says so', () => {
    // base: cost of goods 300,000; ingredients expense 100,000 is inside the ledger 150,000 (raw)
    const e = estimateTax(
      base({ expenses: { ...base().expenses, ingredientsLedgerSatang: B(100_000) } }),
    );
    expect(e.foodCostBasis).toBe('cost_of_goods');
    expect(e.foodCostNotDeductedSatang).toBe(B(100_000));
    expect(e.notes).toContain('tax.note.foodCostCostOfGoodsUsed');
    expect(e.notes).not.toContain('tax.note.foodCostIngredientsUsed');
    // actual = 300,000 + 50,000 + 150,000 - 100,000
    expect(e.methods.actual.expenseSatang).toBe(B(400_000));
  });

  test('food cost, ingredients larger: only the ingredients expense is deducted', () => {
    const bigger = estimateTax(
      base({
        expenses: {
          ...base().expenses,
          ledgerSatang: B(500_000),
          ingredientsLedgerSatang: B(400_000),
        },
      }),
    );
    expect(bigger.foodCostBasis).toBe('ingredients_expenses');
    expect(bigger.foodCostNotDeductedSatang).toBe(B(300_000));
    expect(bigger.notes).toContain('tax.note.foodCostIngredientsUsed');
    // actual = 300,000 + 50,000 + 500,000 - 300,000
    expect(bigger.methods.actual.expenseSatang).toBe(B(550_000));
  });

  test('food cost: only one of the two, no note and nothing left out', () => {
    const e = estimateTax(base());
    expect(e.foodCostBasis).toBe('only_one');
    expect(e.foodCostNotDeductedSatang).toBe(0);
    expect(e.notes).not.toContain('tax.note.foodCostCostOfGoodsUsed');
    expect(e.notes).not.toContain('tax.note.foodCostIngredientsUsed');
    expect(e.methods.actual.expenseSatang).toBe(B(500_000));
  });

  test('platform fees, commission larger: only the commission is deducted, with a note', () => {
    const e = estimateTax(
      base({ expenses: { ...base().expenses, platformFeesLedgerSatang: B(20_000) } }),
    );
    expect(e.platformFeesBasis).toBe('commission');
    expect(e.platformFeesNotDeductedSatang).toBe(B(20_000));
    expect(e.notes).toContain('tax.note.platformFeesCommissionUsed');
    expect(e.methods.actual.expenseSatang).toBe(B(480_000));
  });

  test('platform fees, the expense larger: only the expense is deducted, with a note', () => {
    const e = estimateTax(
      base({
        expenses: {
          ...base().expenses,
          ledgerSatang: B(150_000),
          platformFeesLedgerSatang: B(80_000),
        },
      }),
    );
    expect(e.platformFeesBasis).toBe('platform_fees_expenses');
    expect(e.platformFeesNotDeductedSatang).toBe(B(50_000));
    expect(e.notes).toContain('tax.note.platformFeesExpensesUsed');
    expect(e.methods.actual.expenseSatang).toBe(B(450_000));
    expect(estimateTax(base()).platformFeesBasis).toBe('only_one');
  });

  test('cost of goods comes from menu cost estimates, not receipts', () => {
    expect(estimateTax(base()).notes).toContain('tax.note.costOfGoodsEstimated');
  });

  test('actual expenses need records', () => {
    expect(estimateTax(base()).notes).toContain('tax.note.expensesNeedRecords');
  });

  test('the year is not over: says through which date', () => {
    const e = estimateTax(
      base({
        period: 'annual',
        range: { from: '2026-01-01', to: '2026-12-31' },
        asOf: '2026-10-20',
      }),
    );
    expect(e.coversThrough).toBe('2026-10-20');
    expect(e.notes).toContain('tax.note.yearNotFinished');
    expect(estimateTax(base()).coversThrough).toBe('2026-06-30');
    expect(estimateTax(base()).notes).not.toContain('tax.note.yearNotFinished');
  });

  test('annual return: the half-year tax already paid is credited, and not modelled', () => {
    expect(
      estimateTax(base({ period: 'annual', range: { from: '2026-01-01', to: '2026-12-31' } }))
        .notes,
    ).toContain('tax.note.halfYearCredit');
  });
});

describe('estimateTax: duty to file', () => {
  test('half-year income over 60,000 baht means a return, and it is late after 30 Sep 2026', () => {
    const e = estimateTax(base());
    expect(e.filing).toMatchObject({
      mustFile: true,
      window: { from: '2026-07-01', to: '2026-09-30' },
      pastDue: true,
    });
    expect(e.notes).toContain('tax.note.filingLate');
  });
  test('not past due before the window ends; exactly 60,000 is not "over"', () => {
    expect(estimateTax(base({ asOf: '2026-09-30' })).filing.pastDue).toBe(false);
    const edge = estimateTax(base({ grossIncomeSatang: B(60_000) }));
    expect(edge.filing.mustFile).toBe(false);
    expect(edge.filing.pastDue).toBe(false);
  });
});

describe('estimateTax: VAT and e-Payment watches', () => {
  test('VAT: below, near (80%), over (strictly more than 1,800,000)', () => {
    const vat = (gross: number) =>
      estimateTax(base({ period: 'annual', grossIncomeSatang: B(gross) })).watch.vat;
    expect(vat(1_000_000)).toMatchObject({ status: 'below', registrationOverSatang: B(1_800_000) });
    expect(vat(1_440_000).status).toBe('near');
    expect(vat(1_800_000).status).toBe('near');
    expect(vat(1_800_001).status).toBe('over');
  });
  test('e-Payment: unknown without a count; counts 3,000, or 400 with 2,000,000 baht', () => {
    expect(estimateTax(base()).watch.ePayment).toBeNull();
    const ep = (count: number, totalBaht: number) =>
      estimateTax(base({ incomingTransfers: { count, totalSatang: B(totalBaht) } })).watch.ePayment;
    expect(ep(100, 10_000)?.status).toBe('below');
    expect(ep(2_400, 10_000)?.status).toBe('near');
    expect(ep(3_000, 10_000)?.status).toBe('reached');
    expect(ep(399, 9_000_000)?.status).toBe('near');
    expect(ep(300, 9_000_000)?.status).toBe('below');
    expect(ep(400, 2_000_000)?.status).toBe('reached');
    expect(ep(400, 1_999_999)?.status).toBe('near');
  });
});

describe('estimateTax: output carries its sources', () => {
  test('a source list per rule, with URL and check date, and the proposed status', () => {
    const e = estimateTax(base());
    const rules = e.sources.map((s) => s.rule);
    expect(rules).toEqual(
      expect.arrayContaining([
        'brackets',
        'flatExpense',
        'allowances',
        'halfPercent',
        'filing',
        'vat',
        'ePayment',
      ]),
    );
    for (const s of e.sources) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('estimateTax: guards', () => {
  test('refuses fractional or negative money, and a range that is not the period', () => {
    expect(() => estimateTax(base({ grossIncomeSatang: 1.5 }))).toThrow(RangeError);
    expect(() => estimateTax(base({ grossIncomeSatang: -1 }))).toThrow(RangeError);
    expect(() => estimateTax(base({ expenses: { ...base().expenses, ledgerSatang: -5 } }))).toThrow(
      RangeError,
    );
    expect(() => estimateTax(base({ allowanceItems: [{ label: 'x', annualSatang: -1 }] }))).toThrow(
      RangeError,
    );
  });
});
