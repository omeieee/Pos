/**
 * The expense form and the category list, outside React. What the person types (baht as text, a
 * date, a category) becomes the body the API takes; a correction sends only what changed, with the
 * version the screen saw. Nothing here adds up money: the server sums the ledger.
 */
import type { Locale } from '@sds/i18n';
import type { ExpenseCategoryEntry, ExpenseDto } from '@sds/shared';
import type { NewExpenseInput } from '../../api/client.ts';
import { parseBahtText, satangToText } from '../../menu-editor/model.ts';

export interface ExpenseForm {
  date: string;
  category: string;
  /** Baht as typed ("49.5"). */
  amount: string;
  vendor: string;
  note: string;
}
export type ExpenseField = 'date' | 'category' | 'amount' | 'vendor' | 'note';

const VENDOR_MAX = 100;
const NOTE_MAX = 300;

export const activeCategories = (list: readonly ExpenseCategoryEntry[]) =>
  list.filter((c) => c.active);

/** New expenses offer the active categories; an edit also keeps the (switched-off) one it has. */
export function categoryOptions(
  list: readonly ExpenseCategoryEntry[],
  current: string | undefined,
): ExpenseCategoryEntry[] {
  return list.filter((c) => c.active || c.key === current);
}

/** The name in the language of the screen; the other language, then the key, when it is missing. */
export function categoryName(
  list: readonly ExpenseCategoryEntry[],
  key: string,
  locale: Locale,
): string {
  const found = list.find((c) => c.key === key);
  if (!found) return key;
  return locale === 'en' ? (found.nameEn ?? found.nameTh) : found.nameTh;
}

export function emptyExpenseForm(
  today: string,
  list: readonly ExpenseCategoryEntry[],
): ExpenseForm {
  return {
    date: today,
    category: activeCategories(list)[0]?.key ?? '',
    amount: '',
    vendor: '',
    note: '',
  };
}

export const expenseFormFrom = (expense: ExpenseDto): ExpenseForm => ({
  date: expense.businessDate,
  category: expense.category,
  amount: satangToText(expense.amountSatang),
  vendor: expense.vendor ?? '',
  note: expense.note ?? '',
});

const amountOf = (text: string): number | null => {
  const parsed = parseBahtText(text);
  return parsed.ok && parsed.satang > 0 ? parsed.satang : null;
};
const optional = (text: string): string | null => (text.trim() === '' ? null : text.trim());

/** The fields to correct, in form order. Any date is fine, later ones too (advance bookings). */
export function validateExpenseForm(form: ExpenseForm): ExpenseField[] {
  const problems: ExpenseField[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) problems.push('date');
  if (form.category === '') problems.push('category');
  if (amountOf(form.amount) === null) problems.push('amount');
  if (form.vendor.trim().length > VENDOR_MAX) problems.push('vendor');
  if (form.note.trim().length > NOTE_MAX) problems.push('note');
  return problems;
}

/** The body of a new expense (call `validateExpenseForm` first). */
export function buildExpenseCreate(form: ExpenseForm): NewExpenseInput {
  return {
    businessDate: form.date,
    category: form.category,
    amountSatang: amountOf(form.amount) ?? 0,
    vendor: optional(form.vendor),
    note: optional(form.note),
  };
}

/** Only what changed, with the version the screen saw; null when nothing did. */
export function buildExpensePatch(expense: ExpenseDto, form: ExpenseForm) {
  const patch: {
    expectedVersion: number;
    businessDate?: string;
    category?: string;
    amountSatang?: number;
    vendor?: string | null;
    note?: string | null;
  } = { expectedVersion: expense.version };
  let changed = false;
  if (form.date !== expense.businessDate) {
    patch.businessDate = form.date;
    changed = true;
  }
  if (form.category !== expense.category) {
    patch.category = form.category;
    changed = true;
  }
  const amount = amountOf(form.amount);
  if (amount !== null && amount !== expense.amountSatang) {
    patch.amountSatang = amount;
    changed = true;
  }
  if (optional(form.vendor) !== expense.vendor) {
    patch.vendor = optional(form.vendor);
    changed = true;
  }
  if (optional(form.note) !== expense.note) {
    patch.note = optional(form.note);
    changed = true;
  }
  return changed ? patch : null;
}

// ---------- Categories ----------

const KEY_MAX = 40;

/** `Lunch boxes` -> `lunch_boxes`; a name with no Latin letters has nothing to make a key from. */
function keyBase(nameEn: string): string {
  const slug = nameEn
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = /^[a-z]/.test(slug) ? slug : slug === '' ? 'custom' : `c_${slug}`;
  return base.slice(0, KEY_MAX - 4).replace(/_+$/, '') || 'custom';
}

/**
 * The list with one more category, or null when the Thai name is empty. The key is made here (the
 * server wants a short Latin slug and Thai names cannot give one): from the English name, else
 * `custom`, with `_2`, `_3` added until it is unique. It is stored on every expense and never changes.
 */
export function addCategory(
  list: readonly ExpenseCategoryEntry[],
  names: { nameTh: string; nameEn: string },
): ExpenseCategoryEntry[] | null {
  const nameTh = names.nameTh.trim();
  if (nameTh === '') return null;
  const nameEn = names.nameEn.trim();
  const taken = new Set(list.map((c) => c.key));
  const base = keyBase(nameEn);
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
  return [
    ...list,
    { key, nameTh, nameEn: nameEn === '' ? null : nameEn.slice(0, 80), active: true },
  ];
}

/** Switches a category off or on. Nothing is ever removed from the list. */
export const setCategoryActive = (
  list: readonly ExpenseCategoryEntry[],
  key: string,
  active: boolean,
): ExpenseCategoryEntry[] => list.map((c) => (c.key === key ? { ...c, active } : c));
