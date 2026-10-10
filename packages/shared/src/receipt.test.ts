import { expect, test } from 'vitest';
import {
  DEFAULT_RECEIPT_SETTINGS,
  issueReceiptInputSchema,
  isValidThaiTaxId,
  receiptPatchInputSchema,
  receiptSettingsSchema,
} from './receipt.ts';

// 123456789012 + check digit 1: a made-up number that only satisfies the checksum.
const VALID = '1234567890121';

test('a Thai tax ID is 13 digits with the standard check digit', () => {
  expect(isValidThaiTaxId(VALID)).toBe(true);
  expect(isValidThaiTaxId('1234567890122')).toBe(false); // wrong check digit
  expect(isValidThaiTaxId('123456789012')).toBe(false); // 12 digits
  expect(isValidThaiTaxId('12345678901210')).toBe(false); // 14 digits
  expect(isValidThaiTaxId('123456789012a')).toBe(false);
  expect(isValidThaiTaxId('1-2345-67890-12-1')).toBe(false); // digits only
  expect(isValidThaiTaxId('')).toBe(false);
});

test('the check digit is computed with the weights 13 down to 2, mod 11', () => {
  // sum = 0 -> (11 - 0) % 10 = 1, sum % 11 = 1 -> 0, sum % 11 = 2 -> 9
  expect(isValidThaiTaxId('0000000000001')).toBe(true);
  expect(isValidThaiTaxId('0000000000010')).toBe(false);
  // 1000000000000 + weight 13 -> sum 13, 13 % 11 = 2 -> check digit 9
  expect(isValidThaiTaxId('1000000000009')).toBe(true);
  expect(isValidThaiTaxId('1000000000001')).toBe(false);
});

test('receipt settings are empty by default: no real value ships with the code', () => {
  expect(DEFAULT_RECEIPT_SETTINGS).toEqual({ taxId: null, address: null });
  expect(receiptSettingsSchema.parse({})).toEqual({ taxId: null, address: null });
});

test('the settings value holds a valid tax ID and a trimmed address', () => {
  expect(receiptSettingsSchema.parse({ taxId: VALID, address: ' 1 ถนนทดสอบ ' })).toEqual({
    taxId: VALID,
    address: '1 ถนนทดสอบ',
  });
  expect(receiptSettingsSchema.safeParse({ taxId: '1234567890122' }).success).toBe(false);
});

test('a PATCH names the version, sets or clears either field, and needs one field', () => {
  expect(receiptPatchInputSchema.safeParse({ expectedVersion: 0, taxId: VALID }).success).toBe(
    true,
  );
  expect(
    receiptPatchInputSchema.safeParse({ expectedVersion: 1, taxId: null, address: null }).success,
  ).toBe(true);
  expect(receiptPatchInputSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
  expect(receiptPatchInputSchema.safeParse({ taxId: VALID }).success).toBe(false);
  expect(receiptPatchInputSchema.safeParse({ expectedVersion: 1, taxId: '123' }).success).toBe(
    false,
  );
  expect(receiptPatchInputSchema.safeParse({ expectedVersion: 1, address: '   ' }).success).toBe(
    false,
  );
  expect(
    receiptPatchInputSchema.safeParse({ expectedVersion: 1, address: 'x'.repeat(201) }).success,
  ).toBe(false);
  expect(
    receiptPatchInputSchema.safeParse({ expectedVersion: 1, taxId: VALID, phone: '1' }).success,
  ).toBe(false);
});

test('issuing a receipt sends only a request id: never an amount or a shop detail', () => {
  const clientRequestId = '0b1f7c2e-5d3a-4c8e-9a41-6e2d7f0a3b95';
  expect(issueReceiptInputSchema.safeParse({ clientRequestId }).success).toBe(true);
  expect(issueReceiptInputSchema.safeParse({}).success).toBe(false);
  expect(issueReceiptInputSchema.safeParse({ clientRequestId: 'x' }).success).toBe(false);
  expect(issueReceiptInputSchema.safeParse({ clientRequestId, totalSatang: 1 }).success).toBe(
    false,
  );
});
