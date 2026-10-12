import { formatBaht, type Locale, type MessageKey } from '@sds/i18n';
import type { AppPayMethod, MyOrder, MyQrResponse } from '@sds/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Gi, type GiName } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { telHref } from '../model/contact.ts';
import { markPaidPopupSeen, paidPopupSeen, shouldShowPaidPopup } from '../model/paid-popup.ts';
import { nextPollDelayMs } from '../model/poll.ts';
import { browserSaveEnv, qrFileName, saveQrImage, toPng } from '../model/qr-save.ts';
import { canDownloadReceipt, receiptFileName, receiptHtml } from '../model/receipt.ts';
import {
  msUntilMinShown,
  type SlipProgressPhase,
  slipPollDelayMs,
  slipProgressPhase,
} from '../model/slip-progress.ts';
import { awaitsTransferConfirmation, isPaymentRejected, orderSteps } from '../model/steps.ts';
import { cooldownMinutes, errorKey, errorText, useApp, useT } from './app-context.tsx';
import { BarButton, Body, Header, Notice } from './Chrome.tsx';
import { PayButton } from './PayOption.tsx';

const STATUS_KEY: Record<MyOrder['status'], MessageKey> = {
  new: 'lineBot.status.new',
  preparing: 'lineBot.status.preparing',
  ready: 'lineBot.status.ready',
  completed: 'lineBot.status.completed',
  cancelled: 'lineBot.status.cancelled',
};
const PAYMENT_KEY: Record<MyOrder['paymentStatus'], MessageKey> = {
  unpaid: 'liff.order.payWaiting',
  awaiting_confirmation: 'status.payment.awaiting_confirmation',
  partially_paid: 'status.payment.partially_paid',
  paid: 'status.payment.paid',
  refunded: 'status.payment.refunded',
};
/** Badge look per payment status: colour, icon and word always together. */
const PAYMENT_BADGE: Record<MyOrder['paymentStatus'], { tone: string; icon: GiName }> = {
  unpaid: { tone: 'g-b-warn', icon: 'pending' },
  awaiting_confirmation: { tone: 'g-b-info', icon: 'clock' },
  partially_paid: { tone: 'g-b-warn', icon: 'pending' },
  paid: { tone: 'g-b-ok', icon: 'check' },
  refunded: { tone: 'g-b-mute', icon: 'info' },
};
const STATUS_BADGE: Record<MyOrder['status'], { tone: string; icon: GiName }> = {
  new: { tone: 'g-b-info', icon: 'clock' },
  preparing: { tone: 'g-b-warn', icon: 'bowl' },
  ready: { tone: 'g-b-ok', icon: 'check' },
  completed: { tone: 'g-b-mute', icon: 'check' },
  cancelled: { tone: 'g-b-bad', icon: 'x' },
};
/** One neutral line per stage; every result that is not a success shows the same words. */
const SLIP_CHECK_KEY: Record<NonNullable<MyOrder['slipCheck']>, MessageKey> = {
  none: 'liff.slipStatus.none',
  checking: 'liff.slipStatus.checking',
  staff_review: 'liff.slipStatus.staffReview',
};
const STEP_KEY: MessageKey[] = [
  'liff.order.step.ordered',
  'liff.order.step.pay',
  'liff.order.step.cooking',
  'liff.order.step.pickup',
];

/** An order page that follows the order: asks the server every few seconds while it is open. */
function useOrder(id: string) {
  const { api } = useApp();
  const [order, setOrder] = useState<MyOrder | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const failures = useRef(0);
  const latest = useRef<MyOrder | null>(null);
  /** When the customer sent a slip in this visit: the page asks faster for a while after it. */
  const fastSince = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tickRef = useRef<() => void>(() => {});

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
    let stopped = false;
    const tick = async () => {
      await load();
      if (stopped) return;
      const normal = nextPollDelayMs(latest.current, document.hidden, failures.current);
      const fast =
        fastSince.current === null
          ? null
          : slipPollDelayMs(Date.now() - fastSince.current, latest.current, failures.current);
      // A closed order stops the page whatever the slip says; otherwise the quicker rate wins.
      const delay = normal === null ? null : (fast ?? normal);
      clearTimeout(timerRef.current);
      if (delay !== null) timerRef.current = setTimeout(() => void tick(), delay);
    };
    tickRef.current = () => void tick();
    void tick();
    // Coming back to the app shows the newest state at once.
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timerRef.current);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timerRef.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  /** A slip was just sent: poll quickly for a while (the page's own rate takes over after). */
  const speedUp = useCallback((startedAt: number) => {
    fastSince.current = startedAt;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => tickRef.current(), 2000);
  }, []);

  return { order, setOrder, failure, reload: load, speedUp };
}

