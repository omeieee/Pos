/**
 * The receiving bank account form (D-26), outside React. The saved value is only ever the masked
 * view, so the number field starts empty and an empty field means "keep the number". The server
 * checks again.
 */
import { type BankAccountPatchInput, type BankAccountView, bankCodeSchema } from '@sds/shared';

export interface BankAccountForm {
  /** A bank code from the fixed list, or '' for none. */
  bankCode: string;
  /** The number as typed; '' keeps the saved one. */
  accountNumber: string;
}
export type BankAccountField = 'accountNumber';

export const bankAccountFormFrom = (saved: BankAccountView): BankAccountForm => ({
  bankCode: saved.bankCode ?? '',
  accountNumber: '',
});

/** Digits as typed, without the spaces and hyphens people group them with. */
export const accountDigitsOf = (text: string) => text.replace(/[\s-]/g, '');

export function validateBankAccountForm(form: BankAccountForm): BankAccountField[] {
  const digits = accountDigitsOf(form.accountNumber);
  return digits !== '' && !/^[0-9]{10,15}$/.test(digits) ? ['accountNumber'] : [];
}

/** The patch for a validated form against what is saved; null when nothing changed. */
export function buildBankAccountPatch(
  base: BankAccountView,
  version: number,
  form: BankAccountForm,
): BankAccountPatchInput | null {
  const patch: Omit<BankAccountPatchInput, 'expectedVersion'> = {};
  const bankCode = form.bankCode === '' ? null : bankCodeSchema.parse(form.bankCode);
  if (bankCode !== base.bankCode) patch.bankCode = bankCode;
  const digits = accountDigitsOf(form.accountNumber);
  if (digits !== '') patch.accountNumber = digits;
  return Object.keys(patch).length === 0 ? null : { expectedVersion: version, ...patch };
}
