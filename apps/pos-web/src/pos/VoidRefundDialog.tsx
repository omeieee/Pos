import type { OrderDto, PaymentDto } from '@sds/shared';
import { useRef, useState } from 'react';
import { errorText } from '../api/errors.ts';
import { s } from '../design/style.ts';
import { useActivityHold, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Callout, PayModal, SheetBody, SheetTitle, TextRow } from './PayParts.tsx';
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
    <PayModal labelledBy="void-title" onClose={onClose}>
      <SheetBody>
        <SheetTitle id="void-title">{tr('payment.void.title')}</SheetTitle>
        <Callout tone="warn" icon="shieldCheck">
          {tr('payment.void.audited')}
        </Callout>
        <fieldset
          className="g-seg"
          style={s('border:0;margin:0;min-width:0;display:flex;width:100%')}
        >
          <legend className="visually-hidden">{tr('payment.void.kindLabel')}</legend>
          {KINDS.map((value) => (
            <label key={value} className="g-chip" style={s('flex:1;padding:0 10px')}>
              <input
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
        <TextRow
          id="void-reason"
          label={tr('payment.void.reason')}
          placeholder={tr('payment.void.reasonPlaceholder')}
          value={reason}
          disabled={sending}
          onChange={setReason}
        />
        {unsure ? (
          <Callout tone="bad" role="alert">
            {tr('payment.unsureMove')}
          </Callout>
        ) : failure ? (
          <Callout tone="bad" role="alert">
            {errorText(tr, failure, 'payment')}
          </Callout>
        ) : null}
        <button
          type="button"
          className="g-btn g-btn-p g-btn-lg g-btn-block"
          disabled={sending || reason.trim() === ''}
          aria-busy={sending}
          onClick={() => void submit()}
        >
          {sending
            ? tr('payment.sending')
            : tr(kind === 'void' ? 'payment.void.confirmVoid' : 'payment.void.confirmRefund')}
        </button>
        <button type="button" className="g-btn g-btn-block" onClick={onClose}>
          {tr('common.cancel')}
        </button>
      </SheetBody>
    </PayModal>
  );
}
