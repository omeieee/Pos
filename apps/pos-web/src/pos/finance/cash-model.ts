/**
 * The start-amount form (setting `cash_opening`), outside React. What the person types (baht as text, a date) becomes the body
 * the API takes, with the version the screen saw. Nothing here adds up money: the server does.
 */
import {
  type CashOpeningPatchInput,
  type CashOpeningSettings,
  cashOpeningEarliest,
  satang,
} from '@sds/shared';
import { parseBahtText, satangToText } from '../../menu-editor/model.ts';

export interface OpeningForm {
  /** Baht as typed ("500.5"). */
  amount: string;
  /** ISO date, the start of that business day. */
  asOf: string;
}
export type OpeningField = 'amount' | 'asOf' | 'asOfTooOld';

export function openingFormFrom(setting: CashOpeningSettings, today: string): OpeningForm {
  return {
    amount: setting.amountSatang === null ? '' : satangToText(setting.amountSatang),
    asOf: setting.asOf ?? today,
  };
}

/** `today` (the business date) switches on the 10-year limit on the start date; the server checks it too. */
export function validateOpeningForm(form: OpeningForm, today?: string): OpeningField[] {
  const problems: OpeningField[] = [];
  const parsed = parseBahtText(form.amount);
  if (!parsed.ok || parsed.satang < 0) problems.push('amount');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.asOf)) problems.push('asOf');
  else if (today !== undefined && form.asOf < cashOpeningEarliest(today))
    problems.push('asOfTooOld');
  return problems;
}

/** The PATCH body, or null when the form is not valid. */
export function buildOpeningBody(
  form: OpeningForm,
  expectedVersion: number,
  today?: string,
): CashOpeningPatchInput | null {
  const parsed = parseBahtText(form.amount);
  if (!parsed.ok || parsed.satang < 0 || validateOpeningForm(form, today).length > 0) return null;
  return { expectedVersion, amountSatang: satang(parsed.satang), asOf: form.asOf };
}
