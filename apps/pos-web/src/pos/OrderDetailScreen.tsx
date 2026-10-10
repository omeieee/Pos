import { formatBaht, formatDate } from '@sds/i18n';
import { orderIdParamSchema } from '@sds/shared';
import { useEffect, useState } from 'react';
import { errorText, isApiClientError } from '../api/errors.ts';
import { Gi } from '../design/icons.tsx';
import { useLayout } from '../design/layout.ts';
import { s } from '../design/style.ts';
import {
  useAuthState,
  useEntities,
  useLocale,
  useServices,
  useStoreState,
  useT,
} from '../ui/hooks.ts';
import { deliveryLabel } from './delivery-model.ts';
import { dishArt } from './dish-art.ts';
import { LocalOrderScreen } from './LocalOrderScreen.tsx';
import { MemberLine } from './MemberLine.tsx';
import { localName } from './names.ts';
import { OrderCorrectionActions } from './OrderCorrection.tsx';
import { OrderMoves } from './OrderMoves.tsx';
import { OrderSummary, type SummaryLine } from './OrderSummary.tsx';
import { PaymentPanel } from './PaymentPanel.tsx';
import { PageNote, PayPage } from './PayParts.tsx';
import { OrderStatusBadge, PaymentStatusBadge } from './StatusBadge.tsx';

type Load = { state: 'idle' | 'loading' | 'notFound' } | { state: 'error'; error: unknown };

/**
 * The order page. For now it shows the order and its payment status from the entity store; the
 * payment screens come in the next slice. The total is the SERVER's (it is the order the server
 * returned). An order that is not in the store (a reload, a link) is fetched once and put into it.
 */
export function OrderDetailScreen({ id }: { id: string }) {
  const { api, entities: store, outbox } = useServices();
  const queue = useStoreState(outbox);
  // The page of an order that is only on this device (until the server numbers it), and where it went.
  const waiting = queue.items.find((item) => item.kind === 'order' && item.id === id);
  const syncedTo = queue.synced[id];
  const auth = useAuthState();
  const entities = useEntities();
  const order = entities.orders.get(id);
  const tr = useT();
  const locale = useLocale();
  const phone = useLayout() === 'phone';
  const valid = orderIdParamSchema.safeParse({ id }).success;
  const [load, setLoad] = useState<Load>({ state: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const missing = valid && !order && !waiting && !syncedTo;

  // `attempt` re-runs the load when the person taps "try again".
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!missing) return;
    let live = true;
    setLoad({ state: 'loading' });
    api.orders.get(id).then(
      (loaded) => {
        if (!live) return;
        store.apply({ type: 'order.upserted', id: loaded.id, rev: loaded.rev, data: loaded });
        setLoad({ state: 'idle' });
      },
      (error: unknown) => {
        if (!live) return;
        setLoad(
          isApiClientError(error) && error.code === 'NOT_FOUND'
            ? { state: 'notFound' }
            : { state: 'error', error },
        );
      },
    );
    return () => {
      live = false;
    };
  }, [missing, id, api, store, attempt]);

  // The order reached the server while this page was open: move to the real order.
  useEffect(() => {
    if (syncedTo) window.location.replace(`#/orders/${syncedTo}`);
  }, [syncedTo]);

  if (waiting?.kind === 'order') return <LocalOrderScreen item={waiting} />;
  if (syncedTo) {
    return (
      <PageNote>
        <p className="g-t-s" role="status" style={s('margin:0')}>
          {tr('order.detail.loading')}
        </p>
      </PageNote>
    );
  }

  const another = (
    <a className="g-btn g-btn-p" href="#/new">
      <Gi n="plus" />
      {tr('order.detail.takeAnother')}
    </a>
  );

  if (!valid || load.state === 'notFound') {
    return (
      <PageNote>
        <p className="g-t-3" style={s('margin:0')}>
          {tr('order.detail.notFound')}
        </p>
        {another}
      </PageNote>
    );
  }
  if (!order) {
    if (load.state === 'error') {
      return (
        <PageNote>
          <p className="g-t-3" role="alert" style={s('margin:0;color:var(--chili-ink)')}>
            {errorText(tr, load.error)}
          </p>
          <button type="button" className="g-btn" onClick={() => setAttempt((n) => n + 1)}>
            {tr('common.retry')}
          </button>
        </PageNote>
      );
    }
    return (
      <PageNote>
        <p className="g-t-s" role="status" style={s('margin:0')}>
          {tr('order.detail.loading')}
        </p>
      </PageNote>
    );
  }

  const role = auth.session?.staff.role;
  const to = deliveryLabel(order);
  const lines: SummaryLine[] = order.items.map((item) => {
    const menuItem = entities.items.get(item.menuItemId);
    return {
      key: item.id,
      name: localName(locale, item.nameTh, item.nameEn),
      options: item.modifiers.map((m) => localName(locale, m.nameTh, m.nameEn)).join(' · '),
      qty: item.qty,
      note: item.note,
      amount: formatBaht(item.lineTotalSatang, locale),
      art: dishArt(item.nameTh, item.nameEn),
      imageUrl: menuItem?.imageUrl ?? null,
    };
  });
  const actions = (
    <>
      {role ? <OrderMoves order={order} role={role} /> : null}
      <OrderCorrectionActions order={order} />
      <a className="g-btn" href="#/new">
        <Gi n="plus" />
        {tr('order.detail.takeAnother')}
      </a>
    </>
  );
  const count = order.items.reduce((sum, item) => sum + item.qty, 0);

  return (
    <PayPage labelledBy="order-title">
      <OrderSummary
        title={tr('order.detail.title', { orderNo: order.orderNo })}
        subtitle={
          <>
            {tr(`pos.orderEntry.fulfilment.${order.fulfillment}`)}
            {order.roomNo ? ` · ${tr('order.detail.room', { room: order.roomNo })}` : ''}
            {` · ${formatDate(order.placedAt, locale, 'dateTime')}`}
          </>
        }
        badges={
          <>
            <OrderStatusBadge status={order.status} />
            <PaymentStatusBadge status={order.paymentStatus} />
          </>
        }
        recipient={to ? { headline: to.headline, note: to.note } : null}
        member={<MemberLine member={order.member} />}
        cancelReason={
          order.status === 'cancelled' && order.cancelReason
            ? tr('order.cancel.reasonShown', { reason: order.cancelReason })
            : null
        }
        lines={lines}
        orderNote={order.note}
        countText={tr('pos.orderEntry.itemsCount', { count })}
        totalLabel={tr('order.detail.serverTotal')}
        totalText={formatBaht(order.totalSatang, locale)}
        below={phone ? undefined : actions}
      />
      <PaymentPanel orderId={order.id} />
      {phone ? (
        <div style={s('display:flex;flex-direction:column;gap:12px;padding-bottom:8px')}>
          {actions}
        </div>
      ) : null}
    </PayPage>
  );
}
