import { formatBaht, type MessageKey } from '@sds/i18n';
import type { AppPayMethod, MyOrder, MyQrResponse } from '@sds/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { nextPollDelayMs } from '../model/poll.ts';
import { errorKey, useApp, useT } from './app-context.tsx';

const STATUS_KEY: Record<MyOrder['status'], MessageKey> = {
  new: 'lineBot.status.new',
  preparing: 'lineBot.status.preparing',
  ready: 'lineBot.status.ready',
  completed: 'lineBot.status.completed',
  cancelled: 'lineBot.status.cancelled',
};
const PAYMENT_KEY: Record<MyOrder['paymentStatus'], MessageKey> = {
  unpaid: 'status.payment.unpaid',
  awaiting_confirmation: 'status.payment.awaiting_confirmation',
  partially_paid: 'status.payment.partially_paid',
  paid: 'status.payment.paid',
  refunded: 'status.payment.refunded',
};

/** An order page that follows the order: asks the server every few seconds while it is open. */
function useOrder(id: string) {
  const { api } = useApp();
  const [order, setOrder] = useState<MyOrder | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const failures = useRef(0);
  const latest = useRef<MyOrder | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.order(id);
      latest.current = next;
      failures.current = 0;
      setFailure(null);
      setOrder(next);
    } catch (e) {
      failures.current += 1;
      setFailure(e);
    }
  }, [api, id]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      await load();
      if (stopped) return;
      const delay = nextPollDelayMs(latest.current, document.hidden, failures.current);
      if (delay !== null) timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    // Coming back to the app shows the newest state at once.
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  return { order, setOrder, failure, reload: load };
}

