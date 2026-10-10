/**
 * The one push per LINE order (owner, 2026-10-03; moved from `completed` to `ready` 2026-10-11;
 * docs/04 §1.2): when staff move an order to `ready`, the customer gets ONE "ready" message. There
 * is no automatic e-receipt: staff issue a receipt only on request. It costs one of the month's
 * 300, so:
 *
 * - it goes only for orders that came through LINE (`channel` line) from a customer who still has
 *   a LINE user id, never for counter, phone, Grab or LINE MAN orders;
 * - it goes only through the quota-aware sender (`buildSender`): policy `off` sends nothing,
 *   at the month's limit it is dropped and the owner is warned once (`line.quota_capped`), and a
 *   second send for the same order is refused by the unique (order, template) log row, so a
 *   repeat of the event, a retry or a double click never pushes twice;
 * - when it cannot go, nothing is lost: "สถานะ" answers for free and the live order page in the
 *   customer app shows the same facts.
 *
 * It runs after the order's transaction has committed, in the background (`runtime.track`), so
 * staff never wait for LINE. It logs nothing about the customer.
 */
import { type Db, lineRepo, ordersRepo } from '@sds/db';
import { readyCard, type SendOutcome } from '@sds/line';
import { viewOrder } from '../customer-app/service.ts';
import type { EventBus } from '../events.ts';
import { buildSender, type LineRuntime } from './runtime.ts';

/** The template name in `line_message_log`: one counted push per order and template. */
export const READY_TEMPLATE = 'ready';

export interface CompletionPushDeps {
  db: Db;
  runtime: LineRuntime;
  events: EventBus;
  now: () => Date;
}

export type CompletionPushResult = SendOutcome | { sent: false; reason: 'skipped' };

/** Sends the "ready" push for a LINE order that is ready, once. */
export async function sendReady(
  deps: CompletionPushDeps,
  orderId: string,
): Promise<CompletionPushResult> {
  const skipped = { sent: false, reason: 'skipped' } as const;
  const row = await ordersRepo.findOrderById(deps.db, orderId);
  if (!row || row.channel !== 'line' || row.status !== 'ready' || !row.customerId) {
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
    [readyCard({ orderNo: order.orderNo, building: order.deliveryBuilding ?? '' })],
    {
      template: READY_TEMPLATE,
      customerId: customer.id,
      orderId: order.id,
      // The `essential` policy still allows exactly this push.
      essential: true,
    },
  );
}

/**
 * Listens for a LINE order reaching `ready` and sends its push in the background. Returns the
 * unsubscribe function. Every failure is swallowed here: a push that did not go must never break
 * the staff request that made the event (the bus already isolates subscribers; this also keeps
 * the rejection from being reported as unhandled).
 */
export function registerCompletionPush(deps: CompletionPushDeps): () => void {
  return deps.events.subscribe((event) => {
    if (event.type !== 'order.upserted') return;
    const order = event.data;
    if (order.channel !== 'line' || order.status !== 'ready' || !order.customerId) return;
    deps.runtime.track(sendReady(deps, order.id).catch(() => undefined));
  });
}
