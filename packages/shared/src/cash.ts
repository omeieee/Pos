/**
 * Cash payments (02 §4.2, 03 §4, 01 P4). Pure; integer satang only, no floating point.
 *
 * - `calculateCashChange`: change = tendered - total. A tender below the total is an error.
 * - `suggestCashTenders`: the quick "tender" buttons next to the keypad.
 *
 * Both reuse `cashChange` from money.ts for the subtraction and add the checks a keypad needs.
 * The server is the only source of `total` (CLAUDE.md rule 1): a client sends `tendered` and
 * never a total. Staff still count the cash and confirm the payment by hand (rule 2).
 */
import { z } from 'zod';
import { cashChange, type Satang, satang } from './money.ts';
import { nonNegativeSatangSchema } from './schemas.ts';

/**
 * Sanity limit for a cash total or tender: 100,000,000 satang = ฿1,000,000.
 *
 * This is a typo guard for the keypad, not a business rule. A noodle shop never takes a cash
 * payment this large, and a tender with two extra zeros would otherwise be turned into
 * "change" without any warning. It is a multiple of every value in `CASH_TENDER_STEPS`, so a
 * suggested tender for an allowed total never exceeds it.
 */
export const MAX_CASH_SATANG = 100_000_000;

/**
 * Thai banknotes used for the quick tender buttons, in satang: ฿20, ฿50, ฿100, ฿500, ฿1000
 * (01 P4). Coins are not suggested.
 */
export const CASH_TENDER_STEPS = [2_000, 5_000, 10_000, 50_000, 100_000] as const;

export type CashPaymentErrorCode = 'invalid_amount' | 'amount_too_large' | 'tendered_below_total';

/**
 * A `RangeError` (like the rest of the money helpers) that also carries a machine-readable
 * `code`, so the API can answer 422 with a specific reason and the UI can say "not enough".
 */
export class CashPaymentError extends RangeError {
  readonly code: CashPaymentErrorCode;
  constructor(code: CashPaymentErrorCode, message: string) {
    super(message);
    this.name = 'CashPaymentError';
    this.code = code;
  }
}

/** A cash amount at a boundary: a non-negative whole number of satang, at most the limit. */
export const cashAmountSchema = nonNegativeSatangSchema.refine(
  (v) => v <= MAX_CASH_SATANG,
  `must not exceed ${MAX_CASH_SATANG} satang`,
);

/**
 * Input of `calculateCashChange`. `total` comes from the server's own order total; a client
 * must never be allowed to send it. A tender below the total is a domain error raised by the
 * function (code `tendered_below_total`), not a shape error.
 */
export const cashChangeInputSchema = z.object({
  total: cashAmountSchema,
  tendered: cashAmountSchema,
});
export type CashChangeInput = z.infer<typeof cashChangeInputSchema>;

/** Output of `calculateCashChange`; `change` must equal `tendered - total`. */
export const cashChangeResultSchema = z
  .object({
    total: cashAmountSchema,
    tendered: cashAmountSchema,
    change: cashAmountSchema,
  })
  .refine((r) => r.change === r.tendered - r.total, {
    message: 'change must equal tendered - total',
    path: ['change'],
  });
export type CashChangeResult = z.infer<typeof cashChangeResultSchema>;

/** Input of `suggestCashTenders`. As above, the server supplies the total. */
export const cashTenderSuggestionsInputSchema = z.object({ total: cashAmountSchema });
export type CashTenderSuggestionsInput = z.infer<typeof cashTenderSuggestionsInputSchema>;

/** Output of `suggestCashTenders`: the exact total comes first and nothing is below it. */
export const cashTenderSuggestionsResultSchema = z
  .object({
    total: cashAmountSchema,
    suggestions: z.array(cashAmountSchema).min(1),
  })
  .refine((r) => r.suggestions[0] === r.total && r.suggestions.every((v) => v >= r.total), {
    message: 'suggestions must start with the exact total and none may be below it',
    path: ['suggestions'],
  });
export type CashTenderSuggestionsResult = z.infer<typeof cashTenderSuggestionsResultSchema>;

function assertCashAmount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CashPaymentError(
      'invalid_amount',
      `${label} must be a non-negative whole number of satang, got ${value}`,
    );
  }
  if (value > MAX_CASH_SATANG) {
    throw new CashPaymentError(
      'amount_too_large',
      `${label} ${value} exceeds the cash limit of ${MAX_CASH_SATANG} satang`,
    );
  }
}

/**
 * Cash change for one payment: `change = tendered - total`, in satang. No rounding happens
 * here, because both inputs and the result are whole satang.
 *
 * - `tendered === total` gives 0; one satang more gives 1.
 * - `tendered < total` throws `CashPaymentError` with code `tendered_below_total`.
 * - A negative, fractional, unsafe or non-finite amount throws code `invalid_amount`; an
 *   amount above `MAX_CASH_SATANG` throws code `amount_too_large`.
 * - A total of 0 is allowed (a fully discounted order); whether a 0 payment may be recorded is
 *   decided by the caller.
 */
export function calculateCashChange(total: Satang, tendered: Satang): CashChangeResult {
  assertCashAmount(total, 'total');
  assertCashAmount(tendered, 'tendered');
  if (tendered < total) {
    throw new CashPaymentError(
      'tendered_below_total',
      `tendered ${tendered} is less than total ${total}`,
    );
  }
  // `+ 0` turns a stray -0 into +0 so the result serialises and compares as a plain zero.
  return {
    total: satang(total + 0),
    tendered: satang(tendered + 0),
    change: cashChange(total, tendered),
  };
}

/** Smallest multiple of `step` that is at least `value`, using integer arithmetic only. */
function roundUpToMultiple(value: number, step: number): number {
  const rest = value % step;
  return rest === 0 ? value : value + (step - rest);
}

/**
 * Quick tender amounts for a total, in satang, ascending, without duplicates.
 *
 * The list holds the exact total first, then for each note in `CASH_TENDER_STEPS` the next
 * multiple of that note that covers the total (the amount a customer can hand over using that
 * note). Examples: ฿75 gives 75, 80, 100, 500, 1000; ฿145 gives 145, 150, 160, 200, 500, 1000;
 * ฿1000 gives just 1000. A total of 0 gives just 0.
 *
 * Totals above `MAX_CASH_SATANG` and invalid amounts throw like `calculateCashChange`.
 */
export function suggestCashTenders(total: Satang): Satang[] {
  assertCashAmount(total, 'total');
  const exact = total + 0;
  const amounts = new Set<number>([exact]);
  for (const step of CASH_TENDER_STEPS) amounts.add(roundUpToMultiple(exact, step));
  return [...amounts].sort((a, b) => a - b).map((v) => satang(v));
}