export function OrderScreen({ id, flag }: { id: string; flag: string | null }) {
  const tr = useT();
  const { api, locale, go } = useApp();
  const { order, setOrder, failure } = useOrder(id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  async function act(run: () => Promise<MyOrder>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setOrder(await run());
      setChanging(false);
    } catch (e) {
      setError(tr(errorKey(e)));
    } finally {
      setBusy(false);
    }
  }

  if (!order) {
    return (
      <p className={failure ? 'error' : 'muted'} role={failure ? 'alert' : 'status'}>
        {failure ? tr(errorKey(failure)) : tr('liff.loading')}
      </p>
    );
  }

  const method = order.payment?.method;
  const waiting =
    order.payment && (order.payment.status === 'pending' || order.payment.status === 'claimed');
  const closed = order.status === 'completed' || order.status === 'cancelled';
  return (
    <section aria-labelledby="order-title">
      <h1 id="order-title">{tr('liff.order.title', { orderNo: order.orderNo })}</h1>
      {flag === 'placed' ? <p className="notice">{tr('liff.order.placed')}</p> : null}
      {flag === 'failed' ? <p className="error">{tr('liff.order.paymentFailed')}</p> : null}
      <p className="muted">
        {tr('liff.order.deliverTo', {
          building: order.deliveryBuilding ?? '',
          name: order.recipientName ?? '',
        })}
      </p>
      <dl className="facts" aria-live="polite">
        <dt>{tr('liff.order.status')}</dt>
        <dd className="strong">{tr(STATUS_KEY[order.status])}</dd>
        <dt>{tr('liff.order.payment')}</dt>
        <dd className="strong">{tr(PAYMENT_KEY[order.paymentStatus])}</dd>
      </dl>
      <ul className="list">
        {order.items.map((item, i) => (
          // The server's lines have no stable client id; their order is fixed.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed order from the server
          <li key={i} className="row">
            <span className="grow">
              {item.qty} × {locale === 'en' && item.nameEn ? item.nameEn : item.nameTh}
              {item.modifiers.length > 0 ? (
                <span className="muted small">
                  {' '}
                  (
                  {item.modifiers
                    .map((m) => (locale === 'en' && m.nameEn ? m.nameEn : m.nameTh))
                    .join(', ')}
                  )
                </span>
              ) : null}
            </span>
            <span>{formatBaht(item.lineTotalSatang, locale)}</span>
          </li>
        ))}
        <li className="row strong">
          <span className="grow">{tr('liff.order.total')}</span>
          <span>{formatBaht(order.totalSatang, locale)}</span>
        </li>
      </ul>

      {order.paymentStatus === 'paid' ? <p className="success">{tr('liff.order.paid')}</p> : null}
      {!closed && order.paymentStatus !== 'paid' ? (
        <div className="pay">
          {method === 'promptpay' && waiting ? (
            <>
              {order.actions.showQr ? <QrView orderId={order.id} /> : null}
              {order.payment?.status === 'claimed' ? (
                <p className="notice">{tr('liff.order.claimed')}</p>
              ) : null}
              {order.actions.claim ? (
                <button
                  type="button"
                  className="btn primary wide"
                  disabled={busy}
                  onClick={() => void act(() => api.claim(order.id))}
                >
                  {busy ? tr('liff.order.claiming') : tr('liff.order.claim')}
                </button>
              ) : null}
            </>
          ) : null}
          {method === 'gov_copay' && waiting ? (
            <p className="notice">
              {tr('liff.order.copayNote', { amount: formatBaht(order.totalSatang, locale) })}
            </p>
          ) : null}
          {!waiting ? <p className="notice">{tr('liff.order.cashNote')}</p> : null}
          {order.actions.changeMethod && order.actions.methods.length > 0 ? (
            changing ? (
              <MethodChoices
                methods={order.actions.methods}
                current={waiting ? method : 'cash'}
                busy={busy}
                onPick={(m) => void act(() => api.selectPayment(order.id, m))}
              />
            ) : (
              <button type="button" className="btn wide" onClick={() => setChanging(true)}>
                {tr('liff.order.changeMethod')}
              </button>
            )
          ) : null}
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
      <button type="button" className="btn wide" onClick={() => go('/orders')}>
        {tr('liff.nav.orders')}
      </button>
    </section>
  );
}

function MethodChoices({
  methods,
  current,
  busy,
  onPick,
}: {
  methods: AppPayMethod[];
  current: string | undefined;
  busy: boolean;
  onPick: (method: AppPayMethod) => void;
}) {
  const tr = useT();
  return (
    <ul className="list">
      {methods.map((m) => (
        <li key={m}>
          <button
            type="button"
            className="btn wide"
            disabled={busy || m === current}
            aria-pressed={m === current}
            onClick={() => onPick(m)}
          >
            {tr(`liff.checkout.method.${m}`)}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The PromptPay QR: a fresh signed link each time it is shown, and again before it expires. */
function QrView({ orderId }: { orderId: string }) {
  const tr = useT();
  const { api, locale } = useApp();
  const [qr, setQr] = useState<MyQrResponse | null>(null);
  const [failed, setFailed] = useState(false);

  const fetchQr = useCallback(async () => {
    try {
      setQr(await api.qr(orderId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [api, orderId]);

  useEffect(() => {
    void fetchQr();
    // The link lasts five minutes: ask for a new one before it dies.
    const timer = setInterval(() => void fetchQr(), 4 * 60_000);
    return () => clearInterval(timer);
  }, [fetchQr]);

  if (failed && !qr) {
    return (
      <button type="button" className="btn wide" onClick={() => void fetchQr()}>
        {tr('liff.qr.refresh')}
      </button>
    );
  }
  if (!qr) return <p className="muted">{tr('liff.loading')}</p>;
  const amount = formatBaht(qr.amountSatang, locale);
  return (
    <div className="qr">
      <h2>{tr('liff.qr.title')}</h2>
      <img
        src={api.absolute(qr.url)}
        alt={tr('liff.qr.alt', { amount })}
        width={240}
        height={240}
        onError={() => void fetchQr()}
      />
      <p className="amount">{tr('liff.qr.amount', { amount })}</p>
      <p className="strong">{tr('liff.qr.id', { id: qr.promptpayId })}</p>
      <p className="muted small">{tr('liff.qr.help')}</p>
    </div>
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
    <section aria-labelledby="orders-title">
      <h1 id="orders-title">{tr('liff.orders.title')}</h1>
      {error !== null ? (
        <p className="error" role="alert">
          {tr(errorKey(error))}
        </p>
      ) : null}
      {orders === null && error === null ? <p className="muted">{tr('liff.loading')}</p> : null}
      {orders?.length === 0 ? <p className="muted">{tr('liff.orders.none')}</p> : null}
      <ul className="list">
        {orders?.map((o) => (
          <li key={o.id}>
            <button type="button" className="btn wide left" onClick={() => go(`/orders/${o.id}`)}>
              <span className="strong">{o.orderNo}</span> <span>{tr(STATUS_KEY[o.status])}</span>{' '}
              <span className="muted">{formatBaht(o.totalSatang, locale)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
