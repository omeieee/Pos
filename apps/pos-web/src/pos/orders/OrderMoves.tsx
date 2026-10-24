import type { OrderDto, StaffRole } from '@sds/shared';
import { useEffect, useState } from 'react';
import { errorText } from '../../api/errors.ts';
import { s } from '../../design/style.ts';
import { useActivityHold, useEntities, useServices, useStoreState, useT } from '../../ui/hooks.ts';
import { Callout, PayModal, SheetBody, SheetTitle, TextRow } from '../payments/PayParts.tsx';
import { promptpayOrderIds, startPlan } from '../payments/pay-first-model.ts';
import { type OrderMove, orderMovesFor } from './order-board.ts';

/**
 * The status moves this role may make on the order (read from the shared order machine). A move
 * is one tap; a cancel asks for a reason first. The order on screen changes only when the server
 * has answered (the order it returns goes into the store), never from the tap. The calls go
 * through the order-moves store: one move per order at a time, a lost answer is reconciled by
 * reading the order again, and an answer that arrives after sign-out is dropped.
 */
export function OrderMoves({ order, role }: { order: OrderDto; role: StaffRole }) {
  const { orderMoves: moveStore } = useServices();
  const flow = useStoreState(moveStore);
  const tr = useT();
  const { payments } = useEntities();
  // An unpaid pay-first order has no plain accept (D-38): it waits for the payment, or a manager
  // or owner starts it with the explicit unpaid action.
  const plan =
    order.status === 'new'
      ? startPlan(order, role, promptpayOrderIds(payments.values()))
      : 'normal';
  // The owner's void (with its payment choice) replaces the plain cancel of a finished order.
  const moves = orderMovesFor(order.status, role, plan).filter(
    (move) => !(move.kind === 'cancel' && order.status === 'completed'),
  );
  const [cancelling, setCancelling] = useState(false);
  const [startingUnpaid, setStartingUnpaid] = useState(false);
  if (moves.length === 0 && plan === 'normal') return null;

  const pending = flow.pending.includes(order.id);
  // An error belongs to the status it was refused from; once the order has moved on it is stale.
  const failure = flow.errors[order.id];
  const shown =
    failure && failure.from === order.status && !cancelling && !startingUnpaid
      ? failure.error
      : null;

  function choose(move: OrderMove) {
    if (move.kind === 'cancel') setCancelling(true);
    else void moveStore.transition(order, move.to);
  }

  return (
    <div style={s('display:flex;flex-direction:column;gap:10px;flex:none')}>
      <fieldset
        style={s('border:0;margin:0;padding:0;min-width:0;display:flex;gap:10px;flex-wrap:wrap')}
      >
        <legend className="visually-hidden">{tr('order.moves.label')}</legend>
        {plan === 'override' ? (
          <button
            type="button"
            className="g-btn g-btn-p g-btn-lg"
            style={s('flex:1 1 auto')}
            disabled={pending}
            aria-busy={pending}
            onClick={() => setStartingUnpaid(true)}
          >
            {tr('order.move.startUnpaid')}
          </button>
        ) : null}
        {moves.map((move) => (
          <button
            key={move.to}
            type="button"
            className={move.kind === 'cancel' ? 'g-btn' : 'g-btn g-btn-p g-btn-lg'}
            style={s(move.kind === 'cancel' ? 'flex:none' : 'flex:1 1 auto')}
            disabled={pending}
            aria-busy={pending}
            onClick={() => choose(move)}
          >
            {tr(`order.move.${move.to}`)}
          </button>
        ))}
      </fieldset>
      {plan !== 'normal' ? (
        <Callout tone="info" role="status">
          {tr('order.startUnpaid.wait')}
        </Callout>
      ) : null}
      {shown ? (
        <Callout tone="bad" role="alert">
          {errorText(tr, shown)}
        </Callout>
      ) : null}
      {cancelling ? <CancelOrderDialog order={order} onClose={() => setCancelling(false)} /> : null}
      {startingUnpaid ? (
        <StartUnpaidDialog order={order} onClose={() => setStartingUnpaid(false)} />
      ) : null}
    </div>
  );
}

