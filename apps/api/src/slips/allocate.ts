/**
 * Which open PromptPay order a slip belongs to when the customer has several (D-40, PAY-05).
 * The amount read locally only CHOOSES the order; auto-confirm stays Slip2Go `eq` on the final
 * payment's own amount (D-27), so a wrong guess can only end in staff review.
 */
import { type Db, ordersRepo, paymentsRepo } from '@sds/db';
import { allocateSlip, type SlipAllocation, type SlipCandidate } from '@sds/shared';
import { factsOf } from '../orders/customer-edit.ts';

/** An open order of the customer with a PromptPay payment waiting (pending or claimed). */
export interface OpenCandidate {
  order: ordersRepo.OrderRow;
  /** The waiting PromptPay payment. */
  payment: paymentsRepo.PaymentRow;
  payments: paymentsRepo.PaymentRow[];
}

/** How many of the customer's latest orders are looked at. */
const SCAN = 20;

/** The customer's open orders with a PromptPay payment waiting, oldest first. */
export async function openPromptpayCandidates(
  db: Db,
  customerId: string,
): Promise<OpenCandidate[]> {
  const rows = await ordersRepo.listOrdersForCustomer(db, customerId, SCAN);
  const found: OpenCandidate[] = [];
  for (const order of rows) {
    if (order.status === 'completed' || order.status === 'cancelled') continue;
    const payments = await paymentsRepo.listPaymentsForOrder(db, order.id);
    const payment = payments.find(
      (p) => p.method === 'promptpay' && (p.status === 'pending' || p.status === 'claimed'),
    );
    if (payment) found.push({ order, payment, payments });
  }
  return found.sort(
    (a, b) =>
      a.order.placedAt.getTime() - b.order.placedAt.getTime() ||
      a.order.id.localeCompare(b.order.id),
  );
}

export const toSlipCandidate = (c: OpenCandidate): SlipCandidate => ({
  orderId: c.order.id,
  dueSatang: c.payment.amountSatang,
  facts: factsOf(c.order, c.payments),
});

/**
 * Orders that can take a new slip without replacing one already waiting for checks. With none free
 * (every open order holds a slip) all of them are candidates, and the allocation decides.
 */
export function slipFree(candidates: readonly OpenCandidate[]): OpenCandidate[] {
  const free = candidates.filter((c) => c.payment.slipImageKey === null);
  return free.length > 0 ? free : [...candidates];
}

/** What to do with a chat slip. `blocked`: attach with auto-confirm off for the claim. */
export type ChatSlipPlan =
  | { kind: 'attach'; orderId: string; blocked: boolean }
  | { kind: 'merge'; targetId: string; sourceIds: string[] };

/**
 * One open order (or one free of a slip): it gets the slip, as before. Two or more: read the
 * amount (the callback is only called then) and allocate it.
 */
export async function planChatSlip(
  candidates: readonly OpenCandidate[],
  readAmount: () => Promise<number | null>,
): Promise<ChatSlipPlan> {
  const pool = slipFree(candidates);
  const only = pool[0];
  if (pool.length === 1 && only) return { kind: 'attach', orderId: only.order.id, blocked: false };
  const allocation: SlipAllocation = allocateSlip(await readAmount(), pool.map(toSlipCandidate));
  if (allocation.kind === 'single') {
    return { kind: 'attach', orderId: allocation.orderId, blocked: false };
  }
  if (allocation.kind === 'merge') {
    return { kind: 'merge', targetId: allocation.targetId, sourceIds: allocation.sourceIds };
  }
  return { kind: 'attach', orderId: allocation.orderId, blocked: true };
}
