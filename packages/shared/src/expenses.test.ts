import { describe, expect, test } from 'vitest';
import { EXPENSE_CATEGORIES } from './enums.ts';
import {
  createExpenseInputSchema,
  DEFAULT_EXPENSE_CATEGORIES,
  expenseCategoriesSchema,
  expenseCategoryKeySchema,
  missingCategoryKeys,
  patchExpenseInputSchema,
  putExpenseCategoriesInputSchema,
  voidExpenseInputSchema,
} from './expenses.ts';

describe('expense categories', () => {
  test('the defaults are the nine seeded keys, all active, each with a Thai name', () => {
    expect(DEFAULT_EXPENSE_CATEGORIES.categories.map((c) => c.key)).toEqual([
      ...EXPENSE_CATEGORIES,
    ]);
    expect(
      DEFAULT_EXPENSE_CATEGORIES.categories.every((c) => c.active && c.nameTh.length > 0),
    ).toBe(true);
    expect(expenseCategoriesSchema.safeParse(DEFAULT_EXPENSE_CATEGORIES).success).toBe(true);
  });

  test('a key is a short lower-case slug', () => {
    for (const ok of ['lunch_boxes', 'gas', 'a1']) {
      expect(expenseCategoryKeySchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['', 'Gas', '1gas', 'has space', 'x'.repeat(41), 'ค่าแก๊ส', "a'b"]) {
      expect(expenseCategoryKeySchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  test('keys must be unique and the list not empty', () => {
    const one = { key: 'gas', nameTh: 'แก๊ส' };
    expect(expenseCategoriesSchema.safeParse({ categories: [one, one] }).success).toBe(false);
    expect(expenseCategoriesSchema.safeParse({ categories: [] }).success).toBe(false);
    expect(expenseCategoriesSchema.parse({ categories: [one] }).categories[0]).toEqual({
      key: 'gas',
      nameTh: 'แก๊ส',
      nameEn: null,
      active: true,
    });
  });

  test('a PUT carries the version and the whole list', () => {
    expect(
      putExpenseCategoriesInputSchema.safeParse({
        expectedVersion: 0,
        categories: [{ key: 'gas', nameTh: 'แก๊ส' }],
      }).success,
    ).toBe(true);
    expect(
      putExpenseCategoriesInputSchema.safeParse({ categories: [{ key: 'gas', nameTh: 'x' }] })
        .success,
    ).toBe(false);
  });

  test('missingCategoryKeys names the keys a new list drops (keys are deactivated, never removed)', () => {
    const before = DEFAULT_EXPENSE_CATEGORIES.categories;
    expect(missingCategoryKeys(before, before)).toEqual([]);
    expect(missingCategoryKeys(before, before.slice(2))).toEqual(['ingredients', 'packaging']);
  });
});

describe('expense inputs', () => {
  const base = { category: 'gas', amountSatang: 25000 };

  test('amount is a positive whole number of satang', () => {
    expect(createExpenseInputSchema.safeParse(base).success).toBe(true);
    for (const amountSatang of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(createExpenseInputSchema.safeParse({ ...base, amountSatang }).success).toBe(false);
    }
  });

  test('date is optional ISO, extra fields (a client total, a receipt key) are refused', () => {
    expect(
      createExpenseInputSchema.safeParse({ ...base, businessDate: '2026-10-20' }).success,
    ).toBe(true);
    expect(
      createExpenseInputSchema.safeParse({ ...base, businessDate: '20/10/2026' }).success,
    ).toBe(false);
    expect(createExpenseInputSchema.safeParse({ ...base, receiptImageKey: 'k' }).success).toBe(
      false,
    );
    expect(createExpenseInputSchema.safeParse({ ...base, clientRequestId: 'nope' }).success).toBe(
      false,
    );
  });

  test('a patch needs the version and at least one field', () => {
    expect(patchExpenseInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(patchExpenseInputSchema.safeParse({ amountSatang: 100 }).success).toBe(false);
    expect(patchExpenseInputSchema.safeParse({ expectedVersion: 1, note: null }).success).toBe(
      true,
    );
    expect(patchExpenseInputSchema.safeParse({ expectedVersion: 1, amountSatang: 0 }).success).toBe(
      false,
    );
  });

  test('a void needs the version and a reason', () => {
    expect(voidExpenseInputSchema.safeParse({ expectedVersion: 1, reason: 'typo' }).success).toBe(
      true,
    );
    expect(voidExpenseInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(voidExpenseInputSchema.safeParse({ expectedVersion: 1, reason: ' ' }).success).toBe(
      false,
    );
  });
});
