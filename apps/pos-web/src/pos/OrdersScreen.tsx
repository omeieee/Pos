import { formatBaht, formatDate } from '@sds/i18n';
import { ORDER_NO_PREFIX, type OrderDto } from '@sds/shared';
import { useEffect, useState } from 'react';
import {
  type Tr,
  useEntities,
  useLocale,
  useNow,
  useServices,
  useStoreState,
  useT,
} from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import {
  type BoardFilter,
  boardColumns,
  currentBusinessDay,
  elapsedMinutes,
  elapsedParts,
  filterOrders,
  ordersForDay,
} from './order-board.ts';
import { OrderStatusBadge, PaymentStatusBadge } from './StatusBadge.tsx';

const FILTERS: readonly BoardFilter[] = ['open', 'all'];
const WAITING = ['new', 'preparing', 'ready'] as const;

function elapsedText(tr: Tr, minutes: number): string {
  const { hours, minutes: rest } = elapsedParts(minutes);
  return hours > 0
    ? tr('orders.elapsedHours', { hours, minutes: rest })
    : tr('duration.minutes', { count: rest });
}

function OrderCard({ order, now }: { order: OrderDto; now: number }) {
  const tr = useT();
  const locale = useLocale();
  const waiting = (WAITING as readonly string[]).includes(order.status);
  const attention = order.paymentStatus === 'awaiting_confirmation' && order.status !== 'cancelled';
  return (
    <li>
      <a className={`ocard${attention ? ' ocard--attention' : ''}`} href={`#/orders/${order.id}`}>
        <span className="ocard__top">
          <span className="ochannel" aria-hidden="true">
            {ORDER_NO_PREFIX[order.channel]}
          </span>
          <span className="visually-hidden">{tr(`orders.channel.${order.channel}`)}</span>
          <span className="ocard__no">{order.orderNo}</span>
          <span className="ocard__total money">{formatBaht(order.totalSatang, locale)}</span>
        </span>
        <span className="ocard__meta muted small">
          {tr(`pos.orderEntry.fulfilment.${order.fulfillment}`)}
          {order.roomNo ? ` · ${tr('order.detail.room', { room: order.roomNo })}` : ''}
          {` · ${tr('pos.orderEntry.itemsCount', { count: order.items.reduce((n, i) => n + i.qty, 0) })}`}
        </span>
        <span className="ocard__badges">
          {order.status === 'cancelled' ? null : (
            <PaymentStatusBadge status={order.paymentStatus} />
          )}
        </span>
        <span className="ocard__time small">
          <Icon name="clock" />
          {waiting
            ? tr('orders.elapsed', {
                time: elapsedText(tr, elapsedMinutes(order.placedAt, now)),
              })
            : formatDate(order.placedAt, locale, 'time')}
        </span>
      </a>
    </li>
  );
}

/**
 * Today's orders as a board: a column per status, oldest first, each card showing the channel
 * letter and number, the server's total, the payment status and how long it has waited. The orders
 * come from the entity store (realtime keeps them live); opening the page also fetches today's list
 * once, so a fresh device sees them without waiting for the first sync. A tap opens the order page,
 * where the moves and the payment are.
 */
export function OrdersScreen() {
  const { api, entities: store, cart } = useServices();
  const state = useEntities();
  const cartState = useStoreState(cart);
  const tr = useT();
  const now = useNow(30_000);
  const [filter, setFilter] = useState<BoardFilter>('open');
  const [load, setLoad] = useState<'loading' | 'ok' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);

  // `attempt` re-runs the load when the person taps "try again".
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let live = true;
    setLoad('loading');
    api.orders.list().then(
      (listed) => {
        if (!live) return;
        store.applyMany(
          listed.orders.map((order) => ({
            type: 'order.upserted' as const,
            id: order.id,
            rev: order.rev,
            data: order,
          })),
        );
        setLoad('ok');
      },
      () => {
        if (live) setLoad('error');
      },
    );
    return () => {
      live = false;
    };
  }, [api, store, attempt]);

  const day = currentBusinessDay(state.settings, now);
  const todays = ordersForDay(state.orders.values(), day);
  const shown = filterOrders(todays, filter);
  const columns = boardColumns(shown, filter);

  return (
    <section className="board" aria-labelledby="orders-title">
      <header className="board__head">
        <h1 id="orders-title" className="board__title">
          {tr('orders.title')}
        </h1>
        <fieldset className="seg board__filter">
          <legend className="visually-hidden">{tr('orders.filter.label')}</legend>
          {FILTERS.map((value) => (
            <label key={value} className={`seg__item${filter === value ? ' seg__item--on' : ''}`}>
              <input
                className="visually-hidden"
                type="radio"
                name="orders-filter"
                checked={filter === value}
                onChange={() => setFilter(value)}
              />
              {tr(`orders.filter.${value}`)}
            </label>
          ))}
        </fieldset>
      </header>

      {cartState.phase === 'unsure' ? (
        <div className="notice board__notice" role="status">
          <Icon name="alert" />
          <span>{tr('orders.unsureCart')}</span>
          <a className="btn btn-soft" href="#/new">
            {tr('orders.unsureCartBack')}
          </a>
        </div>
      ) : null}

      {load === 'error' ? (
        <div className="error board__notice" role="alert">
          <span>{tr('orders.loadFailed')}</span>
          <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
            {tr('common.retry')}
          </button>
        </div>
      ) : null}

      {shown.length === 0 ? (
        <p className="muted board__empty" role={load === 'loading' ? 'status' : undefined}>
          {load === 'loading'
            ? tr('orders.loading')
            : tr(filter === 'open' ? 'orders.emptyOpen' : 'orders.empty')}
        </p>
      ) : (
        <div className="board__cols">
          {columns.map((column) => (
            <section
              key={column.status}
              className="board__col"
              aria-labelledby={`col-${column.status}`}
            >
              <h2 id={`col-${column.status}`} className="board__col-title">
                <OrderStatusBadge status={column.status} />
                <span className="board__count">{column.orders.length}</span>
              </h2>
              {column.orders.length === 0 ? (
                <p className="muted small">{tr('orders.columnEmpty')}</p>
              ) : (
                <ul className="board__list">
                  {column.orders.map((order) => (
                    <OrderCard key={order.id} order={order} now={now} />
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
