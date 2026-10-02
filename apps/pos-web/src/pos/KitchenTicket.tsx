import { ORDER_NO_PREFIX, type OrderDto, type StaffRole } from '@sds/shared';
import { errorText } from '../api/errors.ts';
import { useLocale, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { deliveryLabel } from './delivery-model.ts';
import { elapsedText } from './elapsed-text.ts';
import { kitchenMoves, waitLevel, waitMinutes } from './kitchen-model.ts';
import { localName } from './names.ts';
import { OrderStatusBadge, PaymentStatusBadge } from './StatusBadge.tsx';

/** The channel as a letter in a square, with the words for a screen reader. */
function Channel({ order }: { order: OrderDto }) {
  const tr = useT();
  return (
    <>
      <span className="ochannel kcard__channel" aria-hidden="true">
        {ORDER_NO_PREFIX[order.channel]}
      </span>
      <span className="visually-hidden">{tr(`orders.channel.${order.channel}`)}</span>
    </>
  );
}

/** How the order is served, and where it goes (the room of a delivery), in large type. */
function Serve({ order }: { order: OrderDto }) {
  const tr = useT();
  const to = deliveryLabel(order);
  return (
    <p className="kcard__serve">
      <span className="kcard__serve-how">
        {tr(`pos.orderEntry.fulfilment.${order.fulfillment}`)}
      </span>
      {to ? (
        <>
          <span className="kcard__serve-where">{to.headline}</span>
          {to.note ? <span className="kcard__serve-note">{to.note}</span> : null}
        </>
      ) : null}
      {order.roomNo ? (
        <span className="kcard__serve-where">
          {tr('order.detail.room', { room: order.roomNo })}
        </span>
      ) : null}
    </p>
  );
}

/**
 * The one-tap moves of the kitchen view: start preparing, mark ready. The buttons are the moves the
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
    <div className="kcard__moves">
      {moves.map((move) => (
        <button
          key={move.to}
          type="button"
          className="btn btn-primary btn-lg btn-block kcard__move"
          disabled={pending}
          aria-busy={pending}
          onClick={() => void orderMoves.transition(order, move.to)}
        >
          {tr(`order.move.${move.to}`)}
        </button>
      ))}
      {shown ? (
        <p className="error" role="alert">
          {errorText(tr, shown)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One order to make, as a big-type ticket for a wall-mounted phone: channel letter and number, how
 * long it has waited (colour AND words once it is long), how it is served, every dish with its
 * quantity, choices and note, the order's note, the payment as plain information, and the moves.
 * No price, no total, no payment action: this view never reads them.
 */
export function KitchenTicket({
  order,
  role,
  now,
}: {
  order: OrderDto;
  role: StaffRole;
  now: number;
}) {
  const tr = useT();
  const locale = useLocale();
  const minutes = waitMinutes(order, now);
  const level = waitLevel(minutes);
  return (
    <li>
      <article className={`kcard kcard--${level}`} aria-labelledby={`kt-${order.id}`}>
        <header className="kcard__head">
          <Channel order={order} />
          <h3 id={`kt-${order.id}`} className="kcard__no">
            {order.orderNo}
          </h3>
          <span className={`kcard__wait kcard__wait--${level}`}>
            <Icon name="clock" />
            <span>{elapsedText(tr, minutes)}</span>
            {level === 'ok' ? null : (
              <span className="kcard__level">{tr(`kitchen.level.${level}`)}</span>
            )}
          </span>
        </header>
        <Serve order={order} />
        <ul className="kcard__lines">
          {order.items.map((item) => (
            <li key={item.id} className="kline">
              <span className="kline__qty">{tr('order.detail.qty', { count: item.qty })}</span>
              <span className="kline__what">
                <span className="kline__name">{localName(locale, item.nameTh, item.nameEn)}</span>
                {item.modifiers.length > 0 ? (
                  <span className="kline__mods">
                    {item.modifiers.map((m) => localName(locale, m.nameTh, m.nameEn)).join(' · ')}
                  </span>
                ) : null}
                {item.note ? <span className="kline__note">{item.note}</span> : null}
              </span>
            </li>
          ))}
        </ul>
        {order.note ? (
          <p className="kcard__note">
            <Icon name="note" />
            <span>{order.note}</span>
          </p>
        ) : null}
        <div className="kcard__badges">
          <OrderStatusBadge status={order.status} />
          <PaymentStatusBadge status={order.paymentStatus} />
        </div>
        <Moves order={order} role={role} />
      </article>
    </li>
  );
}

/** A compact row for an order that is ready and waiting to be handed over: information only. */
export function ReadyRow({ order, now }: { order: OrderDto; now: number }) {
  const tr = useT();
  const to = deliveryLabel(order);
  return (
    <li className="kready__row">
      <Channel order={order} />
      <span className="kready__no">{order.orderNo}</span>
      <span className="kready__serve small">
        {tr(`pos.orderEntry.fulfilment.${order.fulfillment}`)}
        {to ? ` · ${to.headline}` : ''}
        {order.roomNo ? ` · ${tr('order.detail.room', { room: order.roomNo })}` : ''}
      </span>
      <span className="kready__wait small muted">
        {tr('kitchen.readyWait', { time: elapsedText(tr, waitMinutes(order, now)) })}
      </span>
      <PaymentStatusBadge status={order.paymentStatus} />
    </li>
  );
}
