import type { OrderDto, StaffRole } from '@sds/shared';
import { useEffect, useState } from 'react';
import { errorText } from '../api/errors.ts';
import { useActivityHold, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Modal } from '../ui/Modal.tsx';
import { type OrderMove, orderMoves } from './order-board.ts';

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
  const moves = orderMoves(order.status, role);
  const [cancelling, setCancelling] = useState(false);
  if (moves.length === 0) return null;

  const pending = flow.pending.includes(order.id);
  // An error belongs to the status it was refused from; once the order has moved on it is stale.
  const failure = flow.errors[order.id];
  const shown = failure && failure.from === order.status && !cancelling ? failure.error : null;

  function choose(move: OrderMove) {
    if (move.kind === 'cancel') setCancelling(true);
    else void moveStore.transition(order, move.to);
  }

  return (
    <div className="omoves">
      <fieldset className="omoves__row">
        <legend className="visually-hidden">{tr('order.moves.label')}</legend>
        {moves.map((move) => (
          <button
            key={move.to}
            type="button"
            className={
              move.kind === 'cancel' ? 'btn btn-soft omoves__cancel' : 'btn btn-primary btn-lg'
            }
            disabled={pending}
            aria-busy={pending}
            onClick={() => choose(move)}
          >
            {tr(`order.move.${move.to}`)}
          </button>
        ))}
      </fieldset>
      {shown ? (
        <p className="error" role="alert">
          {errorText(tr, shown)}
        </p>
      ) : null}
      {cancelling ? <CancelOrderDialog order={order} onClose={() => setCancelling(false)} /> : null}
    </div>
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
    <Modal labelledBy="cancel-order-title" onClose={onClose}>
      <h2 id="cancel-order-title" className="sheet__title">
        {tr('order.cancel.title', { orderNo: order.orderNo })}
      </h2>
      <div className="field-group">
        <label className="label" htmlFor="cancel-reason">
          {tr('order.cancel.reason')}
        </label>
        <input
          id="cancel-reason"
          className="input"
          type="text"
          maxLength={200}
          autoComplete="off"
          placeholder={tr('order.cancel.reasonPlaceholder')}
          value={reason}
          disabled={pending}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {error ? (
        <p className="error" role="alert">
          {blockedByPayment ? tr('order.cancel.hasPayment') : errorText(tr, error)}
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn-primary btn-lg btn-block"
        disabled={pending || reason.trim() === ''}
        aria-busy={pending}
        onClick={() => void submit()}
      >
        {tr('order.cancel.confirm')}
      </button>
      <button type="button" className="btn btn-soft btn-block" onClick={onClose}>
        {tr('order.cancel.keep')}
      </button>
    </Modal>
  );
}
