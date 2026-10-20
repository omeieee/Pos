import { REPORT_MAX_DAYS } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { SAMPLE_EXPENSES, SAMPLE_PNL, sampleTax } from '../../dev/mock-finance-data.ts';
import {
  activeCategories,
  addCategory,
  buildExpenseCreate,
  buildExpensePatch,
  categoryName,
  categoryOptions,
  emptyExpenseForm,
  expenseFormFrom,
  setCategoryActive,
  validateExpenseForm,
} from './expense-model.ts';
import { expenseRows, incompleteDetails } from './pnl-model.ts';
import { resolveRange } from './range-model.ts';
import {
  buddhistYear,
  buildTaxProfile,
  formFromProfile,
  reasonKey,
  splitNotes,
  validateTaxProfileForm,
  yearChoices,
} from './tax-model.ts';

const TODAY = '2026-10-20';
const categories = [
  { key: 'gas', nameTh: 'แก๊ส', nameEn: 'Gas', active: true },
  { key: 'rent', nameTh: 'ค่าเช่า', nameEn: null, active: false },
];
const row = SAMPLE_EXPENSES[0];
if (!row) throw new Error('fixture missing');

describe('the period of a finance screen', () => {
  test('a preset is the same range as the overview (month so far)', () => {
    expect(resolveRange('month', TODAY, { from: '', to: '' })).toEqual({
      ok: true,
      range: { from: '2026-10-01', to: TODAY },
    });
  });

  test('a custom range must have both dates, in order, and fit the report limit', () => {
    expect(resolveRange('custom', TODAY, { from: '2026-10-01', to: '2026-10-07' })).toEqual({
      ok: true,
      range: { from: '2026-10-01', to: '2026-10-07' },
    });
    expect(resolveRange('custom', TODAY, { from: '', to: '2026-10-07' })).toEqual({
      ok: false,
      problem: 'missing',
    });
    expect(resolveRange('custom', TODAY, { from: '2026-10-08', to: '2026-10-07' })).toEqual({
      ok: false,
      problem: 'invalid',
    });
    expect(resolveRange('custom', TODAY, { from: '2025-01-01', to: '2026-10-07' })).toEqual({
      ok: false,
      problem: 'tooLong',
    });
    const edge = resolveRange('custom', TODAY, { from: '2026-01-01', to: '2026-12-31' });
    expect(edge.ok).toBe(true);
    expect(REPORT_MAX_DAYS).toBe(366);
  });
});

describe('the expense form', () => {
  test('a new form starts today on the first active category', () => {
    expect(emptyExpenseForm(TODAY, categories)).toEqual({
      date: TODAY,
      category: 'gas',
      amount: '',
      vendor: '',
      note: '',
    });
  });

  test('the amount is read as exact baht text and must be above zero', () => {
    const form = { ...emptyExpenseForm(TODAY, categories), amount: '49.5' };
    expect(validateExpenseForm(form)).toEqual([]);
    expect(buildExpenseCreate(form)).toEqual({
      businessDate: TODAY,
      category: 'gas',
      amountSatang: 4950,
      vendor: null,
      note: null,
    });
    for (const amount of ['', '0', '-5', 'abc', '1.234']) {
      expect(validateExpenseForm({ ...form, amount })).toContain('amount');
    }
  });

  test('a future date is allowed; a missing date or category is not', () => {
    const form = { ...emptyExpenseForm(TODAY, categories), amount: '10' };
    expect(validateExpenseForm({ ...form, date: '2027-01-05' })).toEqual([]);
    expect(validateExpenseForm({ ...form, date: '' })).toContain('date');
    expect(validateExpenseForm({ ...form, category: '' })).toContain('category');
  });

  test('vendor and note have the server limits', () => {
    const form = { ...emptyExpenseForm(TODAY, categories), amount: '10' };
    expect(validateExpenseForm({ ...form, vendor: 'x'.repeat(101) })).toContain('vendor');
    expect(validateExpenseForm({ ...form, note: 'x'.repeat(301) })).toContain('note');
  });

  test('an edit sends only what changed with the version, and nothing when nothing did', () => {
    const form = expenseFormFrom(row);
    expect(form.amount).toBe('150');
    expect(buildExpensePatch(row, form)).toBeNull();
    expect(buildExpensePatch(row, { ...form, amount: '160.50', note: 'ใหม่' })).toEqual({
      expectedVersion: row.version,
      amountSatang: 16050,
      note: 'ใหม่',
    });
    expect(buildExpensePatch(row, { ...form, vendor: '' })).toEqual({
      expectedVersion: row.version,
      vendor: null,
    });
  });
});

