import { formatBaht } from '@sds/i18n';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useLocale, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { OtherEntries } from './OtherEntries.tsx';
import type { QueuedOrder, QueuedPayment } from './outbox-model.ts';
import { QueueActions, QueueStateBadge } from './QueueActions.tsx';

/** The glass card of a waiting entry (the design's order card): the same shape as an order of the board. */
const CARD = 'display:flex;flex-direction:column;gap:8px;border-radius:22px;padding:14px 16px';
const LINK = 'display:flex;flex-direction:column;gap:8px;text-decoration:none;color:inherit';

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
    <li
      className="g-glass"
      style={s(`${CARD};${item.state === 'attention' ? 'border-color:rgba(198,40,40,.45);' : ''}`)}
    >
      <a href={`#/orders/${item.id}`} style={s(LINK)}>
        <span style={s('display:flex;align-items:center;gap:10px')}>
          <span className="g-badge g-b-mute">
            <Gi n="store" />
            {tr(`orders.channel.${item.channel}`)}
          </span>
          <span className="g-t-2 g-num" style={s('flex-grow:1')}>
            {item.label}
          </span>
          <span className="g-num g-t-3">
            {item.estimateSatang === null ? '' : formatBaht(item.estimateSatang, locale)}
          </span>
        </span>
        {item.recipient ? (
          <span className="g-t-b">{`${item.recipient.building} · ${item.recipient.name}`}</span>
        ) : item.note ? (
          <span className="g-t-b">{item.note}</span>
        ) : null}
        <span className="g-t-s">
          {tr('pos.orderEntry.itemsCount', { count })}
          {item.estimateSatang === null ? '' : ` · ${tr('pos.orderEntry.estimate')}`}
        </span>
        <span style={s('display:flex;align-items:center;gap:8px;flex-wrap:wrap')}>
          <QueueStateBadge item={item} />
          {payment ? (
            <span className="g-badge g-b-info">
              <Gi n={payment.method === 'cash' ? 'cash' : 'qrBig'} />
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
    <li
      className="g-glass"
      style={s(`${CARD};${item.state === 'attention' ? 'border-color:rgba(198,40,40,.45);' : ''}`)}
    >
      <a href={item.orderId ? `#/orders/${item.orderId}` : '#/orders'} style={s(LINK)}>
        <span style={s('display:flex;align-items:center;gap:10px')}>
          <span className="g-badge g-b-info">
            <Gi n={item.method === 'cash' ? 'cash' : 'qrBig'} />
            {tr(`payment.method.${item.method}`)}
          </span>
          <span className="g-t-2 g-num" style={s('flex-grow:1')}>
            {item.label}
          </span>
          <span className="g-num g-t-3">
            {formatBaht(item.method === 'cash' ? item.tenderedSatang : item.qrAmountSatang, locale)}
          </span>
        </span>
        <span style={s('display:flex;align-items:center;gap:8px;flex-wrap:wrap')}>
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
    <div
      className="g-sunk"
      role="status"
      style={s('display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px')}
    >
      <Gi n="warn" />
      <span style={s('flex:1 1 220px')}>{tr('outbox.stepUp.waiting')}</span>
      <button type="button" className="g-btn" onClick={() => void outbox.confirmOwner()}>
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
    <section
      className="g-sunk"
      aria-labelledby="queued-title"
      style={s('display:flex;flex-direction:column;gap:12px;padding:14px 16px;flex:none')}
    >
      {state.items.length > 0 ? (
        <>
          <h2
            id="queued-title"
            className="g-t-3"
            style={s('margin:0;display:flex;align-items:center;gap:8px')}
          >
            {tr('outbox.section.title')}
            <span className="g-badge g-b-warn">{state.items.length}</span>
          </h2>
          <p className="g-t-s" style={s('margin:0')}>
            {tr('outbox.section.hint')}
          </p>
          {state.stepUpNeeded ? <OwnerStepUpNotice /> : null}
          <ul
            style={s(
              'list-style:none;margin:0;padding:0;display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))',
            )}
          >
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
        <p
          className="g-t-s"
          role="status"
          style={s('margin:0;display:flex;gap:8px;align-items:flex-start')}
        >
          <Gi n="info" size="sm" />
          <span>{tr('outbox.purged', { count: state.purgedCount })}</span>
        </p>
      ) : null}
      <OtherEntries />
    </section>
  );
}
