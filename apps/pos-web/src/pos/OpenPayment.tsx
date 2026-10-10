import type { OrderDto, PaymentDto } from '@sds/shared';
import { s } from '../design/style.ts';
import { useAuthState, useT } from '../ui/hooks.ts';
import { ChangeMethod } from './ChangeMethod.tsx';
import { GovCopayPanel } from './GovCopayPanel.tsx';
import { PaymentMoves } from './PaymentMoves.tsx';
import { PromptPayPanel } from './PromptPayPanel.tsx';
import { type PayMethod, paymentActions } from './payment-model.ts';
import { SlipView } from './SlipView.tsx';

/** The screen of a payment that is waiting (pending or claimed), by method. */
export function OpenPayment({
  order,
  payment,
  hidden,
  onAttempt,
}: {
  order: OrderDto;
  payment: PaymentDto | undefined;
  hidden: ReadonlySet<PayMethod>;
  onAttempt: (method: PayMethod) => void;
}) {
  const tr = useT();
  const role = useAuthState().session?.staff.role;
  if (!role) return null;
  if (!payment) {
    // The order says a payment is waiting but its row has not arrived yet.
    return (
      <p className="g-t-s" role="status" style={s('margin:0')}>
        {tr('payment.loading')}
      </p>
    );
  }
  const actions = paymentActions(role, payment);
  const change = actions.changeMethod ? (
    <ChangeMethod order={order} payment={payment} hidden={hidden} onAttempt={onAttempt} />
  ) : null;
  // A claimed payment cannot change method until the claim is cancelled.
  const claimedHint =
    payment.status === 'claimed' ? (
      <p className="g-t-c" style={s('margin:0')}>
        {tr('payment.change.claimedFirst')}
      </p>
    ) : null;
  return (
    <>
      {payment.method === 'promptpay' ? (
        <PromptPayPanel order={order} payment={payment} actions={actions}>
          {change}
        </PromptPayPanel>
      ) : payment.method === 'gov_copay' ? (
        <GovCopayPanel order={order} payment={payment} actions={actions}>
          {change}
        </GovCopayPanel>
      ) : (
        <PaymentMoves
          order={order}
          payment={payment}
          actions={actions}
          referenceLabel="payment.reference"
          showClaim={false}
          notFoundLabel="payment.promptpay.notFound"
        >
          {change}
        </PaymentMoves>
      )}
      {claimedHint}
      {payment.status === 'claimed' && payment.method === 'promptpay' ? (
        <SlipView orderId={order.id} paymentId={payment.id} rev={payment.rev} />
      ) : null}
    </>
  );
}
