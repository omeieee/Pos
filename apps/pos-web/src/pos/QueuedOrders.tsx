import { formatBaht } from '@sds/i18n';
import { ORDER_NO_PREFIX } from '@sds/shared';
import { useLocale, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { OtherEntries } from './OtherEntries.tsx';
import type { QueuedOrder, QueuedPayment } from './outbox-model.ts';
import { QueueActions, QueueStateBadge } from './QueueActions.tsx';

function OrderEntryCard({
  item,
  payment,
}: {
  item: QueuedOrder;
  /** The cash waiting for this order, if any. */
  payment: QueuedPayment | undefined;
}) {
  const tr = useT();
  const locale = useLocale();
  const count = item.lines.reduce((n, line) => n + line.qty, 0);
  return (
    <li className={`qcard${item.state === 'attention' ? ' qcard--attention' : ''}`}>
      <a className="qcard__link" href={`#/orders/${item.id}`}>
        <span className="ocard__top">
          <span className="ochannel" aria-hidden="true">
            {ORDER_NO_PREFIX[item.channel]}
          </span>
          <span className="visually-hidden">{tr(`orders.channel.${item.channel}`)}</span>
          <span className="ocard__no">{item.label}</span>
          <span className="ocard__total money">
            {item.estimateSatang === null ? '' : formatBaht(item.estimateSatang, locale)}
          </span>
        </span>
        {item.recipient ? (
          <span className="ocard__to">
            <span className="ocard__where">{`${item.recipient.building} · ${item.recipient.name}`}</span>
          </span>
        ) : item.note ? (
          <span className="ocard__to">
            <span className="ocard__where">{item.note}</span>
          </span>
        ) : null}
        <span className="ocard__meta muted small">
          {tr('pos.orderEntry.itemsCount', { count })}
          {item.estimateSatang === null ? '' : ` · ${tr('pos.orderEntry.estimate')}`}
        </span>
        <span className="ocard__badges">
          <QueueStateBadge item={item} />
          {payment ? (
            <span className="status status--info">
              <Icon name={payment.method === 'cash' ? 'cash' : 'qr'} />
              {tr(`payment.method.${payment.method}`)}
            </span>
          ) : null}
        </span>
      </a>
      <QueueActions item={item} />
      {payment && payment.state !== 'queued' ? <QueueActions item={payment} /> : null}
    </li>
  );
}

/** A cash or PromptPay payment waiting for an order the server already has. */
function PaymentCard({ item }: { item: QueuedPayment }) {
  const tr = useT();
  const locale = useLocale();
  return (
    <li className={`qcard${item.state === 'attention' ? ' qcard--attention' : ''}`}>
      <a className="qcard__link" href={item.orderId ? `#/orders/${item.orderId}` : '#/orders'}>
        <span className="ocard__top">
          <span className="ochannel" aria-hidden="true">
            <Icon name={item.method === 'cash' ? 'cash' : 'qr'} />
          </span>
          <span className="ocard__no">{item.label}</span>
          <span className="ocard__total money">
            {formatBaht(item.method === 'cash' ? item.tenderedSatang : item.qrAmountSatang, locale)}
          </span>
        </span>
        <span className="ocard__meta muted small">{tr(`payment.method.${item.method}`)}</span>
        <span className="ocard__badges">
          <QueueStateBadge item={item} />
        </span>
      </a>
      <QueueActions item={item} />
    </li>
  );
}

/** Entries the owner took over wait for the owner's step-up: said plainly, with a way to ask again. */
function OwnerStepUpNotice() {
  const tr = useT();
  const { outbox } = useServices();
  return (
    <div className="notice notice--ask" role="status">
      <Icon name="alert" />
      <span>{tr('outbox.stepUp.waiting')}</span>
      <button type="button" className="btn btn-soft" onClick={() => void outbox.confirmOwner()}>
        {tr('outbox.stepUp.ask')}
      </button>
    </div>
  );
}

/**
 * The orders, and the cash for orders, that are saved on this device and have not reached the
 * server: shown at once, with a "waiting to sync" badge and a temporary number. They are not in
 * the status columns below because the server has not given them a status yet. A payment that waits
 * behind its order shows inside that order's card.
 */
export function QueuedOrders() {
  const state = useStoreState(useServices().outbox);
  const tr = useT();
  const orders = state.items.filter((i): i is QueuedOrder => i.kind === 'order');
  const payments = state.items.filter((i): i is QueuedPayment => i.kind === 'payment');
  const own = (order: QueuedOrder) => payments.find((p) => p.dependsOn === order.id);
  const loose = payments.filter(
    (p) => p.dependsOn === null || !orders.some((o) => o.id === p.dependsOn),
  );
  if (
    state.items.length === 0 &&
    state.othersCount === 0 &&
    state.purgedCount === 0 &&
    state.recovered === null
  ) {
    return null;
  }
  return (
    <section className="queued" aria-labelledby="queued-title">
      {state.items.length > 0 ? (
        <>
          <h2 id="queued-title" className="queued__title">
            {tr('outbox.section.title')}
            <span className="board__count">{state.items.length}</span>
          </h2>
          <p className="hint">{tr('outbox.section.hint')}</p>
          {state.stepUpNeeded ? <OwnerStepUpNotice /> : null}
          <ul className="queued__list">
            {orders.map((order) => (
              <OrderEntryCard key={order.id} item={order} payment={own(order)} />
            ))}
            {loose.map((payment) => (
              <PaymentCard key={payment.id} item={payment} />
            ))}
          </ul>
        </>
      ) : null}
      {state.purgedCount > 0 ? (
        <p className="notice" role="status">
          <Icon name="info" />
          <span>{tr('outbox.purged', { count: state.purgedCount })}</span>
        </p>
      ) : null}
      <OtherEntries />
    </section>
  );
}
