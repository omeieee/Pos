import { formatBaht } from '@sds/i18n';
import type { OrderDto, PaymentDto } from '@sds/shared';
import { useEffect, useRef, useState } from 'react';
import { Brand } from '../ui/Brand.tsx';
import { useLocale, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { Modal } from '../ui/Modal.tsx';
import { PaymentMoves } from './PaymentMoves.tsx';
import { PromptPayQr } from './PromptPayQr.tsx';
import type { PaymentActions } from './payment-model.ts';

/** How long staff hold the button to leave the customer view: a customer's tap must not. */
const HOLD_MS = 1000;

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
  const [customerView, setCustomerView] = useState(false);
  const amount = formatBaht(order.totalSatang, locale);

  return (
    <section className="pp" aria-labelledby="pp-title">
      <h3 id="pp-title" className="pp__title">
        {tr('payment.promptpay.title')}
      </h3>
      {payment.status === 'pending' ? (
        <>
          <PromptPayQr
            paymentId={payment.id}
            alt={tr('payment.promptpay.qrAlt', { amount })}
            paymentTarget={payment.promptpayTargetMasked}
            showTarget
          />
          <button type="button" className="btn btn-block" onClick={() => setCustomerView(true)}>
            <Icon name="qr" />
            {tr('payment.promptpay.showCustomer')}
          </button>
        </>
      ) : null}
      <p className="muted">{tr('payment.promptpay.checkBank', { amount })}</p>
      <PaymentMoves
        order={order}
        payment={payment}
        actions={actions}
        referenceLabel="payment.reference"
        showClaim
        notFoundLabel="payment.promptpay.notFound"
      >
        {children}
      </PaymentMoves>
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
    <Modal labelledBy="cust-title" onClose={onClose} variant="customer">
      <div className="cust">
        <div className="cust__info">
          <Brand />
          <h2 id="cust-title" className="visually-hidden">
            {tr('payment.promptpay.scanToPay')}
          </h2>
          <div>
            <p className="cust__label">{tr('payment.amountDue')}</p>
            <p className="cust__big money">{amount}</p>
          </div>
          <ul className="cust__hints">
            <li>
              <Icon name="qr" />
              {tr('payment.promptpay.customer.scanAny')}
            </li>
            <li>
              <Icon name="check-circle" />
              {tr('payment.promptpay.customer.amountIncluded')}
            </li>
          </ul>
          <p className="muted">
            {tr('payment.promptpay.customer.order', { orderNo: order.orderNo })}
          </p>
        </div>
        <div className="cust__qr">
          <PromptPayQr
            paymentId={payment.id}
            alt={tr('payment.promptpay.qrAlt', { amount })}
            showTarget={false}
          />
        </div>
      </div>
      <button
        type="button"
        className="btn btn-soft btn-block cust__exit"
        onPointerDown={start}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onContextMenu={(event) => event.preventDefault()}
      >
        {tr('payment.promptpay.customer.close')}
      </button>
    </Modal>
  );
}
