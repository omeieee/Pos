import type { MessageKey } from '@sds/i18n';

/** What the file picker offers. HEIC from an iPhone arrives as JPEG (Safari converts it). */
export const RECEIPT_ACCEPT = 'image/jpeg,image/png';
/** The server's cap (413 above it); checked here so a big file is told before it is uploaded. */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

export type ReceiptProblem = 'empty' | 'type' | 'tooLarge';

/** Why a chosen file would be refused, or null. The server decides for good; this only saves the trip. */
export function receiptFileProblem(file: { type: string; size: number }): ReceiptProblem | null {
  if (file.size === 0) return 'empty';
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') return 'type';
  if (file.size > RECEIPT_MAX_BYTES) return 'tooLarge';
  return null;
}

export const RECEIPT_PROBLEM_KEYS = {
  empty: 'error.expenseReceiptUnreadable',
  type: 'error.expenseReceiptType',
  tooLarge: 'error.expenseReceiptTooLarge',
} as const satisfies Record<ReceiptProblem, MessageKey>;
