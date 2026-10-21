import { describe, expect, test } from 'vitest';
import { RECEIPT_ACCEPT, RECEIPT_MAX_BYTES, receiptFileProblem } from './receipt-model.ts';

describe('receiptFileProblem', () => {
  test('a JPEG or PNG within the cap is fine', () => {
    expect(receiptFileProblem({ type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(receiptFileProblem({ type: 'image/png', size: RECEIPT_MAX_BYTES })).toBeNull();
  });

  test('WebP, other files and an unknown type are refused before anything is sent', () => {
    expect(receiptFileProblem({ type: 'image/webp', size: 1000 })).toBe('type');
    expect(receiptFileProblem({ type: 'application/pdf', size: 1000 })).toBe('type');
    expect(receiptFileProblem({ type: '', size: 1000 })).toBe('type');
  });

  test('an empty file and one over 10 MB are refused', () => {
    expect(receiptFileProblem({ type: 'image/png', size: 0 })).toBe('empty');
    expect(receiptFileProblem({ type: 'image/png', size: RECEIPT_MAX_BYTES + 1 })).toBe('tooLarge');
  });

  test('the file picker offers the same two types', () => {
    expect(RECEIPT_ACCEPT).toBe('image/jpeg,image/png');
  });
});
