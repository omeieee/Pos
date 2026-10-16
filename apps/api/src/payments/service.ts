/**
 * Payments (02 §4.2–4.4, 03 §4; CLAUDE.md rules 1–4, 6, 9). Every write is one transaction that
 * takes the ORDER row lock first (so two requests for one order queue up and cannot both see "no
 * open payment"), changes the payment through the state machine in `@sds/shared`, recomputes the
 * order's `payment_status` and bumps the order, and publishes `payment.upserted` and
 * `order.upserted` only after the commit.
 *
 * - The amount is always the order total; a client sends none (cash sends what was handed over).
 * - Staff confirm every payment. Cash is recorded as confirmed in the same step by the signed-in
 *   staff member (the machine checks `payment.confirm`); everything else waits for a confirm.
 * - Nothing here stores or returns a QR payload or the PromptPay ID: the picture is rebuilt from
 *   the current setting each time it is served.
 *
 * Retries: creating a payment (and changing the method) is idempotent by `clientRequestId` with a
 * request fingerprint. The other moves are naturally idempotent: a payment already in the target
 * status answers 200 with nothing written (no event, audit row or alert), and `expectedVersion`
 * is optional, as on `/v1/orders/:id/transition`.
 *
 * PGlite (the test database) runs one query at a time, so the order lock is NOT proven by the
 * tests here; the lock order (order, then payment) is what keeps real Postgres free of deadlocks.
 */

export type { AutoConfirmInput } from './auto-confirm.ts';
export { autoConfirmClaimedPayment } from './auto-confirm.ts';
export { changePaymentMethod, withdrawPendingPayment } from './change-method.ts';
export { createPayment } from './create.ts';
export type { CustomerActor, PaymentActor } from './internal.ts';
export { claimWithoutSlipOf, offeredCopay } from './internal.ts';
export type { MoveInput, PaymentMove } from './moves.ts';
export { movePayment } from './moves.ts';
export type { AdjustOutcome } from './order-hooks.ts';
export {
  adjustPaymentsForOwnerChange,
  retirePaymentsForOwnerChange,
  settlePaymentsForOrderCancel,
} from './order-hooks.ts';
export { listOrderPayments, paymentQrUrl, renderPaymentQr } from './read.ts';
