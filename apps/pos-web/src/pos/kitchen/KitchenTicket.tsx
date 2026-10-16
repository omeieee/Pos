import type { OrderDto, StaffRole } from '@sds/shared';
import { useState } from 'react';
import { errorText } from '../../api/errors.ts';
import { clockTime } from '../../design/format.ts';
import { Gi } from '../../design/icons.tsx';
import { s } from '../../design/style.ts';
import { useLocale, useServices, useStoreState, useT } from '../../ui/hooks.ts';
import { deliveryLabel } from '../cart/delivery-model.ts';
import { MemberLine } from '../cart/MemberLine.tsx';
import { localName } from '../cart/names.ts';
import { elapsedText } from '../orders/elapsed-text.ts';
import { isFresh, isStale, kitchenMoves, waitLevel, waitMinutes } from './kitchen-model.ts';

/** The words for the payment, as plain information (never an action) on a ticket. */
function payText(tr: ReturnType<typeof useT>, order: OrderDto): string {
  return order.paymentStatus === 'awaiting_confirmation'
    ? tr('kitchen.pay.awaiting')
    : tr(`status.payment.${order.paymentStatus}`);
}

/**
 * How long the ticket has waited, as plain minutes ("12 นาที") in big type. It is calm while the
 * wait is fine, amber after the warning minutes and red only once the order is genuinely late
 * (with a warning icon, so colour is never the only sign). A stale order shows no minutes at all,
 * only that it was left from an earlier day. A screen reader hears the wait in words.
 */
function Wait({ order, now }: { order: OrderDto; now: number }) {
  const tr = useT();
  const minutes = waitMinutes(order, now);
  const level = waitLevel(minutes);
  if (isStale(order, now)) {
    return (
      <span className="kb-wait kb-wait-stale" data-level="stale">
        {tr('kitchen.stale')}
      </span>
    );
  }
  return (
    <span className="kb-wait g-num" data-level={level}>
      {level === 'ok' ? null : <Gi n="warn" />}
      <span aria-hidden="true">{tr('duration.minutes', { count: minutes })}</span>
      <span className="visually-hidden">
        {tr(order.status === 'ready' ? 'kitchen.readyWait' : 'kitchen.waited', {
          time: elapsedText(tr, minutes),
        })}
        {level === 'ok' ? '' : ` · ${tr(`kitchen.level.${level}`)}`}
      </span>
    </span>
  );
}

