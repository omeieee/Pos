import { formatBaht, formatDate } from '@sds/i18n';
import type { satang } from '@sds/shared';
import { useEffect, useRef, useState } from 'react';
import { can } from '../auth/auth-store.ts';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
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
import { CashPanel } from './CashPanel.tsx';
import { GovCopaySteps } from './GovCopayPanel.tsx';
import { MethodNotes, MethodTiles } from './MethodTiles.tsx';
import { OfflinePromptPay } from './OfflinePromptPay.tsx';
import { OpenPayment } from './OpenPayment.tsx';
import type { QueuedPayment } from './outbox-model.ts';
import { PaymentHistory } from './PaymentHistory.tsx';
import { Callout, PayFrame, usePayDims } from './PayParts.tsx';
import { PromptPayStart } from './PromptPayPanel.tsx';
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
import { QueuedPaymentView } from './QueuedPaymentView.tsx';
import { ReceiptActions } from './ReceiptActions.tsx';
import { StartPanel } from './StartPanel.tsx';
import { VoidRefundDialog } from './VoidRefundDialog.tsx';
import './pay-glass.css';

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
  const { payments: flow, outbox, promptpay } = useServices();
  const queue = useStoreState(outbox);
  useStoreState(promptpay);
  const offline = queue.offline;
  const entities = useEntities();
  const flowState = useStoreState(flow);
  const tr = useT();
  const locale = useLocale();
  const dims = usePayDims();
  const phone = dims.layout === 'phone';
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
  // A role that may not read the PromptPay ID has no offline QR (PromptPay stays "needs the internet").
  const idStatus = promptpay.idStatus();
  const options = methodOptions(
    order,
    entities.settings,
    now,
    hidden,
    !offline,
    idStatus === 'forbidden' ? undefined : idStatus,
  );
  // Cash or PromptPay taken while offline for this order and not yet sent.
  const queuedPayment = queue.items.find(
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

  // The payment that is waiting has its own screen: the list below is for the ones before it.
  const pastPayments = list.filter((p) => p !== waiting);
  const choosing = phase === 'choose' && !queuedPayment;
  const showSwitch = loaded && (choosing || phase === 'open');
  const waitingMethod = waiting && waiting.method !== 'other' ? waiting.method : null;
  const switchChoice = phase === 'open' ? waitingMethod : choice;
  const title =
    phase === 'choose' || phase === 'open' ? tr('payment.title') : tr('payment.titleDone');
  const body = 'pay-body';

  return (
    <PayFrame
      title={title}
      notes={showSwitch ? <MethodNotes options={options} choice={switchChoice} /> : null}
      amountLabel={tr('payment.amountDue')}
      amountText={money(order.totalSatang)}
      switcher={
        showSwitch ? (
          <MethodTiles
            options={options}
            choice={switchChoice}
            name="pay-method"
            onChoose={setSelected}
            locked={phase === 'open'}
            disabled={lost.busyElsewhere}
            fill={phone}
          />
        ) : null
      }
      notice={
        lost.busyElsewhere ? (
          <Callout tone="warn" icon="clock" role="status">
            {tr('payment.busyElsewhere')}
          </Callout>
        ) : null
      }
      disabled={lost.busyElsewhere}
      after={<PaymentHistory payments={pastPayments} />}
    >
      {!loaded ? (
        <p className="g-t-s" role="status" style={s('margin:0')}>
          {tr('payment.loading')}
        </p>
      ) : phase === 'closed' ? (
        <Callout tone="warn" icon="warn">
          {tr('payment.closed')}
        </Callout>
      ) : phase === 'nothingToPay' ? (
        <Callout tone="info">{tr('payment.nothingToPay')}</Callout>
      ) : phase === 'paid' ? (
        <div
          className="g-rise"
          data-testid="paid-card"
          style={s(
            'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:24px 0',
          )}
        >
          <div
            style={s(
              'width:84px;height:84px;border-radius:50%;display:grid;place-items:center;background:var(--jade);color:#fff;box-shadow:0 12px 28px rgba(27,122,67,.3)',
            )}
          >
            <Gi n="check" size="lg" style={s('width:40px;height:40px')} />
          </div>
          <div className="g-t-1">{tr('payment.paid.title')}</div>
          {received ? (
            <div className="g-t-s">
              {tr('payment.paid.detail', {
                method: tr(`payment.method.${received.method}`),
                time: received.confirmedAt ? formatDate(received.confirmedAt, locale, 'time') : '',
              })}
            </div>
          ) : null}
          <div className="g-t-c" style={s('max-width:420px')}>
            {tr('payment.change.confirmedLocked')}
          </div>
          <ReceiptActions key={order.id} order={order} received={received} />
          {received && role && paymentActions(role, received).voidRefund ? (
            <button type="button" className="g-btn" onClick={() => setVoiding(true)}>
              {tr('payment.void.button')}
            </button>
          ) : null}
          {voiding && received ? (
            <VoidRefundDialog order={order} payment={received} onClose={() => setVoiding(false)} />
          ) : null}
        </div>
      ) : phase === 'open' ? (
        <div className={body}>
          {/* The PromptPay payment was made on the server and its confirm (or the reason it was
                held back) is still on this device. */}
          {queuedPayment?.method === 'promptpay' ? (
            <QueuedPaymentView item={queuedPayment} />
          ) : null}
          <OpenPayment order={order} payment={waiting} hidden={hidden} onAttempt={remember} />
        </div>
      ) : queuedPayment ? (
        // A payment is already waiting to be sent: another method now would collide with it.
        <div className={body}>
          <QueuedPaymentView item={queuedPayment} />
        </div>
      ) : (
        <div className={body}>
          {offline ? (
            <Callout tone="info" icon="info" role="status">
              {tr(
                options.some((o) => o.method === 'promptpay' && o.enabled)
                  ? 'outbox.onlineOnlyCopay'
                  : 'outbox.onlineOnly',
              )}
            </Callout>
          ) : null}
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
            offline && !isUnsure ? (
              // No server: the QR is drawn here from the saved ID, for the server's last known total.
              <OfflinePromptPay
                amountSatang={order.totalSatang}
                amountKind="server"
                submit={(qr) =>
                  outbox.enqueuePromptpay({
                    target: { orderId: order.id },
                    qrAmountSatang: qr.qrAmountSatang,
                    amountKind: 'server',
                    qrTargetMasked: qr.qrTargetMasked,
                    label: order.orderNo,
                  })
                }
              />
            ) : (
              <StartPanel order={order} method="promptpay" onAttempt={remember}>
                <PromptPayStart order={order} />
              </StartPanel>
            )
          ) : null}
          {choice === 'platform' ? (
            <StartPanel order={order} method="platform" onAttempt={remember}>
              <Callout tone="info" icon="store">
                {tr('platform.payment.hint')}
              </Callout>
            </StartPanel>
          ) : null}
          {choice === 'gov_copay' ? (
            <StartPanel order={order} method="gov_copay" onAttempt={remember}>
              <GovCopaySteps order={order} payment={undefined} />
            </StartPanel>
          ) : null}
        </div>
      )}
    </PayFrame>
  );
}
