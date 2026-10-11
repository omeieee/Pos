/**
 * The amount on a customer's transfer slip, read from OCR text (D-26). Pure; no I/O.
 *
 * This is only a HINT for staff. Nothing here confirms or rejects a payment: staff still compare
 * the bank app (CLAUDE.md rule 2). When the text is not clear the answer is "unreadable", never a
 * guess. Money stays integer satang; the text is parsed with no floating point.
 */

/** Where the check of a slip stands. Null on a payment without a slip (or when the check is off). */
export const SLIP_CHECKS = ['pending', 'match', 'mismatch', 'unreadable'] as const;
export type SlipCheck = (typeof SLIP_CHECKS)[number];

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

/** Thai digits to ASCII, so one pattern reads both. */
const toAsciiDigits = (text: string): string =>
  text.replace(/[๐-๙]/g, (digit) => String(THAI_DIGITS.indexOf(digit)));

/** A baht amount: with thousands separators or plain, then an optional fraction of 1-2 digits. */
const NUMBER = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\.?\d)/g;
const UNIT_AFTER = /^\s*(?:บาท|baht|thb|฿)/i;
const UNIT_BEFORE = /฿\s*$/;
const AMOUNT_LABEL = /จำนวน|amount/i;
const FEE_LABEL = /ค่าธรรมเนียม|\bfee\b/i;
/** More than this many whole-baht digits is not a price on a slip (a reference number or an account). */
const MAX_BAHT_DIGITS = 9;

type Tier = 1 | 2 | 3;

/**
 * The amount in satang, or null when the text has none or more than one that could be it.
 *
 * Candidates are numbers with two decimals (or written with a unit: บาท, THB, ฿). They are ranked:
 * 1. next to an amount label (จำนวน, จำนวนเงิน, Amount), on the same line or the line below;
 * 2. next to a unit;
 * 3. bare decimals.
 * The best rank that has any candidate decides, and it must hold ONE distinct non-zero amount.
 * Fee lines are skipped, and zero is ignored (the fee line of most banks says 0.00).
 */
export function extractSlipAmount(text: string): number | null {
  const found = new Map<Tier, Set<number>>();
  let carry: 'label' | 'fee' | null = null;

  for (const line of toAsciiDigits(text).split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const fee = FEE_LABEL.test(line);
    const label = !fee && AMOUNT_LABEL.test(line);
    const inherited = carry;
    carry = null;
    const numbers = [...line.matchAll(NUMBER)];
    if (numbers.length === 0) {
      // A label alone: what it names is on the next line.
      carry = fee ? 'fee' : label ? 'label' : null;
      continue;
    }
    if (fee || inherited === 'fee') continue;

    for (const match of numbers) {
      const [whole, integer = '', fraction] = match;
      const digits = integer.replaceAll(',', '');
      if (digits.length > MAX_BAHT_DIGITS) continue;
      const end = (match.index ?? 0) + whole.length;
      const unit =
        UNIT_AFTER.test(line.slice(end)) || UNIT_BEFORE.test(line.slice(0, match.index ?? 0));
      // A whole number alone is a quantity, a day or a reference: it needs the unit.
      if (fraction === undefined && !unit) continue;
      const satang = Number(digits) * 100 + Number((fraction ?? '').padEnd(2, '0'));
      if (satang === 0) continue;
      const tier: Tier = label || inherited === 'label' ? 1 : unit ? 2 : 3;
      found.set(tier, (found.get(tier) ?? new Set<number>()).add(satang));
    }
  }

  for (const tier of [1, 2, 3] as const) {
    const amounts = found.get(tier);
    if (!amounts) continue;
    return amounts.size === 1 ? ([...amounts][0] ?? null) : null;
  }
  return null;
}

/** What the slip says against the amount this payment charges (never the order total: a top-up charges less). */
export function compareSlipAmount(
  slipSatang: number | null,
  expectedSatang: number,
): Exclude<SlipCheck, 'pending'> {
  if (slipSatang === null) return 'unreadable';
  return slipSatang === expectedSatang ? 'match' : 'mismatch';
}
