import { formatBaht } from '@sds/i18n';
import type { OrderDto, PaymentDto } from '@sds/shared';
import { defaultBrand } from '@sds/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useLocale, useT } from '../ui/hooks.ts';
import { PaymentMoves } from './PaymentMoves.tsx';
import { Callout, PayModal, PaySteps, usePayDims } from './PayParts.tsx';
import { PromptPayQr } from './PromptPayQr.tsx';
import type { PaymentActions } from './payment-model.ts';
import './pay-glass.css';

/** How long staff hold the button to leave the customer view: a customer's tap must not. */
const HOLD_MS = 1000;

/**
 * The white Thai QR card of the design: the blue "THAI QR PAYMENT" strip, the picture, the shop
 * and the amount. The picture is whatever the caller puts in (the signed QR, or the stand-in shown
 * before the payment exists).
 */
export function QrCard({
  width,
  amount,
  size,
  children,
}: {
  width: number | string;
  /** The amount under the picture; left out where the amount is already written beside the card. */
  amount?: string;
  /** The room for the picture, which sets the type of the amount too. */
  size?: 'big';
  children: ReactNode;
}) {
  const tr = useT();
  const big = size === 'big';
  return (
    <div
      style={s(
        `width:${typeof width === 'number' ? `${width}px` : width};max-width:100%;flex:none;border-radius:28px;background:#fff;box-shadow:var(--sh2);overflow:hidden;display:flex;flex-direction:column;color:var(--ink)`,
      )}
    >
      <div
        style={s(
          'background:#113566;color:#fff;padding:12px 18px;display:flex;align-items:center;justify-content:space-between;gap:8px',
        )}
      >
        <b style={s('font-size:14px;letter-spacing:.03em;white-space:nowrap')}>
          {tr('payment.promptpay.thaiQr')}
        </b>
        <span
          style={s(
            'font-size:14px;font-weight:600;background:#fff;color:#113566;border-radius:6px;padding:1px 8px;white-space:nowrap',
          )}
        >
          {tr('payment.promptpay.brand')}
        </span>
      </div>
      <div style={s('padding:16px 18px 6px;display:grid;place-items:center')}>{children}</div>
      <div style={s('padding:0 18px 18px;text-align:center')}>
        <div className="g-t-c">{defaultBrand.name}</div>
        {amount ? (
          <div
            className="g-num"
            style={s(
              `font-size:${big ? 44 : 34}px;line-height:1.3;font-weight:600;letter-spacing:-.01em`,
            )}
          >
            {amount}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A waiting PromptPay payment. While it is pending: the QR (a fresh link every time it is shown),
 * the masked target to compare with the bank app, and a customer view to turn the iPad around.
 * Once the customer says they paid (or LINE says so) it is claimed: no QR, the steps to check the
 * bank app, and staff confirm by hand. Confirming is never done by the customer view.
 */
export function PromptPayPanel({
  order,
  payment,
  actions,
  children,
}: {
  order: OrderDto;
  payment: PaymentDto;
  actions: PaymentActions;
  children?: React.ReactNode;
}) {
  const tr = useT();
  const locale = useLocale();
  const dims = usePayDims();
  const phone = dims.layout === 'phone';
  const [customerView, setCustomerView] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const amount = formatBaht(order.totalSatang, locale);
  const pending = payment.status === 'pending';
  const recorded = payment.promptpayTargetMasked;
  const changed = recorded != null && target !== null && recorded !== target;

  return (
    <section
      aria-labelledby="pp-title"
      className="g-rise pay-grow"
      style={s(
        `display:flex;gap:${dims.gap}px;width:100%;min-width:0;${phone ? 'flex-direction:column;' : ''}`,
      )}
    >
      <h3 id="pp-title" className="visually-hidden">
        {tr('payment.promptpay.title')}
      </h3>
      {pending ? (
        <div style={s(phone ? 'display:grid;place-items:center' : 'display:flex')}>
          <QrCard width={phone ? 340 : dims.qr} amount={amount}>
            <PromptPayQr
              paymentId={payment.id}
              alt={tr('payment.promptpay.qrAlt', { amount })}
              size={phone ? 250 : dims.layout === 'side' ? 250 : 220}
              onTarget={setTarget}
            />
          </QrCard>
        </div>
      ) : null}
      <div style={s('flex-grow:1;display:flex;flex-direction:column;gap:14px;min-width:0')}>
        <div
          className="g-sunk"
          style={s(
            'padding:16px 18px;display:flex;flex-direction:column;gap:10px;position:relative;overflow:hidden',
          )}
        >
          <div style={s('display:flex;align-items:center;gap:10px;flex-wrap:wrap')}>
            <span className="g-badge g-b-info">
              <Gi n="clock" />
              {tr(pending ? 'payment.promptpay.waitingScan' : 'payment.status.claimed')}
            </span>
            {target ? (
              <span className="g-t-c g-num" style={s('margin-left:auto')}>
                {tr('payment.promptpay.target', { target })}
              </span>
            ) : null}
          </div>
          {pending ? (
            <div
              aria-hidden="true"
              style={s(
                'height:6px;border-radius:3px;background:rgba(36,87,184,.14);overflow:hidden',
              )}
            >
              <div
                className="g-shimmer"
                style={s(
                  'height:100%;width:100%;background-color:#2457b8;background-blend-mode:screen',
                )}
              />
            </div>
          ) : null}
          <div className="g-t-s">
            {pending
              ? tr('payment.promptpay.qrBound', { amount })
              : tr('payment.promptpay.checkBank', { amount })}
          </div>
          {target ? <div className="g-t-c">{tr('payment.promptpay.targetHint')}</div> : null}
          {changed ? (
            <Callout tone="warn" role="status">
              {tr('payment.promptpay.targetChanged', { target })}
            </Callout>
          ) : null}
        </div>
        <div className="g-sunk" style={s('padding:16px 18px')}>
          <PaySteps
            steps={[
              {
                state: 'done',
                title: tr('payment.promptpay.step1'),
                sub: tr('payment.promptpay.step1Sub', { amount }),
              },
              {
                state: 'now',
                title: tr('payment.promptpay.step2'),
                sub: tr('payment.promptpay.step2Sub'),
              },
              {
                state: 'todo',
                title: tr('payment.promptpay.step3'),
                sub: tr('payment.promptpay.step3Sub'),
              },
            ]}
          />
        </div>
        <PaymentMoves
          order={order}
          payment={payment}
          actions={actions}
          referenceLabel="payment.reference"
          showClaim
          notFoundLabel="payment.promptpay.notFound"
          lead={
            pending ? (
              <button type="button" className="g-btn pay-sub" onClick={() => setCustomerView(true)}>
                <Gi n="monitor" />
                {tr('payment.promptpay.showCustomer')}
              </button>
            ) : null
          }
        >
          {children}
        </PaymentMoves>
      </div>
      {customerView ? (
        <CustomerView
          order={order}
          payment={payment}
          amount={amount}
          onClose={() => setCustomerView(false)}
        />
      ) : null}
    </section>
  );
}

/**
 * Before the payment exists: the same two columns with the QR card holding a stand-in (never a
 * picture that looks like a real code) and the steps still ahead. The button that makes the
 * payment sits below, in `StartPanel`.
 */
export function PromptPayStart({ order }: { order: OrderDto }) {
  const tr = useT();
  const locale = useLocale();
  const dims = usePayDims();
  const phone = dims.layout === 'phone';
  const amount = formatBaht(order.totalSatang, locale);
  return (
    <div
      className="g-rise pay-grow"
      style={s(
        `display:flex;gap:${dims.gap}px;width:100%;min-width:0;${phone ? 'flex-direction:column;' : ''}`,
      )}
    >
      <div style={s(phone ? 'display:grid;place-items:center' : 'display:flex')}>
        <QrCard width={phone ? 340 : dims.qr} amount={amount}>
          <div
            style={s(
              `width:min(100%,${phone || dims.layout === 'side' ? 250 : 220}px);aspect-ratio:1;border-radius:18px;border:2px dashed rgba(70,35,20,.2);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:18px;text-align:center;color:var(--ink3)`,
            )}
          >
            <Gi n="qrBig" size="lg" />
            <span className="g-t-s">{tr('payment.promptpay.notYetShown', { amount })}</span>
          </div>
        </QrCard>
      </div>
      <div style={s('flex-grow:1;display:flex;flex-direction:column;gap:14px;min-width:0')}>
        <div className="g-sunk" style={s('padding:16px 18px')}>
          <PaySteps
            steps={[
              {
                state: 'now',
                title: tr('payment.promptpay.step1'),
                sub: tr('payment.promptpay.step1Sub', { amount }),
              },
              {
                state: 'todo',
                title: tr('payment.promptpay.step2'),
                sub: tr('payment.promptpay.step2Sub'),
              },
              {
                state: 'todo',
                title: tr('payment.promptpay.step3'),
                sub: tr('payment.promptpay.step3Sub'),
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The iPad turned to the customer: the amount in big type, the QR, and nothing that confirms. It
 * asks for its own fresh QR link. Staff leave it with Escape or by holding the button for a second.
 */
function CustomerView({
  order,
  payment,
  amount,
  onClose,
}: {
  order: OrderDto;
  payment: PaymentDto;
  amount: string;
  onClose: () => void;
}) {
  const tr = useT();
  const phone = usePayDims().layout === 'phone';
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  const start = () => {
    cancel();
    timer.current = setTimeout(onClose, HOLD_MS);
  };
  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <PayModal labelledBy="cust-title" onClose={onClose} variant="customer">
      <div
        className="g-bg"
        style={s(
          `flex:1;min-height:0;display:grid;${phone ? 'grid-template-rows:auto auto;' : 'grid-template-columns:1fr 1fr;'}gap:28px;align-items:center;padding:${phone ? 8 : 28}px;position:relative;overflow:hidden;border-radius:26px`,
        )}
      >
        <div style={s('display:flex;flex-direction:column;gap:22px;min-width:0')}>
          <span className="g-t-3" style={s('display:inline-flex;align-items:center;gap:10px')}>
            <img src="/mark.svg" alt="" width={32} height={32} style={s('border-radius:10px')} />
            {defaultBrand.name}
          </span>
          <h2 id="cust-title" className="visually-hidden">
            {tr('payment.promptpay.scanToPay')}
          </h2>
          <div>
            <p className="g-t-c" style={s('margin:0')}>
              {tr('payment.amountDue')}
            </p>
            <p
              className="g-num"
              style={s(
                `margin:0;font-size:${phone ? 56 : 92}px;line-height:1.15;font-weight:600;letter-spacing:-.02em`,
              )}
            >
              {amount}
            </p>
          </div>
          <ul
            style={s(
              'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px',
            )}
          >
            <li className="g-t-3" style={s('display:flex;align-items:center;gap:10px')}>
              <Gi n="qrBig" />
              {tr('payment.promptpay.customer.scanAny')}
            </li>
            <li className="g-t-3" style={s('display:flex;align-items:center;gap:10px')}>
              <Gi n="check" />
              {tr('payment.promptpay.customer.amountIncluded')}
            </li>
          </ul>
          <p className="g-t-s" style={s('margin:0')}>
            {tr('payment.promptpay.customer.order', { orderNo: order.orderNo })}
          </p>
        </div>
        <div style={s('display:grid;place-items:center;min-width:0')}>
          <QrCard width={phone ? 320 : 460} size="big">
            <PromptPayQr
              paymentId={payment.id}
              alt={tr('payment.promptpay.qrAlt', { amount })}
              size={phone ? 250 : 380}
            />
          </QrCard>
        </div>
      </div>
      <button
        type="button"
        className="g-btn g-btn-block"
        style={s(
          'flex:none;margin:12px 0 0;-webkit-touch-callout:none;user-select:none;touch-action:none',
        )}
        onPointerDown={start}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(event) => event.preventDefault()}
      >
        {tr('payment.promptpay.customer.close')}
      </button>
    </PayModal>
  );
}
