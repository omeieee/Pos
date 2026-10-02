import type { OrderDto, PaymentDto } from '@sds/shared';
import { useAuthState, useT } from '../ui/hooks.ts';
import { PaymentMoves } from './PaymentMoves.tsx';
import { PromptPayPanel } from './PromptPayPanel.tsx';
import { paymentActions } from './payment-model.ts';

/** The screen of a payment that is waiting (pending or claimed), by method. */
export function OpenPayment({
  order,
  payment,
}: {
  order: OrderDto;
  payment: PaymentDto | undefined;
}) {
  const tr = useT();
  const role = useAuthState().session?.staff.role;
  if (!role) return null;
  if (!payment) {
    // The order says a payment is waiting but its row has not arrived yet.
    return (
      <p className="muted" role="status">
        {tr('payment.loading')}
      </p>
    );
  }
  const actions = paymentActions(role, payment);
  if (payment.method === 'promptpay') {
    return <PromptPayPanel order={order} payment={payment} actions={actions} />;
  }
  return (
    <PaymentMoves
      order={order}
      payment={payment}
      actions={actions}
      referenceLabel="payment.reference"
      showClaim={false}
      notFoundLabel="payment.promptpay.notFound"
    />
  );
}
