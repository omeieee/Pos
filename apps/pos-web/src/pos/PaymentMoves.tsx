import type { MessageKey } from '@sds/i18n';
import { formatBaht, formatDate } from '@sds/i18n';
import type { OrderDto, PaymentDto } from '@sds/shared';
import { type ReactNode, useRef, useState } from 'react';
import { errorText } from '../api/errors.ts';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useActivityHold, useLocale, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Callout, PayModal, SheetBody, SheetTitle, TextRow } from './PayParts.tsx';
import { collectAmount, type PaymentActions } from './payment-model.ts';
import { flowFor } from './payment-store.ts';

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
  lead,
  children,
}: {
  order: OrderDto;
  payment: PaymentDto;
  actions: PaymentActions;
  referenceLabel: MessageKey;
  showClaim: boolean;
  notFoundLabel: MessageKey;
  /** A first secondary control (the customer view of PromptPay). */
  lead?: ReactNode;
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
  const lost = flowFor(flow, order.id).unsure;
  const unsure = lost !== null && (MOVE_ACTIONS as readonly string[]).includes(lost.action);
  const failure = mine && !sending && flow.error && moveAction ? flow.error : null;
  // A reference being typed must not be lost to a page reload.
  useActivityHold(reference !== '');

  function confirm() {
    const note = reference.trim();
    void payments.confirm(order.id, payment.id, note === '' ? {} : { referenceNote: note });
  }

  return (
    <div style={s('display:flex;flex-direction:column;gap:12px;margin-top:auto;min-width:0')}>
      {payment.status === 'claimed' ? (
        <Callout tone="info" icon="clock" role="status">
          {tr('payment.claimed')}
          {payment.claimedAt ? (
            <span className="g-num" style={s('margin-left:8px;font-weight:500')}>
              {formatDate(payment.claimedAt, locale, 'time')}
            </span>
          ) : null}
        </Callout>
      ) : null}

      {actions.confirm ? (
        <>
          <TextRow
            compact
            id="pay-reference"
            label={tr(referenceLabel)}
            placeholder={tr('payment.referencePlaceholder')}
            value={reference}
            disabled={sending}
            onChange={setReference}
          />
          <p className="g-t-c" style={s('margin:0')}>
            {tr('payment.confirmHint')}
          </p>
        </>
      ) : null}

      {unsure ? (
        <Callout tone="bad" role="alert">
          {tr('payment.unsureMove')}
        </Callout>
      ) : failure ? (
        <Callout tone="bad" role="alert">
          {errorText(tr, failure, 'payment')}
        </Callout>
      ) : null}

      <div style={s('display:flex;gap:10px;flex-wrap:wrap')}>
        {lead}
        {showClaim && actions.claim ? (
          <button
            type="button"
            className="g-btn pay-sub"
            disabled={sending}
            onClick={() => void payments.claim(order.id, payment.id)}
          >
            {tr('payment.promptpay.customerSays')}
          </button>
        ) : null}
        {actions.cancelClaimed ? (
          <button
            type="button"
            className="g-btn pay-sub"
            disabled={sending}
            onClick={() => setNotFound(true)}
          >
            {tr(notFoundLabel)}
          </button>
        ) : null}
        {children}
      </div>

      {actions.confirm ? (
        <button
          type="button"
          className="g-btn g-btn-ok g-btn-lg g-btn-block"
          disabled={sending}
          aria-busy={sending}
          onClick={confirm}
        >
          <Gi n="check" />
          {sending
            ? tr('payment.sending')
            : tr('payment.confirmAmount', {
                amount: formatBaht(collectAmount(order, payment, undefined), locale),
              })}
        </button>
      ) : null}

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
    <PayModal labelledBy="notfound-title" onClose={onClose}>
      <SheetBody>
        <SheetTitle id="notfound-title">{tr('payment.notFound.title')}</SheetTitle>
        <p className="g-t-s" style={s('margin:0')}>
          {tr('payment.notFound.body')}
        </p>
        <TextRow
          id="notfound-reason"
          label={tr('payment.notFound.reason')}
          placeholder={tr('payment.notFound.reasonPlaceholder')}
          value={reason}
          disabled={sending}
          onChange={setReason}
        />
        {failure ? (
          <Callout tone="bad" role="alert">
            {errorText(tr, failure, 'payment')}
          </Callout>
        ) : null}
        <button
          type="button"
          className="g-btn g-btn-p g-btn-lg g-btn-block"
          disabled={sending || reason.trim() === ''}
          onClick={() => void submit()}
        >
          {tr('payment.notFound.confirm')}
        </button>
        <button type="button" className="g-btn g-btn-block" onClick={onClose}>
          {tr('common.cancel')}
        </button>
      </SheetBody>
    </PayModal>
  );
}
