import type { paymentsRepo } from '@sds/db';
import { slipCooldownSeconds } from '@sds/shared';
import { ApiError } from '../errors.ts';

/**
 * Whether the order's payments hold a slip block: the bank-check service once said "fake slip" for
 * one of them and the owner has not lifted it. It is a fact about the ORDER, so it survives a staff
 * member cancelling the claim and the customer paying again with a fresh payment.
 */
export const orderSlipBlocked = (payments: readonly paymentsRepo.PaymentRow[]): boolean =>
  payments.some((p) => p.slipBlockedAt !== null);

/**
 * Seconds the next slip for this ORDER has to wait (0: none). The count is the sum over all its
 * payments and the last time the latest of them, so a staff reject (a new payment) does not reset it.
 */
export function orderSlipCooldown(payments: readonly paymentsRepo.PaymentRow[], now: Date): number {
  let invalidCount = 0;
  let lastInvalidAt: Date | null = null;
  for (const p of payments) {
    invalidCount += p.slipInvalidCount;
    if (p.slipInvalidAt && (lastInvalidAt === null || p.slipInvalidAt > lastInvalidAt)) {
      lastInvalidAt = p.slipInvalidAt;
    }
  }
  return slipCooldownSeconds({ invalidCount, lastInvalidAt }, now);
}

/**
 * Why a customer's slip upload for this order is refused now, or null. The words say nothing about
 * why: a block is "this order takes no slip", a cooldown is "wait N minutes". Neither is ever
 * raised for a claim without a slip, nor for staff.
 */
export function slipUploadRefusal(
  payments: readonly paymentsRepo.PaymentRow[],
  now: Date,
): ApiError | null {
  if (orderSlipBlocked(payments)) {
    return new ApiError(409, 'SLIP_BLOCKED', 'A slip cannot be sent for this order');
  }
  const retryAfterSeconds = orderSlipCooldown(payments, now);
  if (retryAfterSeconds > 0) {
    return new ApiError(429, 'SLIP_COOLDOWN', 'Slips are being sent too often. Try again later', {
      retryAfterSeconds,
    });
  }
  return null;
}
