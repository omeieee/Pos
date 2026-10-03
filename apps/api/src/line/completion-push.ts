/**
 * The one push per LINE order (owner, 2026-10-03; docs/04 §1.2): when staff move an order to
 * `completed`, the customer gets ONE message carrying "ready" and the e-receipt. It costs one of the
 * month's 300, so:
 *
 * - it goes only for orders that came through LINE (`channel` line) from a customer who still has
 *   a LINE user id, never for counter, phone, Grab or LINE MAN orders;
 * - it goes only through the quota-aware sender (`buildSender`): policy `off` sends nothing,
 *   at the month's limit it is dropped and the owner is warned once (`line.quota_capped`), and a
 *   second send for the same order is refused by the unique (order, template) log row, so a
 *   repeat of the event, a retry or a double click never pushes twice;
 * - when it cannot go, nothing is lost: the receipt comes as a free reply to "สถานะ" and the live
 *   order page in the customer app shows the same facts.
 *
 * It runs after the order's transaction has committed, in the background (`runtime.track`), so
 * staff never wait for LINE. It logs nothing about the customer.
 */
import { type Db, lineRepo, ordersRepo } from '@sds/db';
import { readyWithReceipt, type SendOutcome } from '@sds/line';
import { viewOrder } from '../customer-app/service.ts';
import type { EventBus } from '../events.ts';
import { methodLabelOf, READY_RECEIPT_TEMPLATE, receiptItems } from './receipt.ts';
import { buildSender, type LineRuntime } from './runtime.ts';

export interface CompletionPushDeps {
  db: Db;
  runtime: LineRuntime;
  events: EventBus;
  now: () => Date;
}

export type CompletionPushResult = SendOutcome | { sent: false; reason: 'skipped' };

/** Sends the "ready + receipt" push for a completed LINE order, once. */
export async function sendReadyReceipt(
  deps: CompletionPushDeps,
  orderId: string,
): Promise<CompletionPushResult> {
  const skipped = { sent: false, reason: 'skipped' } as const;
  const row = await ordersRepo.findOrderById(deps.db, orderId);
  if (!row || row.channel !== 'line' || row.status !== 'completed' || !row.customerId) {
    return skipped;
  }
  const customer = await lineRepo.findLiveCustomer(deps.db, row.customerId);
  if (!customer) return skipped;

  const order = await viewOrder({ db: deps.db, now: deps.now, events: deps.events }, row);
  const sender = buildSender({
    db: deps.db,
    runtime: deps.runtime,
    events: deps.events,
    now: deps.now,
  });
  return sender.push(
    customer.lineUserId,
    [
      readyWithReceipt({
        orderNo: order.orderNo,
        building: order.deliveryBuilding ?? '',
        items: receiptItems(order),
        totalSatang: order.totalSatang,
        methodLabel: methodLabelOf(order),
      }),
    ],
    {
      template: READY_RECEIPT_TEMPLATE,
      customerId: customer.id,
      orderId: order.id,
      // The `essential` policy still allows exactly this push.
      essential: true,
    },
  );
}

/**
 * Listens for a LINE order reaching `completed` and sends its push in the background. Returns the
 * unsubscribe function. Every failure is swallowed here: a push that did not go must never break
 * the staff request that made the event (the bus already isolates subscribers; this also keeps
 * the rejection from being reported as unhandled).
 */
export function registerCompletionPush(deps: CompletionPushDeps): () => void {
  return deps.events.subscribe((event) => {
    if (event.type !== 'order.upserted') return;
    const order = event.data;
    if (order.channel !== 'line' || order.status !== 'completed' || !order.customerId) return;
    deps.runtime.track(sendReadyReceipt(deps, order.id).catch(() => undefined));
  });
}
