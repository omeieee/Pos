import type { OrderPaymentStatus, OrderStatus } from '@sds/shared';
import type { IconName } from '../app/routes.ts';
import { useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';

/** Colour + icon + words, always together (brand §3): a status is never colour alone. */
const PAYMENT: Record<OrderPaymentStatus, { tone: string; icon: IconName }> = {
  unpaid: { tone: 'warning', icon: 'circle' },
  awaiting_confirmation: { tone: 'info', icon: 'clock' },
  partially_paid: { tone: 'info', icon: 'clock' },
  paid: { tone: 'success', icon: 'check-circle' },
  refunded: { tone: 'neutral', icon: 'sync' },
};

const ORDER: Record<OrderStatus, { tone: string; icon: IconName }> = {
  new: { tone: 'brand', icon: 'circle' },
  preparing: { tone: 'warning', icon: 'clock' },
  ready: { tone: 'success', icon: 'check-circle' },
  completed: { tone: 'neutral', icon: 'check' },
  cancelled: { tone: 'danger', icon: 'x' },
};

export function PaymentStatusBadge({ status }: { status: OrderPaymentStatus }) {
  const tr = useT();
  const { tone, icon } = PAYMENT[status];
  return (
    <span className={`status status--${tone}`}>
      <Icon name={icon} />
      {tr(`status.payment.${status}`)}
    </span>
  );
}

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const tr = useT();
  const { tone, icon } = ORDER[status];
  return (
    <span className={`status status--${tone}`}>
      <Icon name={icon} />
      {tr(`status.order.${status}`)}
    </span>
  );
}
