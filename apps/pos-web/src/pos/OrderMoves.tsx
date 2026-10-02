import type { OrderDto, StaffRole } from '@sds/shared';
import { useRef, useState } from 'react';
import { errorText } from '../api/errors.ts';
import { useActivityHold, useServices, useT } from '../ui/hooks.ts';
import { Modal } from '../ui/Modal.tsx';
import { type MoveTarget, type OrderMove, orderMoves } from './order-board.ts';

function frameOf(order: OrderDto) {
  return { type: 'order.upserted' as const, id: order.id, rev: order.rev, data: order };
}

/**
 * The status moves this role may make on the order (read from the shared order machine). A move
 * is one tap; a cancel asks for a reason first. The order on screen changes only when the server
 * has answered (the order it returns goes into the store), never from the tap.
 */
export function OrderMoves({ order, role }: { order: OrderDto; role: StaffRole }) {
  const { api, entities } = useServices();
  const tr = useT();
  const moves = orderMoves(order.status, role);
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  if (moves.length === 0) return null;

  async function advance(to: MoveTarget) {
    // Set in the same tick: two taps before React re-renders send one request.
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      entities.apply(frameOf(await api.orders.transition(order.id, { to })));
    } catch (caught) {
      setError(caught);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function choose(move: OrderMove) {
    if (move.kind === 'cancel') setCancelling(true);
    else void advance(move.to);
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
            onClick={() => choose(move)}
          >
            {tr(`order.move.${move.to}`)}
          </button>
        ))}
      </fieldset>
      {error ? (
        <p className="error" role="alert">
          {errorText(tr, error)}
        </p>
      ) : null}
      {cancelling ? <CancelOrderDialog order={order} onClose={() => setCancelling(false)} /> : null}
    </div>
  );
}

function CancelOrderDialog({ order, onClose }: { order: OrderDto; onClose: () => void }) {
  const { api, entities } = useServices();
  const tr = useT();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  // A reason being typed must not be lost to a page reload.
  useActivityHold(true);

  async function submit() {
    const text = reason.trim();
    if (text === '' || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      entities.apply(frameOf(await api.orders.cancel(order.id, { reason: text })));
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const blockedByPayment =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ORDER_HAS_PAYMENT';

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
