import { useEffect, useState } from 'react';
import { s } from '../../design/style.ts';
import { useServices, useT } from '../../ui/hooks.ts';
import { Callout } from './PayParts.tsx';

/**
 * Says that the server confirmed this payment by itself after the bank check (D-27, Slip2Go), and
 * that staff can still review it and void or refund it. The fact comes only with the payment list
 * answer, so it is asked for here, and again whenever the payment's revision changes (the
 * confirmation arrives as a new revision, so the note appears without a reload). When the list
 * cannot be read it says nothing: a missing note never hides a payment or its void button.
 */
export function AutoConfirmedNote({
  orderId,
  paymentId,
  rev,
  compact = false,
}: {
  orderId: string;
  paymentId: string;
  rev: number;
  /** In the payment history: a short line instead of a block. */
  compact?: boolean;
}) {
  const tr = useT();
  const { api } = useServices();
  const [auto, setAuto] = useState(false);

  // `rev` is a dependency on purpose: see above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let live = true;
    api.payments
      .list(orderId)
      .then((answer) => {
        if (live) setAuto(answer.autoConfirmedPaymentIds?.includes(paymentId) === true);
      })
      .catch(() => {
        if (live) setAuto(false);
      });
    return () => {
      live = false;
    };
  }, [api, orderId, paymentId, rev]);

  if (!auto) return null;
  if (compact) {
    return (
      <span className="g-t-c" data-testid="auto-confirmed-row" style={s('font-weight:600')}>
        {tr('payment.autoConfirmed.note')}
      </span>
    );
  }
  return (
    <div data-testid="auto-confirmed" style={s('max-width:460px;text-align:left')}>
      <Callout tone="info" role="status">
        <span className="g-badge g-b-info" style={s('margin-right:8px')}>
          {tr('payment.autoConfirmed.chip')}
        </span>
        {tr('payment.autoConfirmed.note')}
      </Callout>
    </div>
  );
}