/** Manager or owner: start an unpaid pay-first order anyway. A reason is required; the server audits it. */
function StartUnpaidDialog({ order, onClose }: { order: OrderDto; onClose: () => void }) {
  const { orderMoves: moveStore } = useServices();
  const flow = useStoreState(moveStore);
  const tr = useT();
  const [reason, setReason] = useState('');
  useActivityHold(true);
  useEffect(() => moveStore.dismiss(order.id), [moveStore, order.id]);

  const pending = flow.pending.includes(order.id);
  const error = flow.errors[order.id]?.error ?? null;

  async function submit() {
    const text = reason.trim();
    if (text === '' || pending) return;
    const outcome = await moveStore.startUnpaid(order, text);
    if (outcome.ok) onClose();
  }

  return (
    <PayModal labelledBy="start-unpaid-title" onClose={onClose}>
      <SheetBody>
        <SheetTitle id="start-unpaid-title">
          {tr('order.startUnpaid.title', { orderNo: order.orderNo })}
        </SheetTitle>
        <Callout tone="info">{tr('order.startUnpaid.explain')}</Callout>
        <TextRow
          id="start-unpaid-reason"
          label={tr('order.startUnpaid.reason')}
          placeholder={tr('order.startUnpaid.reasonPlaceholder')}
          value={reason}
          disabled={pending}
          onChange={setReason}
        />
        {error ? (
          <Callout tone="bad" role="alert">
            {errorText(tr, error)}
          </Callout>
        ) : null}
        <button
          type="button"
          className="g-btn g-btn-p g-btn-lg g-btn-block"
          disabled={pending || reason.trim() === ''}
          aria-busy={pending}
          onClick={() => void submit()}
        >
          {tr('order.startUnpaid.confirm')}
        </button>
        <button type="button" className="g-btn g-btn-block" onClick={onClose}>
          {tr('order.startUnpaid.back')}
        </button>
      </SheetBody>
    </PayModal>
  );
}

function CancelOrderDialog({ order, onClose }: { order: OrderDto; onClose: () => void }) {
  const { orderMoves: moveStore } = useServices();
  const flow = useStoreState(moveStore);
  const tr = useT();
  const [reason, setReason] = useState('');
  // A reason being typed must not be lost to a page reload.
  useActivityHold(true);
  // An error from an earlier move is not this dialog's.
  useEffect(() => moveStore.dismiss(order.id), [moveStore, order.id]);

  const pending = flow.pending.includes(order.id);
  const error = flow.errors[order.id]?.error ?? null;

  async function submit() {
    const text = reason.trim();
    if (text === '' || pending) return;
    const outcome = await moveStore.cancel(order, text);
    if (outcome.ok) onClose();
  }

  const blockedByPayment = error?.code === 'ORDER_HAS_PAYMENT';

  return (
    <PayModal labelledBy="cancel-order-title" onClose={onClose}>
      <SheetBody>
        <SheetTitle id="cancel-order-title">
          {tr('order.cancel.title', { orderNo: order.orderNo })}
        </SheetTitle>
        <TextRow
          id="cancel-reason"
          label={tr('order.cancel.reason')}
          placeholder={tr('order.cancel.reasonPlaceholder')}
          value={reason}
          disabled={pending}
          onChange={setReason}
        />
        {error ? (
          <Callout tone="bad" role="alert">
            {blockedByPayment ? tr('order.cancel.hasPayment') : errorText(tr, error)}
          </Callout>
        ) : null}
        <button
          type="button"
          className="g-btn g-btn-p g-btn-lg g-btn-block"
          disabled={pending || reason.trim() === ''}
          aria-busy={pending}
          onClick={() => void submit()}
        >
          {tr('order.cancel.confirm')}
        </button>
        <button type="button" className="g-btn g-btn-block" onClick={onClose}>
          {tr('order.cancel.keep')}
        </button>
      </SheetBody>
    </PayModal>
  );
}