describe('expense categories', () => {
  test('names follow the language and fall back to the other one, then to the key', () => {
    expect(categoryName(categories, 'gas', 'en')).toBe('Gas');
    expect(categoryName(categories, 'gas', 'th')).toBe('แก๊ส');
    expect(categoryName(categories, 'rent', 'en')).toBe('ค่าเช่า');
    expect(categoryName(categories, 'gone', 'th')).toBe('gone');
  });

  test('new expenses offer active categories; an edit keeps a switched-off one it already has', () => {
    expect(activeCategories(categories).map((c) => c.key)).toEqual(['gas']);
    expect(categoryOptions(categories, undefined).map((c) => c.key)).toEqual(['gas']);
    expect(categoryOptions(categories, 'rent').map((c) => c.key)).toEqual(['gas', 'rent']);
  });

  test('adding a category makes a valid, unique key and never drops one', () => {
    const added = addCategory(categories, { nameTh: 'กล่องข้าว', nameEn: 'Lunch boxes' });
    expect(added?.map((c) => c.key)).toEqual(['gas', 'rent', 'lunch_boxes']);
    const again = addCategory(added ?? [], { nameTh: 'กล่องข้าว 2', nameEn: 'Lunch boxes' });
    expect(again?.map((c) => c.key)).toEqual(['gas', 'rent', 'lunch_boxes', 'lunch_boxes_2']);
    // A Thai-only name has no Latin letters to make a slug from.
    const thaiOnly = addCategory(categories, { nameTh: 'น้ำแข็ง', nameEn: '' });
    expect(thaiOnly?.at(-1)?.key).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
    expect(thaiOnly?.at(-1)).toMatchObject({ nameTh: 'น้ำแข็ง', nameEn: null, active: true });
    expect(addCategory(categories, { nameTh: '  ', nameEn: '' })).toBeNull();
    expect(addCategory(categories, { nameTh: 'x', nameEn: 'y'.repeat(200) })?.at(-1)?.key).toMatch(
      /^[a-z][a-z0-9_]{0,39}$/,
    );
  });

  test('a category is switched off or on in place', () => {
    const off = setCategoryActive(categories, 'gas', false);
    expect(off).toHaveLength(2);
    expect(off.find((c) => c.key === 'gas')?.active).toBe(false);
    expect(setCategoryActive(off, 'gas', true).find((c) => c.key === 'gas')?.active).toBe(true);
  });
});

describe('profit and loss layout', () => {
  test('expense rows get their names from the category list and keep the server order', () => {
    const rows = expenseRows(
      [
        { category: 'gas', totalSatang: 8000, count: 1 },
        { category: 'custom_x', totalSatang: 500, count: 2 },
      ] as never,
      categories,
      'en',
    );
    expect(rows).toEqual([
      { category: 'gas', name: 'Gas', totalSatang: 8000, count: 1 },
      { category: 'custom_x', name: 'custom_x', totalSatang: 500, count: 2 },
    ]);
  });

  test('the incomplete details count what the answer lists, and name the platforms', () => {
    const details = incompleteDetails({
      ...SAMPLE_PNL,
      complete: false,
      incompleteReasons: ['orders_uncosted', 'commission_rate_not_set'],
      missing: {
        excludedOrderIds: ['a'],
        uncostedOrderIds: ['b', 'c'],
        uncostedMenuItemIds: ['d'],
        rateNotSetOrderIds: ['e', 'f', 'g'],
        ratesNotSet: ['grab', 'lineman'],
      },
    });
    expect(details).toMatchObject({
      reasons: ['orders_uncosted', 'commission_rate_not_set'],
      excluded: 1,
      uncostedOrders: 2,
      uncostedItems: 1,
      rateNotSetOrders: 3,
      platformsNotSet: ['grab', 'lineman'],
    });
  });
});

describe('the tax screen', () => {
  test('the Buddhist Era year is the Gregorian year + 543; the choices go back two years', () => {
    expect(buddhistYear(TODAY)).toBe(2569);
    expect(yearChoices(TODAY)).toEqual([2569, 2568, 2567]);
  });

  test('flags and their notes are one list of warnings, the rest are plain notes', () => {
    const report = { ...sampleTax('half'), foodCostMayBeCountedTwice: true };
    report.notes = [
      'tax.note.pnlIncomplete',
      'tax.note.foodCostTwice',
      'tax.note.costOfGoodsEstimated',
      'tax.note.filingLate',
    ];
    const { warnings, notes } = splitNotes(report);
    expect(warnings).toEqual([
      'tax.note.pnlIncomplete',
      'tax.note.foodCostTwice',
      'tax.note.filingLate',
    ]);
    expect(notes).toEqual(['tax.note.costOfGoodsEstimated']);
  });

  test('a flag shows its warning even if the note list does not carry it', () => {
    const report = { ...sampleTax('annual'), pnlComplete: true, notes: [] };
    expect(splitNotes(report).warnings).toEqual([]);
    expect(splitNotes({ ...report, foodCostMayBeCountedTwice: true }).warnings).toEqual([
      'tax.note.foodCostTwice',
    ]);
  });

  test('only the reasons the P&L knows get a message', () => {
    expect(reasonKey('orders_uncosted')).toBe('pnl.reason.orders_uncosted');
    expect(reasonKey('something_new')).toBeNull();
  });

  test('allowances: baht to satang, labels and amounts checked, the method kept', () => {
    const profile = {
      year: 2569,
      filerType: 'individual' as const,
      allowances: { items: [{ label: 'ประกันชีวิต', annualSatang: 2_500_000 }] },
      methodPreference: 'flat' as const,
      saved: true,
    };
    const form = formFromProfile(profile as never);
    expect(form).toEqual({ items: [{ label: 'ประกันชีวิต', amount: '25000' }], method: 'flat' });
    expect(buildTaxProfile(form)).toEqual({
      allowances: { items: [{ label: 'ประกันชีวิต', annualSatang: 2_500_000 }] },
      methodPreference: 'flat',
    });
    expect(buildTaxProfile({ items: [], method: 'auto' })).toEqual({
      allowances: { items: [] },
      methodPreference: null,
    });
    expect(
      validateTaxProfileForm({ items: [{ label: ' ', amount: '10' }], method: 'auto' }),
    ).toEqual([{ index: 0, field: 'label' }]);
    expect(
      validateTaxProfileForm({ items: [{ label: 'x', amount: '-1' }], method: 'auto' }),
    ).toEqual([{ index: 0, field: 'amount' }]);
    expect(
      validateTaxProfileForm({ items: [{ label: 'x', amount: '0' }], method: 'auto' }),
    ).toEqual([]);
  });
});
