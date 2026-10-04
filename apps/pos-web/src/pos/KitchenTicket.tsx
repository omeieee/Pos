import type { OrderDto, StaffRole } from '@sds/shared';
import { errorText } from '../api/errors.ts';
import { clockTime } from '../design/format.ts';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useLocale, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { deliveryLabel } from './delivery-model.ts';
import { elapsedText } from './elapsed-text.ts';
import {
  isFresh,
  kitchenMoves,
  timerText,
  waitLevel,
  waitMinutes,
  waitProgress,
  waitSeconds,
} from './kitchen-model.ts';
import { localName } from './names.ts';

/** The words for the payment, as plain information (never an action) on a ticket. */
function payText(tr: ReturnType<typeof useT>, order: OrderDto): string {
  return order.paymentStatus === 'awaiting_confirmation'
    ? tr('kitchen.pay.awaiting')
    : tr(`status.payment.${order.paymentStatus}`);
}

/**
 * How long the ticket has waited, as the design's timer badge: a clock and "mm:ss" while it is
 * fine, and a red badge with a warning icon and the words "overdue" / "very late" once it is long
 * (colour is never the only sign). A screen reader hears the minutes in words instead.
 */
function Timer({ order, now }: { order: OrderDto; now: number }) {
  const tr = useT();
  const seconds = waitSeconds(order, now);
  const level = waitLevel(waitMinutes(order, now));
  const tone =
    level === 'ok' ? (order.status === 'preparing' ? 'g-b-info' : 'g-b-mute') : 'g-b-bad';
  return (
    <span className={`g-badge ${tone} g-num`} data-level={level}>
      <Gi n={level === 'ok' ? 'clock' : 'warn'} />
      <span aria-hidden="true">
        {timerText(seconds)}
        {level === 'ok' ? '' : ` · ${tr(`kitchen.level.${level}`)}`}
      </span>
      <span className="visually-hidden">
        {tr(order.status === 'ready' ? 'kitchen.readyWait' : 'kitchen.waited', {
          time: elapsedText(tr, Math.floor(seconds / 60)),
        })}
        {level === 'ok' ? '' : ` · ${tr(`kitchen.level.${level}`)}`}
      </span>
    </span>
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
          className={`g-btn g-btn-lg g-btn-block ${move.to === 'ready' ? 'g-btn-ok' : 'g-btn-p'}`}
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
 * One order to make, as a big-type ticket (design "Kitchen board"): the number and how it is served,
 * the timer, where it goes, every dish with its quantity in a box, its choices and note, the order's
 * note, the payment as plain words, and the moves. No price, no total, no payment action: this view
 * never reads them.
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
  const minutes = waitMinutes(order, now);
  const level = waitLevel(minutes);
  const to = deliveryLabel(order);
  const delivery =
    order.fulfillment === 'room_delivery' || order.fulfillment === 'entrance_delivery';
  const ready = order.status === 'ready';
  const started =
    order.status === 'preparing' && order.acceptedAt
      ? tr('kitchen.startedAt', { time: clockTime(Date.parse(order.acceptedAt)) })
      : null;
  const info = [
    tr(`orders.channel.${order.channel}`),
    started,
    ready ? null : payText(tr, order),
  ].filter(Boolean);
  return (
    <li>
      <article
        className={`g-glass g-rise kb-ticket${isFresh(order, now) ? ' kb-new' : ''}${level === 'late' ? ' kb-late' : ''}`}
        data-level={level}
        aria-labelledby={`kt-${order.id}`}
        style={s(`--d:${delay}s`)}
      >
        <div style={s('display:flex;align-items:center;gap:10px')}>
          <h3 id={`kt-${order.id}`} className="g-t-1 g-num kb-no" style={s('flex-grow:1;margin:0')}>
            {order.orderNo}
          </h3>
          <span className={`g-badge ${delivery ? 'g-b-info' : 'g-b-mute'}`}>
            <Gi n={delivery ? 'building' : 'store'} />
            {tr(`pos.orderEntry.fulfilment.${order.fulfillment}`)}
          </span>
        </div>
        <div className="g-t-s" style={s('display:flex;align-items:center;gap:8px;flex-wrap:wrap')}>
          <Timer order={order} now={now} />
          {ready ? (
            <span className={`g-badge ${order.paymentStatus === 'paid' ? 'g-b-ok' : 'g-b-warn'}`}>
              <Gi n={order.paymentStatus === 'paid' ? 'check' : 'pending'} />
              {payText(tr, order)}
            </span>
          ) : null}
          <span>{info.join(' · ')}</span>
        </div>
        {to || order.roomNo ? (
          <div style={s('display:flex;flex-direction:column;gap:2px')}>
            <div className="kb-where">
              {to ? <span>{to.headline}</span> : null}
              {order.roomNo ? <span>{tr('order.detail.room', { room: order.roomNo })}</span> : null}
            </div>
            {to?.note ? <div className="kb-opt">{to.note}</div> : null}
          </div>
        ) : null}
        <ul
          style={s(
            'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px',
          )}
        >
          {order.items.map((item) => (
            <li key={item.id} style={s('display:flex;gap:12px;align-items:flex-start')}>
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
        {order.status === 'preparing' ? (
          <div className="kb-bar" aria-hidden="true">
            <div style={{ width: `${Math.round(waitProgress(waitSeconds(order, now)) * 100)}%` }} />
          </div>
        ) : null}
        {order.note ? (
          <div className="kb-note">
            <Gi n="note" size="sm" />
            <span>{order.note}</span>
          </div>
        ) : null}
        <Moves order={order} role={role} />
      </article>
    </li>
  );
}
