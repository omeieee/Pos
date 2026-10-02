import { formatBaht, formatDate } from '@sds/i18n';
import type { satang } from '@sds/shared';
import { useEffect, useRef, useState } from 'react';
import { can } from '../auth/auth-store.ts';
import {
  useActivityHold,
  useAuthState,
  useEntities,
  useLocale,
  useNow,
  useServices,
  useStoreState,
  useT,
} from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { CashPanel } from './CashPanel.tsx';
import { GovCopaySteps } from './GovCopayPanel.tsx';
import { MethodTiles } from './MethodTiles.tsx';
import { OpenPayment } from './OpenPayment.tsx';
import type { QueuedPayment } from './outbox-model.ts';
import { PaymentHistory } from './PaymentHistory.tsx';
import {
  COPAY_TICK_MS,
  confirmedPayment,
  methodOptions,
  openPayment,
  type PayMethod,
  paymentActions,
  paymentPhase,
  paymentsOf,
} from './payment-model.ts';
import { flowFor } from './payment-store.ts';
import { QueuedCash } from './QueuedCash.tsx';
import { StartPanel } from './StartPanel.tsx';
import { VoidRefundDialog } from './VoidRefundDialog.tsx';

/**
 * The payment part of the order page. Whatever it shows comes from the store, which holds only what
 * the server has said (its answers and realtime frames): nothing is shown as claimed, confirmed or
 * paid from a tap. The amount is always the server's order total; staff never type it.
 *
 * Phases: closed (cancelled order), nothing to pay, paid, open (a payment is waiting: its own
 * screen), and choose (pick a method). The unsure state of a request whose answer was lost lives in
 * the payment store, so it survives leaving the page; it ends when the answer is retried or when a
 * payment frame for this order arrives.
 */
export function PaymentPanel({ orderId }: { orderId: string }) {
  const authState = useAuthState();
  const order = useEntities().orders.get(orderId);
  const role = authState.session?.staff.role;
  if (!order || !role || !can(authState, 'payment.record')) return null;
  return <PaymentPanelBody orderId={orderId} />;
}

