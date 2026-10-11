/**
 * Partial adjustment of a paid order (owner decision 2026-10-11, decisions D-25). Pure; no I/O.
 *
 * A partial refund does NOT move a payment to another status: the payment stays `confirmed` and the
 * money that went back is a separate append-only record (`payment_refunds`). So the payment state
 * machine is untouched: voiding or refunding a whole payment still goes through it. What the order
 * has really been paid is `netPaid`: confirmed amounts minus the partial refunds of those payments.
 *
 * A higher total needs no new machinery: the order simply has less than it needs, and staff take
 * the difference with the normal payment flow (the new payment charges `total - netPaid`).
 */
import { z } from 'zod';
import type { PaymentMethod, PaymentStatus } from './enums.ts';
import { type Satang, satang, sumSatang } from './money.ts';

/** What the owner may say about the payments when correcting an order. `adjust` is the partial one. */
export const CORRECTION_PAYMENT_ACTIONS = ['void', 'refund', 'adjust'] as const;
export type CorrectionPaymentAction = (typeof CORRECTION_PAYMENT_ACTIONS)[number];

/** How a partial refund was handed back. Only these two can be partly returned. */
export const REFUND_METHODS = ['cash', 'promptpay'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

/** The owner's record of how the difference went back. The amount is never sent: the server computes it. */
export const adjustRefundInputSchema = z.strictObject({
  method: z.enum(REFUND_METHODS),
  /** The transfer reference or a short note. */
  referenceNote: z.string().trim().min(1).max(200).optional(),
});
export type AdjustRefundInput = z.infer<typeof adjustRefundInputSchema>;

export interface AdjustablePayment {
  id: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amount: Satang;
  /** Sum of the partial refunds recorded against this payment. */
  refunded: Satang;
}

/** Money the order really holds: confirmed payments minus their partial refunds. */
export function netPaid(payments: readonly AdjustablePayment[]): Satang {
  return sumSatang(
    payments.filter((p) => p.status === 'confirmed').map((p) => satang(p.amount - p.refunded)),
  );
}

export type AdjustmentBlock =
  /** A payment is claimed: staff confirm or cancel the claim first. */
  | 'claim_open'
  /** The new total is zero: that is a full refund or a void. */
  | 'total_zero'
  /** The money to return sits on a payment that cannot be partly refunded (co-pay, platform, other). */
  | 'method_not_adjustable';

export type AdjustmentPlan =
  | { kind: 'none' }
  | { kind: 'topup'; amountSatang: number }
  | {
      kind: 'refund';
      amountSatang: number;
      /** Newest payment first; each is at most what is still unreturned on it. */
      allocations: { paymentId: string; amountSatang: number }[];
    }
  | { kind: 'blocked'; reason: AdjustmentBlock };

const ADJUSTABLE: readonly PaymentMethod[] = REFUND_METHODS;

/** What an owner's `adjust` does to the money, for the new order total. `payments` oldest first. */
export function planAdjustment(
  newTotal: Satang,
  payments: readonly AdjustablePayment[],
): AdjustmentPlan {
  if (payments.some((p) => p.status === 'claimed'))
    return { kind: 'blocked', reason: 'claim_open' };
  if (!payments.some((p) => p.status === 'confirmed')) return { kind: 'none' };
  const paid = netPaid(payments);
  if (newTotal === paid) return { kind: 'none' };
  if (newTotal > paid) return { kind: 'topup', amountSatang: newTotal - paid };
  if (newTotal <= 0) return { kind: 'blocked', reason: 'total_zero' };

  let left: number = paid - newTotal;
  const allocations: { paymentId: string; amountSatang: number }[] = [];
  for (const p of [...payments].reverse()) {
    if (left === 0) break;
    if (p.status !== 'confirmed' || !ADJUSTABLE.includes(p.method)) continue;
    const room = p.amount - p.refunded;
    const take = Math.min(room, left);
    if (take <= 0) continue;
    allocations.push({ paymentId: p.id, amountSatang: take });
    left -= take;
  }
  if (left > 0) return { kind: 'blocked', reason: 'method_not_adjustable' };
  return { kind: 'refund', amountSatang: paid - newTotal, allocations };
}
