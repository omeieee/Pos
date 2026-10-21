/**
 * Expense ledger shapes (03 §3 "expenses", D-31). Money is integer satang and always positive: a
 * correction is a PATCH, a mistake is a void, and nothing is ever deleted. A category is a free
 * key checked against the shop's category list (a `settings` row), not a fixed enum: the owner adds
 * "lunch boxes" or "payment-verification fees" without a release. A key can be switched off but
 * never removed, so an old expense always has a category to point at.
 *
 * Pure: no I/O. The receipt photo (D-36) is never named in the DTO: `hasReceipt` says there is one, and
 * the picture comes from `GET /v1/expenses/:id/receipt`.
 */
import { z } from 'zod';
import { EXPENSE_CATEGORIES } from './enums.ts';
import { revenueReportQuerySchema } from './reports.ts';
import { isoDateSchema, nonNegativeSatangSchema, satangSchema } from './schemas.ts';
import { settingResponseSchema } from './settings.ts';

const version = z.number().int().min(1);
const text = (max: number) => z.string().trim().min(1).max(max);

function needsAField<T extends { expectedVersion: number }>(v: T): boolean {
  return Object.keys(v).some(
    (k) => k !== 'expectedVersion' && (v as Record<string, unknown>)[k] !== undefined,
  );
}
const needsAFieldMessage = {
  message: 'give at least one field to change',
  path: ['expectedVersion'],
};

// ---------- Category list (settings key `expense_categories`) ----------

/** A short lower-case slug; stored on every expense, so it never changes once used. */
export const expenseCategoryKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

export const expenseCategorySchema = z.strictObject({
  key: expenseCategoryKeySchema,
  nameTh: text(80),
  nameEn: text(80).nullable().default(null),
  /** Off = not offered for new expenses; rows already on the key stay valid. */
  active: z.boolean().default(true),
  /**
   * Counts as "buying goods" (ซื้อสินค้า) on the cash receipts-payments report (D-35). Optional so
   * a list saved before the flag existed still parses; read it with `isBuyingGoods`, which falls back
   * to the default for the key. Kept when the category is switched off, so old expenses still count.
   */
  buyingGoods: z.boolean().optional(),
});
export type ExpenseCategoryEntry = z.infer<typeof expenseCategorySchema>;

const uniqueKeys = (list: readonly { key: string }[]) =>
  new Set(list.map((c) => c.key)).size === list.length;

const categoryList = z
  .array(expenseCategorySchema)
  .min(1)
  .max(100)
  .refine(uniqueKeys, { message: 'two categories with the same key' });

export const expenseCategoriesSchema = z.strictObject({ categories: categoryList });
export type ExpenseCategories = z.infer<typeof expenseCategoriesSchema>;

const DEFAULT_NAMES_TH: Record<(typeof EXPENSE_CATEGORIES)[number], string> = {
  ingredients: 'วัตถุดิบ',
  packaging: 'บรรจุภัณฑ์',
  gas: 'แก๊ส',
  utilities: 'ค่าน้ำค่าไฟ',
  rent: 'ค่าเช่า',
  staff: 'ค่าแรง',
  platform_fees: 'ค่าธรรมเนียมแพลตฟอร์ม',
  equipment: 'อุปกรณ์',
  other: 'อื่น ๆ',
};

/** The seeded categories that are goods; every other default, and a key the shop never flagged, is not. */
export const DEFAULT_BUYING_GOODS_KEYS: readonly string[] = ['ingredients', 'packaging'];

/** The flag as saved, else the default for the key (an unknown key is not goods until flagged). */
export function isBuyingGoods(c: { key: string; buyingGoods?: boolean | undefined }): boolean {
  return c.buyingGoods ?? DEFAULT_BUYING_GOODS_KEYS.includes(c.key);
}

/** The keys that count as buying goods, in list order (active or not). */
export function buyingGoodsKeys(
  list: readonly { key: string; buyingGoods?: boolean | undefined }[],
): string[] {
  return list.filter(isBuyingGoods).map((c) => c.key);
}

