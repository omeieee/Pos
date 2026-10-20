/**
 * The tax page's arrangement, outside React. The estimate is the server's (`GET /v1/reports/tax`,
 * the rules are yearly data in `@sds/finance`); this picks the year to ask for, sorts the notes
 * into warnings and plain notes, and turns the allowances the owner types (baht) into the profile
 * body (satang). No tax is worked out here.
 */
import type { MessageKey } from '@sds/i18n';
import {
  PNL_INCOMPLETE_REASONS,
  type PutTaxProfileInput,
  type TaxProfileResponse,
  type TaxReport,
} from '@sds/shared';
import { parseBahtText, satangToText } from '../../menu-editor/model.ts';

/** Buddhist Era is the Gregorian year + 543 (2026 -> 2569). `businessDate` is `YYYY-MM-DD`. */
export const buddhistYear = (businessDate: string): number =>
  Number(businessDate.slice(0, 4)) + 543;

/** The current tax year and the two before it (the rules file for a year may not exist: the API says so). */
export const yearChoices = (today: string): number[] => {
  const current = buddhistYear(today);
  return [current, current - 1, current - 2];
};

const WARNING_KEYS = {
  pnl: 'tax.note.pnlIncomplete',
  food: 'tax.note.foodCostTwice',
  late: 'tax.note.filingLate',
} as const satisfies Record<string, MessageKey>;

/**
 * The three flags that deserve a banner (profit not complete, food cost possibly counted twice,
 * filing deadline passed) and every other note. The server also lists a flag's note in `notes`;
 * it is taken out there so no text shows twice.
 */
export function splitNotes(report: TaxReport): { warnings: MessageKey[]; notes: MessageKey[] } {
  const warnings: MessageKey[] = [];
  if (!report.pnlComplete) warnings.push(WARNING_KEYS.pnl);
  if (report.foodCostMayBeCountedTwice) warnings.push(WARNING_KEYS.food);
  if (report.filing.pastDue) warnings.push(WARNING_KEYS.late);
  const asWarnings = new Set<string>(Object.values(WARNING_KEYS));
  return { warnings, notes: report.notes.filter((key) => !asWarnings.has(key)) };
}

/** The message for a reason the P&L knows (`pnl.reason.*`); null for one this app has no words for. */
export const reasonKey = (reason: string): MessageKey | null =>
  (PNL_INCOMPLETE_REASONS as readonly string[]).includes(reason)
    ? (`pnl.reason.${reason}` as MessageKey)
    : null;

// ---------- Allowances editor ----------

export type MethodChoice = 'auto' | 'actual' | 'flat';
export interface AllowanceRow {
  label: string;
  /** Baht per year as typed. */
  amount: string;
}
export interface TaxProfileForm {
  items: AllowanceRow[];
  method: MethodChoice;
}

export const formFromProfile = (profile: TaxProfileResponse): TaxProfileForm => ({
  items: profile.allowances.items.map((i) => ({
    label: i.label,
    amount: satangToText(i.annualSatang),
  })),
  method: profile.methodPreference ?? 'auto',
});

const amountOf = (text: string): number | null => {
  const parsed = parseBahtText(text);
  return parsed.ok ? parsed.satang : null;
};

/** The rows to correct: an empty name, or an amount that is not 0 baht or more. */
export function validateTaxProfileForm(
  form: TaxProfileForm,
): { index: number; field: 'label' | 'amount' }[] {
  const problems: { index: number; field: 'label' | 'amount' }[] = [];
  form.items.forEach((row, index) => {
    if (row.label.trim() === '') problems.push({ index, field: 'label' });
    else if (amountOf(row.amount) === null) problems.push({ index, field: 'amount' });
  });
  return problems;
}

/** The whole profile of the year (the save replaces it). Call `validateTaxProfileForm` first. */
export const buildTaxProfile = (form: TaxProfileForm): PutTaxProfileInput =>
  ({
    allowances: {
      items: form.items.map((row) => ({
        label: row.label.trim(),
        annualSatang: amountOf(row.amount) ?? 0,
      })),
    },
    methodPreference: form.method === 'auto' ? null : form.method,
  }) as PutTaxProfileInput;
