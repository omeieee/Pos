import type { OrderPaymentStatus, OrderStatus } from '@sds/shared';
import { Gi, type GiName } from '../design/icons.tsx';
import { useT } from '../ui/hooks.ts';

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
