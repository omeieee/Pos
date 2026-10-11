/**
 * The one LINE message to the customer when staff reject their claimed payment ("โอนแล้ว" but no
 * money was found: `cancel-claimed`). Without it the customer only sees the order carry on.
 * It costs one of the month's 300, so, like `order-change-push.ts`:
 *
 * - it goes only for orders that came through LINE, from a customer who still has a LINE user id;
 * - it goes only through the quota-aware sender (`buildSender`): policy `off` sends nothing, at the
 *   month's limit it is dropped and the owner is warned once, and the unique (order, template) log
 *   row refuses a repeat. The template carries the payment id, so a retried reject is one message
 *   and a second rejected claim on the same order is its own;
 * - it counts as `essential` (it is about the customer's money);
 * - it runs after the commit, in the background; nothing is lost when it cannot go, because the
 *   live order page shows the same facts (`paymentRejected`).
 *
 * Text only, from `packages/i18n`: the order number and nothing else personal.
 */
import { type Db, lineRepo, ordersRepo, paymentsRepo } from '@sds/db';
import { botText, type SendOutcome } from '@sds/line';
import type { EventBus } from '../events.ts';
import { buildSender, type LineRuntime } from './runtime.ts';

export interface PaymentRejectedPushDeps {
  db: Db;
  runtime: LineRuntime;
  events: EventBus;
  now: () => Date;
}

export type PaymentRejectedPushResult = SendOutcome | { sent: false; reason: 'skipped' };

export const paymentRejectedTemplate = (paymentId: string) => `payment_rejected:${paymentId}`;

export async function sendPaymentRejected(
  deps: PaymentRejectedPushDeps,
  paymentId: string,
): Promise<PaymentRejectedPushResult> {
  const skipped = { sent: false, reason: 'skipped' } as const;
  const payment = await paymentsRepo.findPaymentById(deps.db, paymentId);
  // Only a claim that staff cancelled: a pending payment that was merely replaced has no claim.
  if (payment?.status !== 'cancelled' || payment.claimedAt === null) return skipped;
  const row = await ordersRepo.findOrderById(deps.db, payment.orderId);
  if (row?.channel !== 'line' || !row.customerId) return skipped;
  const customer = await lineRepo.findLiveCustomer(deps.db, row.customerId);
  if (!customer) return skipped;
  const sender = buildSender({
    db: deps.db,
    runtime: deps.runtime,
    events: deps.events,
    now: deps.now,
  });
  return sender.push(
    customer.lineUserId,
    [botText('lineBot.paymentRejected', { orderNo: row.orderNo })],
    {
      template: paymentRejectedTemplate(payment.id),
      customerId: customer.id,
      orderId: row.id,
      essential: true,
    },
  );
}

/** Sends in the background; a failure never reaches the staff request. */
export function notifyPaymentRejected(deps: PaymentRejectedPushDeps, paymentId: string): void {
  deps.runtime.track(sendPaymentRejected(deps, paymentId).catch(() => undefined));
}