/** The LINE name next to a small round picture (when LINE gave one and it loads). */
function LineWho({ line }: { line: NonNullable<OrderDto['line']> }) {
  const tr = useT();
  const [broken, setBroken] = useState(false);
  if (!line.displayName && !line.pictureUrl) return null;
  return (
    <div className="kb-line" data-testid="line-name">
      {line.pictureUrl && !broken ? (
        <img
          className="kb-pic"
          src={line.pictureUrl}
          alt=""
          width={36}
          height={36}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : (
        <Gi n="user" />
      )}
      <span className="visually-hidden">{tr('kitchen.lineName')}: </span>
      {line.displayName ? <span>{line.displayName}</span> : null}
    </div>
  );
}

/**
 * The one-tap moves of the kitchen view: start preparing, mark done. The buttons are the moves the
 * shared order machine allows this role (`kitchenMoves`), so a role never sees one the server would
 * refuse; the server still checks. The card changes when the answer comes (the store), not on the
 * tap. A refusal is shown on this card, for as long as the order is still where it was.
 */
function Moves({ order, role }: { order: OrderDto; role: StaffRole }) {
  const { orderMoves } = useServices();
  const flow = useStoreState(orderMoves);
  const tr = useT();
  const moves = kitchenMoves(order.status, role);
  if (moves.length === 0) return null;
  const pending = flow.pending.includes(order.id);
  const failure = flow.errors[order.id];
  const shown = failure && failure.from === order.status ? failure.error : null;
  return (
    <>
      {moves.map((move) => (
        <button
          key={move.to}
          type="button"
          className={`g-btn g-btn-lg g-btn-block kb-go ${move.to === 'ready' ? 'kb-go-done' : 'kb-go-start'}`}
          disabled={pending}
          aria-busy={pending}
          onClick={() => void orderMoves.transition(order, move.to)}
        >
          {move.to === 'ready' ? <Gi n="check" /> : null}
          {move.to === 'ready' ? tr('kitchen.move.ready') : tr(`order.move.${move.to}`)}
        </button>
      ))}
      {shown ? (
        <p
          role="alert"
          className="g-badge g-b-bad"
          style={s('height:auto;min-height:28px;padding:6px 12px;white-space:normal;margin:0')}
        >
          {errorText(tr, shown)}
        </p>
      ) : null}
    </>
  );
}

/**
 * One order to make, as a ticket that reads in two seconds from across the kitchen: the order
 * number and the wait in huge type, where it goes, every dish with its quantity very large, its
 * choices and notes smaller but legible, the order's note, one quiet line for the channel and the
 * payment (words, never an action), and the one big move. The column gives the card its one state
 * colour (an edge in blue, amber or green); red is kept for an order that is genuinely late. No
 * price, no total: this view never reads them.
 */
export function KitchenTicket({
  order,
  role,
  now,
  delay,
}: {
  order: OrderDto;
  role: StaffRole;
  now: number;
  delay: number;
}) {
  const tr = useT();
  const locale = useLocale();
  const stale = isStale(order, now);
  const level = stale ? 'ok' : waitLevel(waitMinutes(order, now));
  const to = deliveryLabel(order);
  const delivery =
    order.fulfillment === 'room_delivery' || order.fulfillment === 'entrance_delivery';
  const started =
    order.status === 'preparing' && order.acceptedAt
      ? tr('kitchen.startedAt', { time: clockTime(Date.parse(order.acceptedAt)) })
      : null;
  const paid = order.paymentStatus === 'paid';
  const state =
    order.status === 'preparing' ? 'cooking' : order.status === 'ready' ? 'ready' : 'new';
  return (
    <li>
      <article
        className={`g-glass g-rise kb-ticket kb-st-${state}${isFresh(order, now) ? ' kb-new' : ''}${level === 'late' ? ' kb-late' : ''}${stale ? ' kb-stale' : ''}`}
        data-level={level}
        aria-labelledby={`kt-${order.id}`}
        style={s(`--d:${delay}s`)}
      >
        <div className="kb-top">
          <h3 id={`kt-${order.id}`} className="g-num kb-no">
            {order.orderNo}
          </h3>
          <Wait order={order} now={now} />
        </div>
        <div className="kb-where">
          <Gi n={delivery ? 'building' : 'store'} />
          <span>
            {to || order.roomNo ? (
              <>
                {to ? <span>{to.headline}</span> : null}
                {order.roomNo ? (
                  <span> {tr('order.detail.room', { room: order.roomNo })}</span>
                ) : null}
              </>
            ) : (
              tr(`pos.orderEntry.fulfilment.${order.fulfillment}`)
            )}
          </span>
        </div>
        {to?.note ? <div className="kb-opt">{to.note}</div> : null}
        {order.line ? <LineWho line={order.line} /> : null}
        <MemberLine member={order.member} />
        <ul className="kb-items">
          {order.items.map((item) => (
            <li key={item.id} className="kb-item">
              <div className="kb-q g-num">
                {item.qty}
                <span className="visually-hidden">×</span>
              </div>
              <div style={s('min-width:0')}>
                <div className="kb-nm">{localName(locale, item.nameTh, item.nameEn)}</div>
                {item.modifiers.length > 0 ? (
                  <div className="kb-opt">
                    {item.modifiers.map((m) => localName(locale, m.nameTh, m.nameEn)).join(' · ')}
                  </div>
                ) : null}
                {item.note ? <div className="kb-opt kb-item-note">{item.note}</div> : null}
              </div>
            </li>
          ))}
        </ul>
        {order.note ? (
          <div className="kb-note">
            <Gi n="note" size="sm" />
            <span>{order.note}</span>
          </div>
        ) : null}
        <div className="kb-meta">
          <span>{tr(`orders.channel.${order.channel}`)}</span>
          <span className={`kb-pay${paid ? ' kb-paid' : ''}`}>
            <Gi n={paid ? 'check' : 'pending'} size="sm" />
            {payText(tr, order)}
          </span>
          {started ? <span>{started}</span> : null}
          {to || order.roomNo ? (
            <span className="visually-hidden">
              {tr(`pos.orderEntry.fulfilment.${order.fulfillment}`)}
            </span>
          ) : null}
        </div>
        <Moves order={order} role={role} />
      </article>
    </li>
  );
}
