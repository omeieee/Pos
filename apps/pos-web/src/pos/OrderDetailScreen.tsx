import { formatBaht, formatDate } from '@sds/i18n';
import { orderIdParamSchema } from '@sds/shared';
import { useEffect, useState } from 'react';
import { errorText, isApiClientError } from '../api/errors.ts';
import { useEntities, useLocale, useServices, useT } from '../ui/hooks.ts';
import { localName } from './names.ts';
import { OrderStatusBadge, PaymentStatusBadge } from './StatusBadge.tsx';

type Load = { state: 'idle' | 'loading' | 'notFound' } | { state: 'error'; error: unknown };

/**
 * The order page. For now it shows the order and its payment status from the entity store; the
 * payment screens come in the next slice. The total is the SERVER's (it is the order the server
 * returned). An order that is not in the store (a reload, a link) is fetched once and put into it.
 */
export function OrderDetailScreen({ id }: { id: string }) {
  const { api, entities: store } = useServices();
  const order = useEntities().orders.get(id);
  const tr = useT();
  const locale = useLocale();
  const valid = orderIdParamSchema.safeParse({ id }).success;
  const [load, setLoad] = useState<Load>({ state: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const missing = valid && !order;

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

  const another = (
    <a className="btn btn-primary" href="#/new">
      {tr('order.detail.takeAnother')}
    </a>
  );

  if (!valid || load.state === 'notFound') {
    return (
      <section className="odetail odetail--note">
        <p>{tr('order.detail.notFound')}</p>
        {another}
      </section>
    );
  }
  if (!order) {
    if (load.state === 'error') {
      return (
        <section className="odetail odetail--note">
          <p className="error" role="alert">
            {errorText(tr, load.error)}
          </p>
          <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
            {tr('common.retry')}
          </button>
        </section>
      );
    }
    return (
      <section className="odetail odetail--note">
        <p className="muted" role="status">
          {tr('order.detail.loading')}
        </p>
      </section>
    );
  }

  return (
    <section className="odetail" aria-labelledby="order-title">
      <header className="odetail__head">
        <h1 id="order-title" className="order-no">
          {tr('order.detail.title', { orderNo: order.orderNo })}
        </h1>
        <div className="odetail__badges">
          <OrderStatusBadge status={order.status} />
          <PaymentStatusBadge status={order.paymentStatus} />
        </div>
        <p className="muted">
          {tr(`pos.orderEntry.fulfilment.${order.fulfillment}`)}
          {order.roomNo ? ` · ${tr('order.detail.room', { room: order.roomNo })}` : ''}
          {` · ${formatDate(order.placedAt, locale, 'dateTime')}`}
        </p>
      </header>

      <h2 className="odetail__h">{tr('order.detail.items')}</h2>
      <ul className="odetail__lines">
        {order.items.map((item) => (
          <li key={item.id} className="oline">
            <span className="oline__qty">{tr('order.detail.qty', { count: item.qty })}</span>
            <span className="oline__what">
              <span>{localName(locale, item.nameTh, item.nameEn)}</span>
              {item.modifiers.length > 0 ? (
                <span className="muted">
                  {item.modifiers.map((m) => localName(locale, m.nameTh, m.nameEn)).join(' · ')}
                </span>
              ) : null}
              {item.note ? <span className="line__note">{item.note}</span> : null}
            </span>
            <span className="money">{formatBaht(item.lineTotalSatang, locale)}</span>
          </li>
        ))}
      </ul>
      {order.note ? <p className="muted">{`${tr('common.note')}: ${order.note}`}</p> : null}

      <div className="sumrow total odetail__total">
        <span>{tr('order.detail.serverTotal')}</span>
        <span className="money">{formatBaht(order.totalSatang, locale)}</span>
      </div>

      <p className="hint">{tr('order.detail.paymentSoon')}</p>
      {another}
    </section>
  );
}