export function OrderScreen({
  id,
  flag,
  shopPhone,
}: {
  id: string;
  flag: string | null;
  /** The shop's phone from the API, when it sends one. */
  shopPhone: string | null;
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
    />
  );
}

/** The loaded order page. Split from the polling shell so it can be rendered on its own. */
export function OrderView({
  order,
  setOrder,
  flag,
  shopPhone,
  onSlipSent,
}: {
  order: MyOrder;
  setOrder: (order: MyOrder) => void;
  flag: string | null;
  shopPhone: string | null;
  /** Called when a slip upload succeeds, so the page can poll faster. */
  onSlipSent?: (startedAt: number) => void;
}) {
  const tr = useT();
  const { api, locale, go, platform } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [slipSent, setSlipSent] = useState(false);
  /** Counts the slips sent in this visit, so a picture on show is dropped when it is replaced. */
  const [slipStamp, setSlipStamp] = useState(0);
  const tel = telHref(shopPhone);
  const [paidPopup, setPaidPopup] = useState(false);
  /** When the slip-check pop-up opened (null when it is closed) and the clock that drives it. */
  const [slipProgress, setSlipProgress] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  /** True from the moment a slip is sent until its pop-up is closed: it owns the paid message. */
  const progressOwnsPaid = useRef(false);
  /** The payment status this page saw last. Starts as the first load, so a paid order never pops up. */
  const lastPayment = useRef(order.paymentStatus);
  const paymentId = order.payment?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of status matters
  useEffect(() => {
    const previous = lastPayment.current;
    lastPayment.current = order.paymentStatus;
    if (shouldShowPaidPopup(previous, order, paymentId ? paidPopupSeen(paymentId) : false)) {
      if (paymentId) markPaidPopupSeen(paymentId);
      // The slip-check pop-up shows the success itself: no second pop-up for the same payment.
      if (!progressOwnsPaid.current) setPaidPopup(true);
    }
  }, [order.paymentStatus]);

  const phase: SlipProgressPhase | null =
    slipProgress === null ? null : slipProgressPhase(Math.max(0, now - slipProgress), order);
  // Re-evaluate when the minimum time ends, then now and then until there is an answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `now` re-arms the timer
  useEffect(() => {
    if (slipProgress === null || phase !== 'checking') return;
    const wait = msUntilMinShown(Date.now() - slipProgress);
    const timer = setTimeout(() => setNow(Date.now()), wait > 0 ? wait : 1000);
    return () => clearTimeout(timer);
  }, [slipProgress, phase, now]);

  const closeSlipProgress = useCallback(() => {
    progressOwnsPaid.current = false;
    setSlipProgress(null);
  }, []);

  function sendSlip(file: File) {
    progressOwnsPaid.current = true;
    void act(() => api.attachSlip(order.id, file)).then((ok) => {
      if (!ok) {
        // Refused (a wait, a block, a bad file): the message under the buttons says why.
        progressOwnsPaid.current = false;
        return;
      }
      const startedAt = Date.now();
      setSlipSent(true);
      setSlipStamp((n) => n + 1);
      setNow(startedAt);
      setSlipProgress(startedAt);
      onSlipSent?.(startedAt);
    });
  }

  async function act(run: () => Promise<MyOrder>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      setOrder(await run());
      setChanging(false);
      return true;
    } catch (e) {
      setError(errorText(tr, e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const close = <BarButton icon="x" label={tr('liff.close')} onClick={() => platform.close()} />;

  const method = order.payment?.method;
  const waiting =
    order.payment && (order.payment.status === 'pending' || order.payment.status === 'claimed');
  const closed = order.status === 'completed' || order.status === 'cancelled';
  const rejected = !closed && order.paymentStatus !== 'paid' && isPaymentRejected(order);
  const steps = orderSteps(order);
  const badge =
    order.status === 'cancelled' ? STATUS_BADGE.cancelled : PAYMENT_BADGE[order.paymentStatus];
  const badgeKey =
    order.status === 'cancelled' ? STATUS_KEY.cancelled : PAYMENT_KEY[order.paymentStatus];

  return (
    <>
      <Header
        left={close}
        title={<span className="g-num">{tr('liff.order.title', { orderNo: order.orderNo })}</span>}
        right={
          <span className={`g-badge ${badge.tone}`} style={s('margin-right:6px')}>
            <Gi n={badge.icon} />
            {tr(badgeKey)}
          </span>
        }
      />
      <Body label={tr('liff.order.status')} bottom={24}>
        <div style={s('display:flex;flex-direction:column;gap:14px;min-height:100%')}>
          {/* The words of the tracker for screen readers; sighted users read the dots. */}
          <p className="sr-only" aria-live="polite">
            {tr('liff.order.status')}: {tr(STATUS_KEY[order.status])} · {tr('liff.order.payment')}:{' '}
            {tr(PAYMENT_KEY[order.paymentStatus])}
          </p>

          {flag === 'placed' ? (
            <Notice tone="ok" icon="check">
              {tr('liff.order.placed')}
            </Notice>
          ) : null}
          {flag === 'failed' ? (
            <Notice tone="bad" icon="warn" alert>
              {tr('liff.order.paymentFailed')}
            </Notice>
          ) : null}

          {rejected ? (
            <Notice tone="warn" icon="warn" alert>
              <b>{tr('liff.order.rejectedTitle')}</b>
              <br />
              {tr('liff.order.rejectedBody')}
              {tel ? (
                <>
                  <br />
                  <a href={tel} style={s('font-weight:600')}>
                    {tr('liff.contact.call')}
                  </a>
                </>
              ) : null}
            </Notice>
          ) : null}

          {steps ? (
            <ol
              aria-label={tr('liff.order.steps')}
              className="g-glass g-rise"
              style={s(
                'border-radius:28px;padding:18px 14px 16px;display:flex;list-style:none;margin:0;--d:.04s',
              )}
            >
              {steps.map((state, i) => (
                <li
                  // The four steps never change order.
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed list
                  key={i}
                  className={`st ${state === 'todo' ? '' : state}`}
                  aria-current={state === 'now' ? 'step' : undefined}
                >
                  <span className="d">{state === 'done' ? <Gi n="check" size="sm" /> : i + 1}</span>
                  {tr(STEP_KEY[i] ?? 'liff.order.step.ordered')}
                </li>
              ))}
            </ol>
          ) : (
            <Notice tone="bad" icon="x">
              {tr('lineBot.status.cancelled')}
            </Notice>
          )}
          {awaitsTransferConfirmation(order) ? (
            <p className="g-t-c" role="status" style={s('margin:0;text-align:center')}>
              {tr('liff.order.awaitingTransfer')}
            </p>
          ) : null}

          {!closed && order.paymentStatus !== 'paid' ? (
            <>
              {rejected || (method === 'promptpay' && waiting) ? (
                <PromptPayPanel
                  order={order}
                  busy={busy}
                  onClaim={() => void act(() => api.claim(order.id))}
                  slipSent={slipSent}
                  slipStamp={slipStamp}
                  onSlip={sendSlip}
                />
              ) : null}
              {method === 'gov_copay' && waiting ? (
                <Notice icon="bank">
                  {tr('liff.order.copayNote', { amount: formatBaht(order.totalSatang, locale) })}
                </Notice>
              ) : null}
              {!waiting && !rejected ? (
                <Notice icon="cash">{tr('liff.order.cashNote')}</Notice>
              ) : null}
              {order.actions.changeMethod && order.actions.methods.length > 0 ? (
                changing ? (
                  <MethodChoices
                    methods={order.actions.methods}
                    current={waiting ? method : 'cash'}
                    busy={busy}
                    onPick={(m) => void act(() => api.selectPayment(order.id, m))}
                  />
                ) : (
                  <button
                    type="button"
                    className="g-btn g-btn-block"
                    onClick={() => setChanging(true)}
                  >
                    {tr('liff.order.changeMethod')}
                  </button>
                )
              ) : null}
              {error ? (
                <Notice tone="bad" icon="warn" alert>
                  {error}
                </Notice>
              ) : null}
            </>
          ) : null}
          {order.paymentStatus === 'paid' ? (
            <Notice tone="ok" icon="check">
              {tr('liff.order.paid')}
            </Notice>
          ) : null}

          <ul
            className="g-glass g-rise"
            style={s('border-radius:28px;padding:4px 16px;margin:0;list-style:none;--d:.2s')}
          >
            {order.items.map((item, i) => (
              // The server's lines have no stable client id; their order is fixed.
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed order from the server
                key={i}
                className="g-row"
                style={s('padding:10px 0;min-height:0;align-items:flex-start')}
              >
                <div style={s('flex-grow:1;min-width:0')}>
                  <div className="g-t-3" style={s('font-size:15px')}>
                    {locale === 'en' && item.nameEn ? item.nameEn : item.nameTh}
                  </div>
                  <div className="g-t-c">
                    {item.modifiers.length > 0
                      ? `${item.modifiers
                          .map((m) => (locale === 'en' && m.nameEn ? m.nameEn : m.nameTh))
                          .join(', ')} · `
                      : ''}
                    ×{item.qty}
                  </div>
                </div>
                <span className="g-num g-t-3" style={s('font-size:15px')}>
                  {formatBaht(item.lineTotalSatang, locale)}
                </span>
              </li>
            ))}
            <li className="g-row" style={s('padding:10px 0;min-height:0')}>
              <span className="g-t-3" style={s('flex-grow:1')}>
                {tr('liff.order.total')}
              </span>
              <span className="g-num g-t-2">{formatBaht(order.totalSatang, locale)}</span>
            </li>
          </ul>

          {canDownloadReceipt(order) ? (
            <button
              type="button"
              className="g-btn g-btn-block"
              onClick={() => downloadReceipt(order, locale)}
            >
              <Gi n="download" size="sm" />
              {tr('liff.receipt.download')}
            </button>
          ) : null}

          {tel ? (
            <a className="g-btn g-btn-block" href={tel}>
              <Gi n="phone" size="sm" />
              {tr('liff.contact.call')}
            </a>
          ) : null}

          <button type="button" className="g-btn g-btn-block" onClick={() => go('/orders')}>
            {tr('liff.nav.orders')}
          </button>

          {order.deliveryBuilding ? (
            <div
              className="g-t-c"
              style={s(
                'margin-top:auto;padding:6px 6px 0;display:flex;gap:8px;align-items:center;justify-content:center;text-align:center',
              )}
            >
              <Gi n="building" style={{ width: 15, height: 15 }} />
              {tr('liff.order.deliverTo', {
                building: order.deliveryBuilding,
                name: order.recipientName ?? '',
              })}
            </div>
          ) : null}
        </div>
      </Body>
      {phase ? (
        <SlipProgressPopup phase={phase} orderNo={order.orderNo} onClose={closeSlipProgress} />
      ) : null}
      {paidPopup && !phase ? (
        <PaidPopup orderNo={order.orderNo} onClose={() => setPaidPopup(false)} />
      ) : null}
    </>
  );
}

/** The bottom sheet every pop-up here uses: focus on open, Escape or the scrim closes it. */
function PopupShell({
  titleId,
  onClose,
  children,
}: {
  titleId: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay liff-overlay" role="presentation">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="liff-scrim"
        onClick={onClose}
      />
      <div
        ref={dialog}
        tabIndex={-1}
        className="sheet liff-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={s('align-items:center;gap:10px;text-align:center')}
      >
        {children}
      </div>
    </div>
  );
}

/** Rises from the bottom when the shop confirms the transfer while the page is open. */
export function PaidPopup({ orderNo, onClose }: { orderNo: string; onClose: () => void }) {
  const tr = useT();
  return (
    <PopupShell titleId="paid-popup-title" onClose={onClose}>
      <Gi n="check" size="lg" style={{ color: 'var(--jade)' }} />
      <h2 id="paid-popup-title" className="g-t-2" style={s('margin:0')}>
        {tr('liff.paidPopup.title')}
      </h2>
      <p className="g-t-3" style={s('margin:0')}>
        {tr('liff.paidPopup.body')}
      </p>
      <p className="g-num g-t-c" style={s('margin:0')}>
        {tr('liff.paidPopup.order', { orderNo })}
      </p>
      <button type="button" className="g-btn g-btn-p g-btn-block" onClick={onClose}>
        {tr('liff.close')}
      </button>
    </PopupShell>
  );
}

/**
 * Opens when the customer sends a slip and follows the check in the same pop-up: moving bar, then
 * "money received", or the neutral "the shop is checking". Never a failure or a reason. It can be
 * closed at any time; the check goes on and the page keeps showing the status.
 */
export function SlipProgressPopup({
  phase,
  orderNo,
  onClose,
}: {
  phase: SlipProgressPhase;
  orderNo: string;
  onClose: () => void;
}) {
  const tr = useT();
  return (
    <PopupShell titleId="slip-progress-title" onClose={onClose}>
      <div
        aria-live="polite"
        style={s('display:flex;flex-direction:column;align-items:center;gap:10px;width:100%')}
      >
        {phase === 'paid' ? (
          <>
            <Gi n="check" size="lg" style={{ color: 'var(--jade)' }} />
            <h2 id="slip-progress-title" className="g-t-2" style={s('margin:0')}>
              {tr('liff.paidPopup.title')}
            </h2>
            <p className="g-t-3" style={s('margin:0')}>
              {tr('liff.paidPopup.body')}
            </p>
            <p className="g-num g-t-c" style={s('margin:0')}>
              {tr('liff.paidPopup.order', { orderNo })}
            </p>
          </>
        ) : phase === 'staff_review' ? (
          <>
            <Gi n="clock" size="lg" style={{ color: 'var(--ink2)' }} />
            <h2 id="slip-progress-title" className="g-t-2" style={s('margin:0')}>
              {tr('liff.slipProgress.staffTitle')}
            </h2>
            <p className="g-t-3" style={s('margin:0')}>
              {tr('liff.slipProgress.staffBody')}
            </p>
          </>
        ) : (
          <>
            <h2 id="slip-progress-title" className="g-t-2" style={s('margin:0')}>
              {tr('liff.slipProgress.title')}
            </h2>
            <div
              className="liff-progress"
              role="progressbar"
              aria-label={tr('liff.slipProgress.label')}
            >
              <span />
            </div>
            <p className="g-t-3" style={s('margin:0')}>
              {tr('liff.slipProgress.hint')}
            </p>
          </>
        )}
      </div>
      <button type="button" className="g-btn g-btn-p g-btn-block" onClick={onClose}>
        {tr('liff.close')}
      </button>
    </PopupShell>
  );
}

/** Saves the receipt as a file; it is built on this device from the order the server sent. */
function downloadReceipt(order: MyOrder, locale: Locale) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(
    new Blob([receiptHtml(order, locale)], { type: 'text/html;charset=utf-8' }),
  );
  link.download = receiptFileName(order);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

/**
 * The slip this customer sent, on request. It is fetched with the session header (an `<img>` cannot
 * send one), shown from a `blob:` link and never stored. Only the picture they sent: nothing the
 * shop's system read from it.
 */
function SentSlip({ orderId, stamp }: { orderId: string; stamp: number }) {
  const tr = useT();
  const { api } = useApp();
  const [src, setSrc] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'failed'>('idle');

  // A new slip (or another order) makes the old picture on show stale.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stamp` is the trigger
  useEffect(() => {
    setSrc(null);
    setPhase('idle');
  }, [orderId, stamp]);
  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  async function open() {
    setPhase('loading');
    try {
      setSrc(URL.createObjectURL(await api.slip(orderId)));
      setPhase('idle');
    } catch {
      setPhase('failed');
    }
  }

  return (
    <div style={s('display:flex;flex-direction:column;gap:8px')}>
      {src ? (
        <>
          <img
            src={src}
            alt={tr('liff.slip.alt')}
            style={s('max-width:100%;max-height:60vh;object-fit:contain;border-radius:12px')}
          />
          <button type="button" className="g-btn g-btn-sm" onClick={() => setSrc(null)}>
            {tr('liff.slip.hide')}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="g-btn g-btn-sm"
          disabled={phase === 'loading'}
          onClick={() => void open()}
        >
          {tr('liff.slip.view')}
        </button>
      )}
      {phase === 'failed' ? (
        <p className="g-t-c" role="alert" style={s('margin:0')}>
          {tr('liff.slip.loadFailed')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The PromptPay step: the QR for this order's exact total, the "โอนแล้ว" button (which only tells
 * the shop; staff confirm the money by hand) and the note that says so.
 */
/**
 * Seconds left before another slip may be sent. The server's number (from the polled order) is
 * the source; this only counts it down on screen, so a wrong device clock changes nothing.
 */
function useCooldown(fromServer: number | undefined): number {
  const [left, setLeft] = useState(fromServer ?? 0);
  useEffect(() => {
    setLeft(fromServer ?? 0);
    if (!fromServer) return;
    const timer = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(timer);
  }, [fromServer]);
  return left;
}

function PromptPayPanel({
  order,
  busy,
  slipSent,
  slipStamp,
  onClaim,
  onSlip,
}: {
  order: MyOrder;
  busy: boolean;
  slipSent: boolean;
  slipStamp: number;
  onClaim: () => void;
  onSlip: (file: File) => void;
}) {
  const tr = useT();
  const { api, locale, platform } = useApp();
  const [qr, setQr] = useState<MyQrResponse | null>(null);
  const [failed, setFailed] = useState(false);
  /** The picture as a PNG made on this device, and the `blob:` link the page shows it from. */
  const [image, setImage] = useState<{ png: Blob; src: string } | null>(null);
  const [saved, setSaved] = useState<'downloaded' | null>(null);
  const [viewing, setViewing] = useState(false);
  const showQr = order.actions.showQr;
  const claimed = order.payment?.status === 'claimed';
  const orderId = order.id;
  const cooldown = useCooldown(order.slipRetryAfterSeconds);

  const fetchQr = useCallback(async () => {
    try {
      setQr(await api.qr(orderId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [api, orderId]);

  useEffect(() => {
    if (!showQr) return;
    void fetchQr();
    // The link lasts five minutes: ask for a new one before it dies.
    const timer = setInterval(() => void fetchQr(), 4 * 60_000);
    return () => clearInterval(timer);
  }, [fetchQr, showQr]);

  // The QR is fetched once per link and redrawn as a PNG here. A `blob:` picture is on the page's
  // own origin, so a long-press in LINE's browser can save it; if the fetch fails the page keeps
  // showing the API's own link (the picture still appears, only "save" gets weaker).
  const qrUrl = qr?.url;
  useEffect(() => {
    if (!qrUrl) return;
    let cancelled = false;
    let made: string | null = null;
    void (async () => {
      try {
        const response = await fetch(api.absolute(qrUrl));
        if (!response.ok) throw new Error('qr');
        const png = await toPng(await response.blob());
        if (cancelled) return;
        made = URL.createObjectURL(png);
        setImage({ png, src: made });
      } catch {
        if (!cancelled) setImage(null);
      }
    })();
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [api, qrUrl]);

  /** Share sheet, then a plain download outside LINE, else show the picture large to press and hold. */
  async function save() {
    setSaved(null);
    if (!image) return setViewing(true);
    const outcome = await saveQrImage(
      image.png,
      qrFileName(order.orderNo),
      browserSaveEnv(platform.inLineClient()),
    );
    if (outcome === 'manual') setViewing(true);
    else if (outcome === 'downloaded') setSaved('downloaded');
  }

  const amount = qr ? formatBaht(qr.amountSatang, locale) : '';
  return (
    <>
      {showQr ? (
        <div
          className="g-glass2 g-rise"
          style={s(
            'border-radius:32px;padding:14px;display:flex;flex-direction:column;gap:12px;--d:.1s',
          )}
        >
          <div
            style={s('border-radius:24px;background:#fff;overflow:hidden;box-shadow:var(--sh1)')}
          >
            <div
              style={s(
                'background:#113566;color:#fff;padding:10px 16px;display:flex;align-items:center;justify-content:space-between',
              )}
            >
              <b style={s('font-size:14px;letter-spacing:.04em')}>THAI QR PAYMENT</b>
              <span
                style={s(
                  'font-size:13px;font-weight:600;background:#fff;color:#113566;border-radius:6px;padding:1px 7px',
                )}
              >
                PromptPay
              </span>
            </div>
            <div
              style={s(
                'display:flex;flex-wrap:wrap;gap:12px 16px;align-items:center;justify-content:center;padding:14px 16px',
              )}
            >
              {qr ? (
                <img
                  src={image?.src ?? api.absolute(qr.url)}
                  alt={tr('liff.qr.alt', { amount })}
                  width={158}
                  height={158}
                  style={s('width:158px;height:158px;flex:none')}
                  onError={() => void fetchQr()}
                />
              ) : (
                <div
                  className="g-sunk"
                  style={s(
                    'width:158px;height:158px;flex:none;display:grid;place-items:center;text-align:center;padding:8px',
                  )}
                >
                  {failed ? (
                    <button type="button" className="g-btn g-btn-sm" onClick={() => void fetchQr()}>
                      {tr('liff.qr.refresh')}
                    </button>
                  ) : (
                    <span className="g-t-c" role="status">
                      {tr('liff.loading')}
                    </span>
                  )}
                </div>
              )}
              <div
                style={s(
                  'display:flex;flex-direction:column;gap:2px;flex:1 1 120px;min-width:0;color:#1c1411',
                )}
              >
                <div className="g-t-c">{tr('liff.app.name')}</div>
                <div className="g-t-c" style={s('margin-top:6px')}>
                  {tr('liff.qr.amountLabel')}
                </div>
                <div
                  className="g-num"
                  style={s(
                    `font-size:${amount.length > 8 ? 24 : 32}px;line-height:1.25;font-weight:600;letter-spacing:-.01em`,
                  )}
                >
                  {amount}
                </div>
                <div className="g-t-c">{tr('liff.qr.thisOrderOnly')}</div>
              </div>
            </div>
          </div>
          <div className="g-t-s" style={s('padding:0 6px;color:var(--ink)')}>
            {tr('liff.qr.scanHelp')}
            {qr ? (
              <div className="g-t-c" style={s('margin-top:4px')}>
                {tr('liff.qr.id', { id: qr.promptpayId })}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {claimed ? (
        <Notice icon="clock">
          <b>{tr('liff.order.claimedTitle')}</b>
          <br />
          {tr('liff.order.claimed')}
          {order.actions.attachSlip && !slipSent && order.slipCheck === undefined ? (
            <>
              <br />
              {tr('liff.order.claimedSlip')}
            </>
          ) : null}
        </Notice>
      ) : null}
      {claimed && order.slipCheck ? (
        <Notice icon={order.slipCheck === 'none' ? 'image' : 'clock'}>
          <span role="status">{tr(SLIP_CHECK_KEY[order.slipCheck])}</span>
        </Notice>
      ) : null}
      {slipSent ? (
        <Notice tone="ok" icon="check">
          {tr('liff.slip.sent')}
        </Notice>
      ) : null}

      {order.actions.attachSlip && cooldown > 0 ? (
        <Notice icon="clock">
          <span role="status">
            {tr('liff.error.SLIP_COOLDOWN', { minutes: cooldownMinutes(cooldown) })}
          </span>
        </Notice>
      ) : null}
      {order.slipBlocked && !order.actions.attachSlip ? (
        <Notice icon="bank">
          <span role="status">{tr('liff.error.SLIP_BLOCKED')}</span>
        </Notice>
      ) : null}

      {order.actions.claim || showQr || order.actions.attachSlip ? (
        <div className="g-rise" style={s('display:flex;flex-direction:column;gap:10px;--d:.16s')}>
          {order.actions.claim ? (
            <button
              type="button"
              className="g-btn g-btn-p g-btn-lg g-btn-block"
              disabled={busy}
              aria-busy={busy}
              onClick={onClaim}
            >
              <Gi n="check" />
              {busy ? tr('liff.order.claiming') : tr('liff.order.claim')}
            </button>
          ) : null}
          {showQr || order.actions.attachSlip ? (
            <div style={s('display:flex;gap:10px')}>
              {showQr ? (
                <button
                  type="button"
                  className="g-btn"
                  style={s('flex:1')}
                  disabled={!qr}
                  onClick={() => void save()}
                >
                  <Gi n="download" size="sm" />
                  {tr('liff.qr.save')}
                </button>
              ) : null}
              {order.actions.attachSlip && cooldown > 0 ? (
                <button type="button" className="g-btn" style={s('flex:1')} disabled>
                  <Gi n="image" size="sm" />
                  {tr(order.hasSlip ? 'liff.slip.replace' : 'liff.qr.attachSlip')}
                </button>
              ) : order.actions.attachSlip ? (
                <label className="g-btn" style={s('flex:1;cursor:pointer')} aria-disabled={busy}>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) onSlip(file);
                    }}
                  />
                  <Gi n="image" size="sm" />
                  {tr(order.hasSlip ? 'liff.slip.replace' : 'liff.qr.attachSlip')}
                </label>
              ) : null}
            </div>
          ) : null}
          {order.hasSlip ? <SentSlip orderId={order.id} stamp={slipStamp} /> : null}
          {saved === 'downloaded' ? (
            <p className="g-t-c" role="status" style={s('margin:0;padding:0 6px')}>
              {tr('liff.qr.saved')}
            </p>
          ) : null}
        </div>
      ) : null}
      {viewing && qr ? (
        <QrViewer
          src={image?.src ?? api.absolute(qr.url)}
          alt={tr('liff.qr.alt', { amount })}
          onClose={() => setViewing(false)}
        />
      ) : null}

      <div
        className="g-sunk g-rise"
        style={s('padding:12px 16px;display:flex;gap:10px;align-items:flex-start;--d:.2s')}
      >
        <Gi n="shieldCheck" size="sm" style={{ marginTop: 3, color: 'var(--ink2)' }} />
        <div className="g-t-s" style={s('line-height:1.55')}>
          {tr('liff.order.shopChecks')}
        </div>
      </div>
    </>
  );
}

/** The QR as a large picture on its own, so "press and hold to save" has a big, plain target. */
function QrViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const tr = useT();
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay liff-overlay" role="presentation">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="liff-scrim"
        onClick={onClose}
      />
      <div
        ref={dialog}
        tabIndex={-1}
        className="sheet liff-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={tr('liff.qr.title')}
        style={s('align-items:center;gap:14px')}
      >
        <img
          src={src}
          alt={alt}
          style={s('width:min(100%,360px);aspect-ratio:1;background:#fff;border-radius:16px')}
        />
        <p className="g-t-s" role="status" style={s('margin:0;text-align:center')}>
          {tr('liff.qr.holdToSave')}
        </p>
        <button type="button" className="g-btn g-btn-p g-btn-block" onClick={onClose}>
          {tr('liff.close')}
        </button>
      </div>
    </div>
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
  return (
    <ul style={s('list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px')}>
      {methods.map((m) => (
        <li key={m}>
          <PayButton method={m} current={m === current} busy={busy} onPick={() => onPick(m)} />
        </li>
      ))}
    </ul>
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