function PaymentPanelBody({ orderId }: { orderId: string }) {
  const { payments: flow, outbox } = useServices();
  const queue = useStoreState(outbox);
  const offline = queue.offline;
  const entities = useEntities();
  const flowState = useStoreState(flow);
  const tr = useT();
  const locale = useLocale();
  const order = entities.orders.get(orderId);
  const [loaded, setLoaded] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const role = useAuthState().session?.staff.role;
  const [selected, setSelected] = useState<PayMethod>('cash');
  const [hidden, setHidden] = useState<ReadonlySet<PayMethod>>(new Set());
  const attempted = useRef<PayMethod | null>(null);

  // The payments of this order: loaded once here, then kept live by the realtime frames.
  useEffect(() => {
    let live = true;
    setLoaded(false);
    void flow.refresh(orderId).then(() => {
      if (live) setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [flow, orderId]);

  const list = paymentsOf(entities, orderId);
  const maxRev = list.reduce((most, p) => Math.max(most, p.rev), 0);
  const mine = flowState.orderId === orderId;
  const lost = flowFor(flowState, orderId);
  const isUnsure = lost.unsure !== null;
  // The clock of this device decides when ไทยช่วยไทย closes for the day, so it ticks: a tile must
  // not stay enabled after the window ends. The server decides for real.
  const now = useNow(COPAY_TICK_MS);

  // A payment frame for this order after the outcome became unsure: the answer is known now.
  const unsureAt = useRef<number | null>(null);
  useEffect(() => {
    if (!isUnsure) {
      unsureAt.current = null;
      return;
    }
    if (unsureAt.current === null) {
      unsureAt.current = maxRev;
    } else if (maxRev > unsureAt.current) {
      unsureAt.current = null;
      flow.settled(orderId);
    }
  }, [isUnsure, maxRev, flow, orderId]);

  // The server says a method is switched off: stop offering it (until the page is reloaded).
  useEffect(() => {
    const method = attempted.current;
    if (mine && method && flowState.error?.code === 'METHOD_DISABLED') {
      setHidden((previous) => new Set(previous).add(method));
    }
  }, [mine, flowState.error]);

  const phase = order ? paymentPhase(order, list) : 'closed';
  const waiting = openPayment(list);
  // A payment that is open, or a request in flight, must not be lost to a page reload.
  useActivityHold(phase === 'open');

  if (!order) return null;
  const options = methodOptions(order, entities.settings, now, hidden, !offline);
  // Cash taken while offline for this order and not yet sent.
  const queuedCash = queue.items.find(
    (i): i is QueuedPayment => i.kind === 'payment' && i.orderId === order.id,
  );
  const choice = options.find((o) => o.method === selected && o.enabled)
    ? selected
    : (options.find((o) => o.enabled)?.method ?? null);
  const money = (value: number) => formatBaht(value, locale);
  const received = confirmedPayment(list);
  const remember = (method: PayMethod) => {
    attempted.current = method;
  };

  return (
    <section className="ppanel" aria-labelledby="pay-title">
      <header className="ppanel__head">
        <h2 id="pay-title" className="ppanel__title">
          {tr('payment.title')}
        </h2>
        <div className="due">
          <span className="lbl">{tr('payment.amountDue')}</span>
          <span className="amount-hero money">{money(order.totalSatang)}</span>
        </div>
      </header>

      {lost.busyElsewhere ? (
        <p className="notice" role="status">
          <Icon name="clock" />
          <span>{tr('payment.busyElsewhere')}</span>
        </p>
      ) : null}

      {/* A call for another order is still running: the server calls here would be refused, so
          the controls are off (a disabled fieldset disables every button inside it). */}
      <fieldset className="ppanel__body" disabled={lost.busyElsewhere}>
        {!loaded ? (
          <p className="muted" role="status">
            {tr('payment.loading')}
          </p>
        ) : phase === 'closed' ? (
          <p className="notice">{tr('payment.closed')}</p>
        ) : phase === 'nothingToPay' ? (
          <p className="notice">{tr('payment.nothingToPay')}</p>
        ) : phase === 'paid' ? (
          <div className="paid">
            <span className="status status--success paid__badge">
              <Icon name="check-circle" />
              {tr('payment.paid.title')}
            </span>
            {received ? (
              <p className="muted">
                {tr('payment.paid.detail', {
                  method: tr(`payment.method.${received.method}`),
                  time: received.confirmedAt
                    ? formatDate(received.confirmedAt, locale, 'time')
                    : '',
                })}
              </p>
            ) : null}
            <p className="hint">{tr('payment.change.confirmedLocked')}</p>
            {received && role && paymentActions(role, received).voidRefund ? (
              <button type="button" className="btn btn-danger" onClick={() => setVoiding(true)}>
                {tr('payment.void.button')}
              </button>
            ) : null}
            {voiding && received ? (
              <VoidRefundDialog
                order={order}
                payment={received}
                onClose={() => setVoiding(false)}
              />
            ) : null}
          </div>
        ) : phase === 'open' ? (
          <OpenPayment order={order} payment={waiting} hidden={hidden} onAttempt={remember} />
        ) : queuedCash ? (
          // Cash is already waiting to be sent: another method now would collide with it.
          <QueuedCash item={queuedCash} />
        ) : (
          <div className="choose">
            {offline ? (
              <p className="notice" role="status">
                <Icon name="wifi-off" />
                <span>{tr('outbox.onlineOnly')}</span>
              </p>
            ) : null}
            <MethodTiles
              options={options}
              choice={choice}
              name="pay-method"
              onChoose={setSelected}
            />
            {choice === 'cash' ? (
              <CashPanel
                order={order}
                onAttempt={remember}
                {...(offline && !isUnsure
                  ? {
                      queue: {
                        submit: (tender: ReturnType<typeof satang>) =>
                          outbox.enqueueCash({
                            target: { orderId: order.id },
                            tenderedSatang: tender,
                            totalSatang: order.totalSatang,
                            label: order.orderNo,
                          }),
                      },
                    }
                  : {})}
              />
            ) : null}
            {choice === 'promptpay' ? (
              <StartPanel order={order} method="promptpay" onAttempt={remember} />
            ) : null}
            {choice === 'platform' ? (
              <StartPanel order={order} method="platform" onAttempt={remember}>
                <p className="hint">{tr('platform.payment.hint')}</p>
              </StartPanel>
            ) : null}
            {choice === 'gov_copay' ? (
              <StartPanel order={order} method="gov_copay" onAttempt={remember}>
                <GovCopaySteps order={order} payment={undefined} />
              </StartPanel>
            ) : null}
          </div>
        )}
      </fieldset>

      <PaymentHistory payments={list} />
    </section>
  );
}
