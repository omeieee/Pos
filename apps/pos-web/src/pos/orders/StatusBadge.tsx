import type { OrderPaymentStatus, OrderStatus } from '@sds/shared';
import { Gi, type GiName } from '../../design/icons.tsx';
import { useT } from '../../ui/hooks.ts';

/** Colour + icon + words, always together (brand §3): a status is never colour alone. */
type Tone = 'warn' | 'info' | 'ok' | 'bad' | 'mute';

const PAYMENT: Record<OrderPaymentStatus, { tone: Tone; icon: GiName }> = {
  unpaid: { tone: 'warn', icon: 'pending' },
  awaiting_confirmation: { tone: 'info', icon: 'clock' },
  partially_paid: { tone: 'info', icon: 'clock' },
  paid: { tone: 'ok', icon: 'check' },
  refunded: { tone: 'mute', icon: 'clock' },
};

const ORDER: Record<OrderStatus, { tone: Tone; icon: GiName }> = {
  new: { tone: 'bad', icon: 'dot' },
  preparing: { tone: 'warn', icon: 'flame' },
  ready: { tone: 'ok', icon: 'check' },
  completed: { tone: 'mute', icon: 'check' },
  cancelled: { tone: 'bad', icon: 'x' },
};

export function PaymentStatusBadge({ status }: { status: OrderPaymentStatus }) {
  const tr = useT();
  const { tone, icon } = PAYMENT[status];
  return (
    <span className={`g-badge g-b-${tone} status`}>
      <Gi n={icon} />
      {tr(`status.payment.${status}`)}
    </span>
  );
}

/** "Says paid, but no slip yet": the claim waits on the staff's own check of the bank app. */
export function NoSlipFlag() {
  const tr = useT();
  return (
    <span className="g-badge g-b-warn status">
      <Gi n="info" />
      {tr('orders.flag.noSlip')}
    </span>
  );
}

/**
 * "Confirm by hand": a slip is on the claim and the payment is not confirmed, so the shop must
 * check the bank app and confirm it (D-42). Words and icon, with the longer reason as a tooltip.
 */
export function ManualConfirmFlag() {
  const tr = useT();
  return (
    <span className="g-badge g-b-warn status" title={tr('orders.flag.manualConfirmHint')}>
      <Gi n="shieldCheck" />
      {tr('orders.flag.manualConfirm')}
      <span className="visually-hidden">. {tr('orders.flag.manualConfirmHint')}</span>
    </span>
  );
}

/** A pay-first LINE order that waits for the customer's money: muted, the kitchen does not see it yet (D-38). */
export function AwaitingPayBadge() {
  const tr = useT();
  return (
    <span className="g-badge g-b-mute status" title={tr('orders.flag.awaitingPayHint')}>
      <Gi n="clock" />
      {tr('orders.flag.awaitingPay')}
      <span className="visually-hidden">. {tr('orders.flag.awaitingPayHint')}</span>
    </span>
  );
}

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const tr = useT();
  const { tone, icon } = ORDER[status];
  return (
    <span className={`g-badge g-b-${tone} status`}>
      <Gi n={icon} />
      {tr(`status.order.${status}`)}
    </span>
  );
}
