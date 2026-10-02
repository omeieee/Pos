import type { OrderDto } from '@sds/shared';
import type { ReactNode } from 'react';
import { errorText } from '../api/errors.ts';
import { useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import type { PayMethod } from './payment-model.ts';

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
  const mine = flow.orderId === order.id;
  const sending = mine && flow.phase === 'sending';
  const startAction = flow.action === 'create' || flow.action === 'changeMethod';
  const unsure = mine && flow.phase === 'unsure' && startAction;
  const failure = mine && !sending && flow.error && startAction ? flow.error : null;

  async function start() {
    if (sending) return;
    onAttempt?.(method);
    const outcome = changeFrom
      ? await payments.changeMethod(order.id, changeFrom, { method })
      : await payments.create(order.id, { method });
    if (outcome.ok) onDone?.();
  }

  return (
    <div className="start">
      {children}
      {unsure ? (
        <p className="error" role="alert">
          {tr('payment.unsure')}
        </p>
      ) : failure ? (
        <p className="error" role="alert">
          {errorText(tr, failure, 'payment')}
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn-primary btn-lg btn-block"
        disabled={sending}
        aria-busy={sending}
        onClick={() => void start()}
      >
        <Icon name={method === 'promptpay' ? 'qr' : 'hands'} />
        {sending ? tr('payment.sending') : (label ?? tr(`payment.start.${method}`))}
      </button>
    </div>
  );
}
