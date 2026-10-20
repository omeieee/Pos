/**
 * The start-amount form (setting `cash_opening`), outside React. What the person types (baht as text, a date) becomes the body
 * the API takes, with the version the screen saw. Nothing here adds up money: the server does.
 */
import { type CashOpeningPatchInput, type CashOpeningSettings, satang } from '@sds/shared';
import { parseBahtText, satangToText } from '../../menu-editor/model.ts';

export interface OpeningForm {
  /** Baht as typed ("500.5"). */
  amount: string;
  /** ISO date, the start of that business day. */
  asOf: string;
}
export type OpeningField = 'amount' | 'asOf';

export function openingFormFrom(setting: CashOpeningSettings, today: string): OpeningForm {
  return {
    amount: setting.amountSatang === null ? '' : satangToText(setting.amountSatang),
    asOf: setting.asOf ?? today,
  };
}

export function validateOpeningForm(form: OpeningForm): OpeningField[] {
  const problems: OpeningField[] = [];
  const parsed = parseBahtText(form.amount);
  if (!parsed.ok || parsed.satang < 0) problems.push('amount');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.asOf)) problems.push('asOf');
  return problems;
}

/** The PATCH body, or null when the form is not valid. */
export function buildOpeningBody(
  form: OpeningForm,
  expectedVersion: number,
): CashOpeningPatchInput | null {
  const parsed = parseBahtText(form.amount);
  if (!parsed.ok || parsed.satang < 0 || validateOpeningForm(form).length > 0) return null;
  return { expectedVersion, amountSatang: satang(parsed.satang), asOf: form.asOf };
}
