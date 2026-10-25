/**
 * Order page: the two routes (one order, and the list of my orders).
 */
import { formatBaht } from '@sds/i18n';
import type { AppOpenOrder, MyOrder } from '@sds/shared';
import { useEffect, useState } from 'react';
import { Gi } from '../../design/icons.tsx';
import { s } from '../../design/style.ts';
import { errorKey, useApp, useT } from '../app-context.tsx';
import { BarButton, Body, Header, Notice } from '../Chrome.tsx';
import { OrderView } from './OrderView.tsx';
import { STATUS_BADGE, STATUS_KEY } from './status-maps.ts';
import { useOrder } from './use-order.ts';

export function OrderScreen({
  id,
  flag,
  shopPhone,
  onEdit,
}: {
  id: string;
  flag: string | null;
  /** The shop's phone from the API, when it sends one. */
  shopPhone: string | null;
  /** The customer wants to change the dishes: the app opens the menu with these lines. */
  onEdit?: (order: AppOpenOrder) => void;
}) {
  const tr = useT();
  const { platform } = useApp();
  const { order, setOrder, failure, speedUp } = useOrder(id);

  if (!order) {
    return (
      <>
        <Header
          left={<BarButton icon="x" label={tr('liff.close')} onClick={() => platform.close()} />}
          title={tr('liff.order.status')}
        />
        <Body label={tr('liff.order.status')}>
          {failure ? (
            <Notice tone="bad" icon="warn" alert>
              {tr(errorKey(failure))}
            </Notice>
          ) : (
            <Notice icon="clock">{tr('liff.loading')}</Notice>
          )}
        </Body>
      </>
    );
  }
  return (
    <OrderView
      order={order}
      setOrder={setOrder}
      flag={flag}
      shopPhone={shopPhone}
      onSlipSent={speedUp}
      {...(onEdit ? { onEdit } : {})}
    />
  );
}

export function OrdersScreen() {
  const tr = useT();
  const { api, go, locale } = useApp();
  const [orders, setOrders] = useState<MyOrder[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .orders()
      .then((r) => setOrders(r.orders))
      .catch((e: unknown) => setError(e ?? new Error('failed')));
  }, [api]);

  return (
    <>
      <Header
        left={<BarButton icon="chevronLeft" label={tr('liff.back')} onClick={() => go('/menu')} />}
        title={tr('liff.orders.title')}
      />
      <Body label={tr('liff.orders.title')}>
        {error !== null ? (
          <Notice tone="bad" icon="warn" alert>
            {tr(errorKey(error))}
          </Notice>
        ) : null}
        {orders === null && error === null ? (
          <Notice icon="clock">{tr('liff.loading')}</Notice>
        ) : null}
        {orders?.length === 0 ? (
          <div
            className="g-glass g-rise"
            style={s(
              'border-radius:28px;padding:28px 20px;display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center',
            )}
          >
            <Gi n="receipt" size="lg" style={{ color: 'var(--ink2)' }} />
            <p className="g-t-3" role="status" style={s('margin:0')}>
              {tr('liff.orders.none')}
            </p>
            <button type="button" className="g-btn g-btn-p" onClick={() => go('/menu')}>
              {tr('liff.checkout.emptyBack')}
            </button>
          </div>
        ) : null}
        <ul
          style={s(
            'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px',
          )}
        >
          {orders?.map((o, index) => {
            const look = STATUS_BADGE[o.status];
            return (
              <li key={o.id}>
                <button
                  type="button"
                  className="g-glass g-rise liff-orderrow"
                  style={{ ['--d' as string]: `${Math.min(0.04 + index * 0.04, 0.3)}s` }}
                  onClick={() => go(`/orders/${o.id}`)}
                >
                  <span
                    style={s('flex-grow:1;min-width:0;display:flex;flex-direction:column;gap:6px')}
                  >
                    <span className="g-num g-t-3">{o.orderNo}</span>
                    <span className={`g-badge ${look.tone}`} style={s('align-self:flex-start')}>
                      <Gi n={look.icon} />
                      {tr(STATUS_KEY[o.status])}
                    </span>
                  </span>
                  <span className="g-num g-t-2">{formatBaht(o.totalSatang, locale)}</span>
                  <Gi n="chevronRight" style={{ color: 'var(--ink3)' }} />
                </button>
              </li>
            );
          })}
        </ul>
      </Body>
    </>
  );
}
