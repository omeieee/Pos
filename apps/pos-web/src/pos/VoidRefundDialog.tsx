import type { OrderDto, PaymentDto } from '@sds/shared';
import { useRef, useState } from 'react';
import { errorText } from '../api/errors.ts';
import { useActivityHold, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';
import { flowFor } from './payment-store.ts';

type Kind = 'void' | 'refund';
const KINDS: readonly Kind[] = ['void', 'refund'];

/**
 * Void or refund a CONFIRMED payment (a manager or the owner). It needs a reason, it is a
 * sensitive action (the step-up dialog opens first; the server writes an audit row and alerts the
 * owner), and the dialog says so. The order goes back to unpaid only when the server has answered.
 */
export function VoidRefundDialog({
  order,
  payment,
  onClose,
}: {
  order: OrderDto;
  payment: PaymentDto;
  onClose: () => void;
}) {
  const { payments } = useServices();
  const flow = useStoreState(payments);
  const tr = useT();
  const [kind, setKind] = useState<Kind>('void');
  const [reason, setReason] = useState('');
  const inFlight = useRef(false);
  const sending = flow.orderId === order.id && flow.phase === 'sending';
  const moveAction = flow.action === 'void' || flow.action === 'refund';
  const lost = flowFor(flow, order.id).unsure;
  const unsure = lost?.action === 'void' || lost?.action === 'refund';
  const failure = flow.orderId === order.id && !sending && moveAction ? flow.error : null;
  // The reason being typed and the step-up that follows must not be lost to a page reload.
  useActivityHold(true);

  async function submit() {
    const text = reason.trim();
    if (text === '' || inFlight.current) return;
    inFlight.current = true;
    try {
      const outcome =
        kind === 'void'
          ? await payments.voidPayment(order.id, payment.id, text)
          : await payments.refundPayment(order.id, payment.id, text);
      if (outcome.ok) onClose();
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <Modal labelledBy="void-title" onClose={onClose}>
      <h2 id="void-title" className="sheet__title">
        {tr('payment.void.title')}
      </h2>
      <p className="notice">
        <Icon name="info" />
        <span>{tr('payment.void.audited')}</span>
      </p>
      <fieldset className="seg">
        <legend className="visually-hidden">{tr('payment.void.kindLabel')}</legend>
        {KINDS.map((value) => (
          <label key={value} className={`seg__item${kind === value ? ' seg__item--on' : ''}`}>
            <input
              className="visually-hidden"
              type="radio"
              name="void-kind"
              checked={kind === value}
              disabled={sending}
              onChange={() => setKind(value)}
            />
            {tr(`payment.void.kind.${value}`)}
          </label>
        ))}
      </fieldset>
      <div className="field-group">
        <label className="label" htmlFor="void-reason">
          {tr('payment.void.reason')}
        </label>
        <input
          id="void-reason"
          className="input"
          type="text"
          maxLength={200}
          autoComplete="off"
          placeholder={tr('payment.void.reasonPlaceholder')}
          value={reason}
          disabled={sending}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {unsure ? (
        <p className="error" role="alert">
          {tr('payment.unsureMove')}
        </p>
      ) : failure ? (
        <p className="error" role="alert">
          {errorText(tr, failure, 'payment')}
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn-primary btn-lg btn-block"
        disabled={sending || reason.trim() === ''}
        aria-busy={sending}
        onClick={() => void submit()}
      >
        {sending
          ? tr('payment.sending')
          : tr(kind === 'void' ? 'payment.void.confirmVoid' : 'payment.void.confirmRefund')}
      </button>
      <button type="button" className="btn btn-soft btn-block" onClick={onClose}>
        {tr('common.cancel')}
      </button>
    </Modal>
  );
}
