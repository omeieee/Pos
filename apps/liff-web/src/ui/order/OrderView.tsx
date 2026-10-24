/**
 * Order page: what the customer sees for one order (status, items, payment, actions).
 */
import { formatBaht, type Locale } from '@sds/i18n';
import type { AppOpenOrder, AppPayMethod, MyOrder, SlipNeedsCombine } from '@sds/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure, type SlipMode } from '../../api/client.ts';
import { Gi } from '../../design/icons.tsx';
import { s } from '../../design/style.ts';
import { createRequestIds } from '../../model/checkout.ts';
import { telHref } from '../../model/contact.ts';
import { cancelReasonView, openOrderFor } from '../../model/open-orders.ts';
import { markPaidPopupSeen, paidPopupSeen, shouldShowPaidPopup } from '../../model/paid-popup.ts';
import { canDownloadReceipt, receiptFileName, receiptHtml } from '../../model/receipt.ts';
import {
  msUntilMinShown,
  type SlipProgressPhase,
  slipProgressPhase,
  slipSlowHintShown,
} from '../../model/slip-progress.ts';
import { awaitsTransferConfirmation, isPaymentRejected, orderSteps } from '../../model/steps.ts';
import { errorText, useApp, useT } from '../app-context.tsx';
import { BarButton, Body, Header, Notice } from '../Chrome.tsx';
import { PayButton } from '../PayOption.tsx';
import { PromptPayPanel } from './PromptPayPanel.tsx';
import { PaidPopup, SlipProgressPopup } from './popups.tsx';
import { CancelSheet, CombineSheet, MismatchSheet } from './sheets.tsx';
import { PAYMENT_BADGE, PAYMENT_KEY, STATUS_BADGE, STATUS_KEY, STEP_KEY } from './status-maps.ts';

/** The loaded order page. Split from the polling shell so it can be rendered on its own. */
export function OrderView({
  order,
  setOrder,
  flag,
  shopPhone,
  onSlipSent,
  onEdit,
}: {
  order: MyOrder;
  setOrder: (order: MyOrder) => void;
  flag: string | null;
  shopPhone: string | null;
  /** Called when a slip upload succeeds, so the page can poll faster. */
  onSlipSent?: (startedAt: number) => void;
  /** Called with the order lines and version when the customer taps change dishes. */
  onEdit?: (order: AppOpenOrder) => void;
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
  /** The slip the server asked about (its amount adds up to several orders), kept to be re-sent. */
  const [combine, setCombine] = useState<{ file: File; info: SlipNeedsCombine } | null>(null);
  /** The customer would not combine: the slip waits for send-to-the-shop or a new picture. */
  const [mismatch, setMismatch] = useState<File | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  /** One key per cancel attempt, kept on a retry so a lost answer never cancels twice. */
  const cancelKeys = useRef(createRequestIds()).current;
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

  function sendSlip(file: File, mode?: SlipMode): Promise<void> {
    progressOwnsPaid.current = true;
    return act(
      () => api.attachSlip(order.id, file, mode),
      (e) => {
        // The amount adds up to several orders: ask, and keep the picture for the answer.
        if (e instanceof ApiFailure && e.status === 409 && e.combine) {
          setCombine({ file, info: e.combine });
          return true;
        }
        return false;
      },
    ).then((ok) => {
      if (!ok) {
        // Refused (a wait, a block, a bad file) or a question is open: no check is running.
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

  /** `onError` returns true when it handled the failure itself (no message under the buttons). */
  async function act(
    run: () => Promise<MyOrder>,
    onError?: (error: unknown) => boolean,
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      setOrder(await run());
      setChanging(false);
      return true;
    } catch (e) {
      if (!onError?.(e)) setError(errorText(tr, e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** The open list has what the order page lacks: the version and the dish ids. */
  async function openOrder(): Promise<AppOpenOrder | null> {
    const found = openOrderFor((await api.openOrders()).orders, order.id);
    if (!found) setError(tr('liff.error.ORDER_NOT_EDITABLE'));
    return found ?? null;
  }

  async function startEdit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const found = await openOrder();
      if (found) onEdit?.(found);
    } catch (e) {
      setError(errorText(tr, e));
    } finally {
      setBusy(false);
    }
  }

  async function cancelOrder() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const found = await openOrder();
      if (found) {
        const key = cancelKeys.forSignature(`${found.id}:${found.version}`);
        setOrder(await api.cancelOrder(found.id, found.version, key));
        cancelKeys.reset();
      }
    } catch (e) {
      setError(errorText(tr, e));
    } finally {
      setBusy(false);
      setCancelOpen(false);
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
  const reason = cancelReasonView(order);
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
              {reason ? (
                <>
                  <br />
                  <span data-testid="cancel-reason">
                    {reason.key === 'merged'
                      ? tr('liff.cancel.reason.merged', { orderNo: reason.orderNo })
                      : tr(`liff.cancel.reason.${reason.key}`)}
                  </span>
                </>
              ) : null}
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
                  // A new payment or total (edit, combine) needs a QR for the new amount at once.
                  key={`${order.payment?.id ?? ''}:${order.totalSatang}`}
                  order={order}
                  busy={busy}
                  onClaim={() => void act(() => api.claim(order.id))}
                  slipSent={slipSent}
                  slipStamp={slipStamp}
                  onSlip={(file) => void sendSlip(file)}
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
              {(order.actions.edit && onEdit) || order.actions.cancel ? (
                <div style={s('display:flex;gap:10px')}>
                  {order.actions.edit && onEdit ? (
                    <button
                      type="button"
                      className="g-btn"
                      style={s('flex:1')}
                      disabled={busy}
                      aria-busy={busy}
                      onClick={() => void startEdit()}
                    >
                      {busy ? tr('liff.edit.opening') : tr('liff.edit.button')}
                    </button>
                  ) : null}
                  {order.actions.cancel ? (
                    <button
                      type="button"
                      className="g-btn"
                      style={s('flex:1')}
                      disabled={busy}
                      onClick={() => setCancelOpen(true)}
                    >
                      {tr('liff.cancel.button')}
                    </button>
                  ) : null}
                </div>
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
        <SlipProgressPopup
          phase={phase}
          orderNo={order.orderNo}
          slowHint={slipSlowHintShown(Math.max(0, now - (slipProgress ?? now)), phase)}
          onClose={closeSlipProgress}
        />
      ) : null}
      {cancelOpen ? (
        <CancelSheet
          orderNo={order.orderNo}
          busy={busy}
          onConfirm={() => void cancelOrder()}
          onClose={() => setCancelOpen(false)}
        />
      ) : null}
      {combine ? (
        <CombineSheet
          totalSatang={combine.info.totalSatang}
          orderNos={combine.info.orderNos}
          busy={busy}
          onYes={() => void sendSlip(combine.file, 'combine').then(() => setCombine(null))}
          onNo={() => {
            setMismatch(combine.file);
            setCombine(null);
          }}
        />
      ) : null}
      {mismatch ? (
        <MismatchSheet
          busy={busy}
          onReview={() => void sendSlip(mismatch, 'review').then(() => setMismatch(null))}
          onPick={(file) => {
            setMismatch(null);
            void sendSlip(file);
          }}
          onClose={() => setMismatch(null)}
        />
      ) : null}
      {paidPopup && !phase ? (
        <PaidPopup orderNo={order.orderNo} onClose={() => setPaidPopup(false)} />
      ) : null}
    </>
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
