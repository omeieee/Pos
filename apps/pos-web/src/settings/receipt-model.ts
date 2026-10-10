/**
 * The receipt settings form (tax ID and address), outside React. The tax ID is checked with the
 * shared `isValidThaiTaxId` (the server checks again); a blank field clears the setting (null).
 */
import { isValidThaiTaxId, type ReceiptPatchInput, type ReceiptSettings } from '@sds/shared';

export interface ReceiptForm {
  taxId: string;
  address: string;
}
export type ReceiptField = keyof ReceiptForm;

const MAX_ADDRESS = 200;

export const receiptFormFrom = (saved: ReceiptSettings): ReceiptForm => ({
  taxId: saved.taxId ?? '',
  address: saved.address ?? '',
});

/** Digits as typed, without the spaces and hyphens people group them with. */
const taxIdOf = (text: string) => text.replace(/[\s-]/g, '');
const nullable = (text: string): string | null => (text.trim() === '' ? null : text.trim());

/** The fields to fix, in screen order. A blank field is fine: it clears the line. */
export function validateReceiptForm(form: ReceiptForm): ReceiptField[] {
  const problems: ReceiptField[] = [];
  const taxId = taxIdOf(form.taxId);
  if (taxId !== '' && !isValidThaiTaxId(taxId)) problems.push('taxId');
  if (form.address.trim().length > MAX_ADDRESS) problems.push('address');
  return problems;
}

/** The patch for a validated form against what is saved; null when nothing changed. */
export function buildReceiptPatch(
  base: ReceiptSettings,
  version: number,
  form: ReceiptForm,
): ReceiptPatchInput | null {
  const patch: Omit<ReceiptPatchInput, 'expectedVersion'> = {};
  const taxId = nullable(taxIdOf(form.taxId));
  if (taxId !== base.taxId) patch.taxId = taxId;
  const address = nullable(form.address);
  if (address !== base.address) patch.address = address;
  return Object.keys(patch).length === 0 ? null : { expectedVersion: version, ...patch };
}
