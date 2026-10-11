/**
 * The one LINE message to the customer after the owner voids or edits their order (owner decision
 * 2026-10-11). It costs one of the month's 300, so, like the "ready" push (`completion-push.ts`):
 *
 * - it goes only for orders that came through LINE, from a customer who still has a LINE user id;
 * - it goes only through the quota-aware sender (`buildSender`): policy `off` sends nothing, at the
 *   month's limit it is dropped and the owner is warned once by the sender, and the unique
 *   (order, template) log row refuses a repeat. A void sends template `order_void` (once per
 *   order); each edit sends `order_edit:<version>`, so two edits are two messages (two units);
 * - it counts as `essential` (it tells the customer about their money), so the default policy
 *   still allows it;
 * - it runs after the commit, in the background, and returns the outcome without logging anything
 *   about the customer. Nothing is lost when it cannot go: the live order page shows the same facts.
 *
 * Text only, from `packages/i18n`: the order number, what happened, the amounts. No other personal data.
 */
import { type Db, lineRepo, ordersRepo } from '@sds/db';
import { botText, type SendOutcome, type TextMessage } from '@sds/line';
import type { EventBus } from '../events.ts';
import type { OrderChangeNotice } from '../orders/change-notice.ts';
import { buildSender, type LineRuntime } from './runtime.ts';

export interface OrderChangePushDeps {
  db: Db;
  runtime: LineRuntime;
  events: EventBus;
  now: () => Date;
}

export type OrderChangePushResult = SendOutcome | { sent: false; reason: 'skipped' };

/** `฿1,234` or `฿1,234.50`: whole-satang arithmetic, no floating point. */
function baht(satang: number): string {
  const whole = Math.trunc(satang / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = satang % 100;
  return `฿${whole}${cents === 0 ? '' : `.${String(cents).padStart(2, '0')}`}`;
}

export function orderChangeText(notice: OrderChangeNotice, orderNo: string): TextMessage {
  const lines =
    notice.kind === 'void'
      ? [botText('lineBot.orderChange.voided', { orderNo }).text]
      : [
          botText('lineBot.orderChange.edited', {
            orderNo,
            total: baht(notice.totalSatang),
          }).text,
        ];
  if (notice.refundedSatang > 0) {
    lines.push(botText('lineBot.orderChange.refund', { amount: baht(notice.refundedSatang) }).text);
  }
  if (notice.dueSatang > 0) {
    lines.push(botText('lineBot.orderChange.due', { amount: baht(notice.dueSatang) }).text);
  }
  return { type: 'text', text: lines.join('\n') };
}

export async function sendOrderChange(
  deps: OrderChangePushDeps,
  notice: OrderChangeNotice,
): Promise<OrderChangePushResult> {
  const skipped = { sent: false, reason: 'skipped' } as const;
  const row = await ordersRepo.findOrderById(deps.db, notice.orderId);
  if (!row || row.channel !== 'line' || !row.customerId) return skipped;
  const customer = await lineRepo.findLiveCustomer(deps.db, row.customerId);
  if (!customer) return skipped;
  const sender = buildSender({
    db: deps.db,
    runtime: deps.runtime,
    events: deps.events,
    now: deps.now,
  });
  return sender.push(customer.lineUserId, [orderChangeText(notice, row.orderNo)], {
    template: notice.kind === 'void' ? 'order_void' : `order_edit:${notice.version}`,
    customerId: customer.id,
    orderId: row.id,
    essential: true,
  });
}

/** Sends in the background; a failure never reaches the owner's request. */
export function notifyOrderChange(deps: OrderChangePushDeps, notice: OrderChangeNotice): void {
  deps.runtime.track(sendOrderChange(deps, notice).catch(() => undefined));
}
