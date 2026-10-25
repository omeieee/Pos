/**
 * Orders board: what the table and the phone list share (waiting rule, next step, state badge, notices).
 */
import type { OrderDto } from '@sds/shared';
import { Gi } from '../../design/icons.tsx';
import { s } from '../../design/style.ts';
import { useEntities, useServices, useStoreState, useT } from '../../ui/hooks.ts';
import { localName } from '../cart/names.ts';
import { QueuedOrders } from '../outbox/QueuedOrders.tsx';
import {
  awaitingCustomerPayment,
  needsManualConfirm,
  promptpayOrderIds,
} from '../payments/pay-first-model.ts';
import {
  AwaitingPayBadge,
  ManualConfirmFlag,
  NoSlipFlag,
  OrderStatusBadge,
  PaymentStatusBadge,
} from './StatusBadge.tsx';

const WAITING = ['new', 'preparing', 'ready'] as const;
export const isWaiting = (order: OrderDto) => (WAITING as readonly string[]).includes(order.status);

export type Tr = ReturnType<typeof useT>;

/** "เย็นตาโฟ, ชาเย็น" (the design's table) or "เย็นตาโฟ ×1, ชาเย็น ×1" (its phone card). */
export function itemsSummary(order: OrderDto, locale: 'th' | 'en', always: boolean): string {
  return order.items
    .map((item) => {
      const name = localName(locale, item.nameTh, item.nameEn);
      return always || item.qty > 1 ? `${name} ×${item.qty}` : name;
    })
    .join(', ');
}

/** The one button the order needs next, as words: it only opens the order page, it never pays. */
export function nextStep(order: OrderDto): 'review' | 'charge' | 'open' {
  if (order.status === 'cancelled') return 'open';
  if (order.paymentStatus === 'awaiting_confirmation') return 'review';
  if (order.paymentStatus === 'unpaid' || order.paymentStatus === 'partially_paid') return 'charge';
  return 'open';
}

/**
 * The payment badge; a cancelled order shows that instead, because it owes nothing. A pay-first
 * LINE order that the customer has not paid yet shows a muted "รอชำระ" (the kitchen does not see it
 * yet), and a claim with a slip that the shop must confirm by hand shows the icon next to it.
 */
export function StateBadge({ order }: { order: OrderDto }) {
  const { payments } = useEntities();
  if (order.status === 'cancelled') return <OrderStatusBadge status="cancelled" />;
  // Cheap checks first: only a new, unpaid LINE order needs the payments looked at.
  const waiting =
    order.channel === 'line' &&
    order.status === 'new' &&
    order.paymentStatus === 'unpaid' &&
    awaitingCustomerPayment(order, promptpayOrderIds(payments.values()));
  const manual = needsManualConfirm(order);
  const main = waiting ? <AwaitingPayBadge /> : <PaymentStatusBadge status={order.paymentStatus} />;
  if (!order.claimWithoutSlip && !manual) return main;
  return (
    <span style={s('display:inline-flex;flex-direction:column;align-items:flex-end;gap:4px')}>
      {main}
      {order.claimWithoutSlip ? <NoSlipFlag /> : null}
      {manual ? <ManualConfirmFlag /> : null}
    </span>
  );
}

// ---------- The notices every layout shows above the orders ----------

export function Notices({ load, retry }: { load: 'loading' | 'ok' | 'error'; retry: () => void }) {
  const tr = useT();
  const { cart } = useServices();
  const cartState = useStoreState(cart);
  return (
    <>
      {cartState.phase === 'unsure' ? (
        <div
          className="g-sunk"
          role="status"
          style={s('display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px')}
        >
          <Gi n="warn" />
          <span style={s('flex:1 1 220px')}>{tr('orders.unsureCart')}</span>
          <a className="g-btn" href="#/new">
            {tr('orders.unsureCartBack')}
          </a>
        </div>
      ) : null}

      <QueuedOrders />

      {load === 'error' ? (
        <div
          className="g-sunk"
          role="alert"
          style={s(
            'display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;color:var(--chili-ink);font-weight:600',
          )}
        >
          <Gi n="warn" />
          <span style={s('flex:1 1 200px')}>{tr('orders.loadFailed')}</span>
          <button type="button" className="g-btn" onClick={retry}>
            {tr('common.retry')}
          </button>
        </div>
      ) : null}
    </>
  );
}
