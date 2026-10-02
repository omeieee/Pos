import type { MessageKey } from '@sds/i18n';
import { formatBaht, formatDate } from '@sds/i18n';
import type { OrderDto, PaymentDto } from '@sds/shared';
import { useRef, useState } from 'react';
import { errorText } from '../api/errors.ts';
import { useActivityHold, useLocale, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';
import type { PaymentActions } from './payment-model.ts';

const MOVE_ACTIONS = ['claim', 'confirm', 'cancelClaimed'] as const;

/**
 * What staff can do with a waiting payment: claim it for the customer ("customer says paid"),
 * confirm it by hand after checking the bank app or ถุงเงิน (with an optional reference), or say
 * the money was not found (cancel the claim, with a reason). Which buttons show comes from the
 * shared payment machine for this role; the server checks again.
 *
 * Nothing becomes claimed or confirmed from a tap: the screen changes when the server's answer
 * (or a realtime frame) reaches the store. A double tap sends one request, and a lost answer is
 * called out as unsure (the same button can be pressed again: the server answers 200 without a
 * write when the payment is already there).
 */
export function PaymentMoves({
  order,
  payment,
  actions,
  referenceLabel,
  showClaim,
  notFoundLabel,
  children,
}: {
  order: OrderDto;
  payment: PaymentDto;
  actions: PaymentActions;
  referenceLabel: MessageKey;
  showClaim: boolean;
  notFoundLabel: MessageKey;
  /** Extra controls (change method) shown with the secondary buttons. */
  children?: React.ReactNode;
}) {
  const { payments } = useServices();
  const flow = useStoreState(payments);
  const tr = useT();
  const locale = useLocale();
  const [reference, setReference] = useState('');
  const [notFound, setNotFound] = useState(false);

  const mine = flow.orderId === order.id;
  const moveAction = (MOVE_ACTIONS as readonly string[]).includes(flow.action ?? '');
  const sending = mine && flow.phase === 'sending' && moveAction;
  const unsure = mine && flow.phase === 'unsure' && moveAction;
  const failure = mine && !sending && flow.error && moveAction ? flow.error : null;
  // A reference being typed must not be lost to a page reload.
  useActivityHold(reference !== '');

  function confirm() {
    const note = reference.trim();
    void payments.confirm(order.id, payment.id, note === '' ? {} : { referenceNote: note });
  }

  return (
    <div className="pmoves">
      {payment.status === 'claimed' ? (
        <p className="notice" role="status">
          <Icon name="clock" />
          <span>{tr('payment.claimed')}</span>
          {payment.claimedAt ? (
            <span className="muted">{formatDate(payment.claimedAt, locale, 'time')}</span>
          ) : null}
        </p>
      ) : null}

      {actions.confirm ? (
        <>
          <div className="field-group pmoves__ref">
            <label className="label" htmlFor="pay-reference">
              {tr(referenceLabel)}
            </label>
            <input
              id="pay-reference"
              className="input"
              type="text"
              maxLength={200}
              autoComplete="off"
              placeholder={tr('payment.referencePlaceholder')}
              value={reference}
              disabled={sending}
              onChange={(event) => setReference(event.target.value)}
            />
          </div>
          <p className="hint">{tr('payment.confirmHint')}</p>
        </>
      ) : null}

      {unsure ? (
        <p className="error" role="alert">
          {tr('payment.unsureMove')}
        </p>
      ) : failure ? (
        <p className="error" role="alert">
          {errorText(tr, failure, 'payment')}
        </p>
      ) : null}

      {actions.confirm ? (
        <button
          type="button"
          className="btn btn-success btn-lg btn-block"
          disabled={sending}
          aria-busy={sending}
          onClick={confirm}
        >
          <Icon name="check-circle" />
          {sending
            ? tr('payment.sending')
            : tr('payment.confirmAmount', { amount: formatBaht(order.totalSatang, locale) })}
        </button>
      ) : null}

      <div className="pmoves__row">
        {showClaim && actions.claim ? (
          <button
            type="button"
            className="btn"
            disabled={sending}
            onClick={() => void payments.claim(order.id, payment.id)}
          >
            {tr('payment.promptpay.customerSays')}
          </button>
        ) : null}
        {actions.cancelClaimed ? (
          <button
            type="button"
            className="btn"
            disabled={sending}
            onClick={() => setNotFound(true)}
          >
            {tr(notFoundLabel)}
          </button>
        ) : null}
        {children}
      </div>

      {notFound ? (
        <NotFoundDialog order={order} payment={payment} onClose={() => setNotFound(false)} />
      ) : null}
    </div>
  );
}

/** "Money not found": cancels the claim. Needs a reason (the payment machine says so). */
function NotFoundDialog({
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
  const [reason, setReason] = useState('');
  const inFlight = useRef(false);
  const sending = flow.orderId === order.id && flow.phase === 'sending';
  const failure =
    flow.orderId === order.id && !sending && flow.action === 'cancelClaimed' ? flow.error : null;
  useActivityHold(true);

  async function submit() {
    const text = reason.trim();
    if (text === '' || inFlight.current) return;
    inFlight.current = true;
    try {
      const outcome = await payments.cancelClaimed(order.id, payment.id, text);
      if (outcome.ok) onClose();
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <Modal labelledBy="notfound-title" onClose={onClose}>
      <h2 id="notfound-title" className="sheet__title">
        {tr('payment.notFound.title')}
      </h2>
      <p>{tr('payment.notFound.body')}</p>
      <div className="field-group">
        <label className="label" htmlFor="notfound-reason">
          {tr('payment.notFound.reason')}
        </label>
        <input
          id="notfound-reason"
          className="input"
          type="text"
          maxLength={200}
          autoComplete="off"
          placeholder={tr('payment.notFound.reasonPlaceholder')}
          value={reason}
          disabled={sending}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {failure ? (
        <p className="error" role="alert">
          {errorText(tr, failure, 'payment')}
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn-primary btn-lg btn-block"
        disabled={sending || reason.trim() === ''}
        onClick={() => void submit()}
      >
        {tr('payment.notFound.confirm')}
      </button>
      <button type="button" className="btn btn-soft btn-block" onClick={onClose}>
        {tr('common.cancel')}
      </button>
    </Modal>
  );
}