/** What GET shows before the owner ever saves a list (version 0): the nine seeded categories. */
export const DEFAULT_EXPENSE_CATEGORIES: ExpenseCategories = {
  categories: EXPENSE_CATEGORIES.map((key) => ({
    key,
    nameTh: DEFAULT_NAMES_TH[key],
    nameEn: null,
    active: true,
    buyingGoods: DEFAULT_BUYING_GOODS_KEYS.includes(key),
  })),
};

/** PUT replaces the whole list; `expectedVersion` 0 = never saved. */
export const putExpenseCategoriesInputSchema = z.strictObject({
  expectedVersion: z.number().int().min(0),
  categories: categoryList,
});
export type PutExpenseCategoriesInput = z.infer<typeof putExpenseCategoriesInputSchema>;

export const expenseCategoriesResponseSchema = settingResponseSchema(expenseCategoriesSchema);
export type ExpenseCategoriesResponse = z.infer<typeof expenseCategoriesResponseSchema>;

/** The keys of `before` that `after` leaves out. A list may not drop a key, only switch it off. */
export function missingCategoryKeys(
  before: readonly { key: string }[],
  after: readonly { key: string }[],
): string[] {
  const kept = new Set(after.map((c) => c.key));
  return before.map((c) => c.key).filter((key) => !kept.has(key));
}

// ---------- Expenses ----------

export const expenseDtoSchema = z.object({
  id: z.uuid(),
  businessDate: isoDateSchema,
  category: expenseCategoryKeySchema,
  amountSatang: nonNegativeSatangSchema,
  vendor: z.string().nullable(),
  note: z.string().nullable(),
  hasReceipt: z.boolean(),
  createdByStaffId: z.uuid().nullable(),
  voided: z.boolean(),
  voidedAt: z.iso.datetime().nullable(),
  voidReason: z.string().nullable(),
  version: z.number().int(),
  rev: z.number().int(),
});
export type ExpenseDto = z.infer<typeof expenseDtoSchema>;

/** A positive whole number of satang. */
const amount = satangSchema.refine((v) => v > 0, 'must be more than zero');

/** Optional UUID for retries (CLAUDE.md rule 6): same id + same content = the row already made. */
const clientRequestId = z.uuid().optional();

export const createExpenseInputSchema = z.strictObject({
  /** Omitted = today's business day. Any date is allowed, later ones too (advance bookings, D-31). */
  businessDate: isoDateSchema.optional(),
  category: expenseCategoryKeySchema,
  amountSatang: amount,
  vendor: text(100).nullable().optional(),
  note: text(300).nullable().optional(),
  clientRequestId,
});
export type CreateExpenseInput = z.infer<typeof createExpenseInputSchema>;

export const patchExpenseInputSchema = z
  .strictObject({
    expectedVersion: version,
    businessDate: isoDateSchema.optional(),
    category: expenseCategoryKeySchema.optional(),
    amountSatang: amount.optional(),
    vendor: text(100).nullable().optional(),
    note: text(300).nullable().optional(),
  })
  .refine(needsAField, needsAFieldMessage);
export type PatchExpenseInput = z.infer<typeof patchExpenseInputSchema>;

export const voidExpenseInputSchema = z.strictObject({
  expectedVersion: version,
  reason: text(200),
});
export type VoidExpenseInput = z.infer<typeof voidExpenseInputSchema>;

/** The same from/to rules as the reports (at most 366 days). */
export const listExpensesQuerySchema = revenueReportQuerySchema;
export type ListExpensesQuery = z.infer<typeof listExpensesQuerySchema>;

/** `totalSatang` is the server's sum of the rows that are not voided. */
export const expenseListSchema = z.object({
  expenses: z.array(expenseDtoSchema),
  totalSatang: nonNegativeSatangSchema,
});
export type ExpenseList = z.infer<typeof expenseListSchema>;
