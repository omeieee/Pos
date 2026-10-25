/**
 * Which open PromptPay order a slip belongs to when the customer has several (D-40, PAY-05). Pure.
 *
 * The amount read from the slip (QR or OCR, locally) only CHOOSES a target. It never confirms
 * anything: auto-confirm stays the D-27 bank check on the final payment's own amount, and a
 * `review` answer carries `autoConfirm: false` so that claim can never be confirmed by the server.
 */
import { type MergeFacts, mergeEligible } from './order-merge.ts';

/** An open PromptPay order of the sender, oldest first in the list. */
export interface SlipCandidate {
  orderId: string;
  /** What the order still has to pay, in satang. */
  dueSatang: number | bigint;
  facts: MergeFacts;
}

export type SlipAllocation =
  | { kind: 'single'; orderId: string }
  | { kind: 'merge'; targetId: string; sourceIds: string[] }
  | { kind: 'review'; orderId: string; autoConfirm: false };

/**
 * `amountSatang` is the slip amount, or null when it could not be read. `candidates` are oldest
 * first and must not be empty.
 *
 * 1. `single`: the oldest order whose due equals the amount.
 * 2. `merge`: no such order, but the amount equals the sum of ALL candidates that can merge with
 *    the oldest (at least two orders). The oldest is the target.
 * 3. `review`: anything else, on the oldest order, with auto-confirm off.
 * An exact single match wins over a full-sum match.
 */
export function allocateSlip(
  amountSatang: number | bigint | null,
  candidates: readonly SlipCandidate[],
): SlipAllocation {
  const oldest = candidates[0];
  if (!oldest) throw new RangeError('allocateSlip needs at least one candidate');
  const review: SlipAllocation = { kind: 'review', orderId: oldest.orderId, autoConfirm: false };

  const amount = toPositiveBigint(amountSatang);
  if (amount === null) return review;

  const exact = candidates.find((c) => BigInt(c.dueSatang) === amount);
  if (exact) return { kind: 'single', orderId: exact.orderId };

  const others = candidates.slice(1).filter((c) => mergeEligible(oldest.facts, [c.facts]));
  if (others.length > 0) {
    const sum = others.reduce((acc, c) => acc + BigInt(c.dueSatang), BigInt(oldest.dueSatang));
    if (sum === amount) {
      return { kind: 'merge', targetId: oldest.orderId, sourceIds: others.map((c) => c.orderId) };
    }
  }
  return review;
}

/** A whole, positive, safe amount as a bigint; null for null, zero, negative, fractional or unsafe. */
function toPositiveBigint(value: number | bigint | null): bigint | null {
  if (value === null) return null;
  if (typeof value === 'bigint') {
    return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? value : null;
  }
  return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : null;
}
