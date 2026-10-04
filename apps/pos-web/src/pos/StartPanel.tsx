import type { OrderDto } from '@sds/shared';
import type { ReactNode } from 'react';
import { errorText } from '../api/errors.ts';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Callout } from './PayParts.tsx';
import type { PayMethod } from './payment-model.ts';
import { flowFor } from './payment-store.ts';

type Starter = Exclude<PayMethod, 'cash'>;

/**
 * The start button of a method that waits for something outside the app (PromptPay, ไทยช่วยไทย).
 * It creates the pending payment (`{method}` only: no amount); or, when changing from a waiting
 * payment, makes the change-method call. The payment is created only by this button, never by
 * choosing the method, so looking at a method makes nothing.
 */
export function StartPanel({
  order,
  method,
  changeFrom,
  onAttempt,
  onDone,
  label,
  children,
}: {
  order: OrderDto;
  method: Starter;
  /** The waiting payment this one replaces (the change-method call), if any. */
  changeFrom?: string;
  onAttempt?: (method: PayMethod) => void;
  onDone?: () => void;
  /** The button text; the start text of the method when not given. */
  label?: string;
  children?: ReactNode;
}) {
  const { payments } = useServices();
  const flow = useStoreState(payments);
  const tr = useT();
  const mine = flowFor(flow, order.id);
  const action = changeFrom ? 'changeMethod' : 'create';
  const sending = mine.sending !== null;
  const unsure = mine.unsure?.action === action ? mine.unsure : null;
  const failure = !sending && mine.refused?.action === action ? mine.refused.error : null;

  async function start() {
    if (sending) return;
    onAttempt?.(method);
    const outcome = changeFrom
      ? await payments.changeMethod(order.id, changeFrom, { method })
      : await payments.create(order.id, { method });
    if (outcome.ok) onDone?.();
  }

  return (
    <div
      className="pay-grow"
      style={s('display:flex;flex-direction:column;gap:14px;width:100%;min-width:0')}
    >
      {children}
      {unsure ? (
        <Callout tone="bad" role="alert">
          {tr(unsure.input?.method === method ? 'payment.unsure' : 'payment.unsureOtherMethod')}
        </Callout>
      ) : failure ? (
        <Callout tone="bad" role="alert">
          {errorText(tr, failure, 'payment')}
        </Callout>
      ) : null}
      <button
        type="button"
        className="g-btn g-btn-p g-btn-lg g-btn-block"
        disabled={sending}
        aria-busy={sending}
        onClick={() => void start()}
      >
        <Gi n={method === 'promptpay' ? 'qrBig' : 'bank'} />
        {sending ? tr('payment.sending') : (label ?? tr(`payment.start.${method}`))}
      </button>
    </div>
  );
}
