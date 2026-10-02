import { formatBaht } from '@sds/i18n';
import type { OrderDto, PaymentDto } from '@sds/shared';
import { useEntities, useLocale, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { PaymentMoves } from './PaymentMoves.tsx';
import { copayEstimate, govCopayScheme, type PaymentActions } from './payment-model.ts';

/**
 * The guided steps for ไทยช่วยไทย พลัส (docs/02 §4.3, 04 §3.2), shown before the payment exists and
 * while it waits.
 *
 * - The FULL order total is the amount to type into ถุงเงิน, in large type: the app decides the real
 *   split, so staff never type the customer's share.
 * - The split shown is an ESTIMATE and is labelled as one every time. Before the payment exists it
 *   is the shared estimate for the server total; afterwards it is the server's own figures.
 * - Staff create the ถุงเงิน QR themselves, per transaction, with the customer standing there. This
 *   app never makes it, shows it or sends it (it must not go through LINE).
 */
export function GovCopaySteps({
  order,
  payment,
}: {
  order: OrderDto;
  /** The waiting payment, once it has been started. */
  payment: PaymentDto | undefined;
}) {
  const tr = useT();
  const locale = useLocale();
  const scheme = govCopayScheme(useEntities().settings);
  const estimate = copayEstimate(order.totalSatang, payment, scheme);
  const money = (value: number) => formatBaht(value, locale);
  const amount = money(order.totalSatang);
  const started = payment !== undefined;

  return (
    <div className="copay">
      <div className="card copay__card">
        <div>
          <p className="muted small">{tr('payment.govCopay.typeAmount')}</p>
          <p className="amount-hero amount-hero--typed money">{amount}</p>
        </div>
        {estimate ? (
          <div className="copay__split">
            <p className="copay__estimate">
              <Icon name="info" />
              {tr('payment.govCopay.estimateLabel')}
            </p>
            <div className="sumrow">
              <span className="muted">{tr('payment.govCopay.govShare')}</span>
              <span className="money strong copay__figure">{money(estimate.govShare)}</span>
            </div>
            <div className="sumrow">
              <span className="muted">{tr('payment.govCopay.customerShare')}</span>
              <span className="money strong copay__figure">{money(estimate.customerShare)}</span>
            </div>
            {estimate.capped ? <p className="hint">{tr('payment.govCopay.capped')}</p> : null}
          </div>
        ) : null}
      </div>
      <ol className="steps">
        <li className={started ? 'done' : 'now'}>
          <div>{tr('payment.govCopay.step1', { amount })}</div>
        </li>
        <li className={started ? 'now' : undefined}>
          <div>
            {tr('payment.govCopay.step2')}
            <div className="small muted">{tr('payment.govCopay.step2Hint')}</div>
          </div>
        </li>
        <li>
          <div>{tr('payment.govCopay.step3')}</div>
        </li>
      </ol>
      <p className="notice">
        <Icon name="store" />
        <span>{tr('payment.govCopay.noQr')}</span>
      </p>
    </div>
  );
}

/** A started ไทยช่วยไทย payment: the steps, the optional ถุงเงิน reference and the confirm. */
export function GovCopayPanel({
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
  return (
    <section className="govpay" aria-labelledby="govpay-title">
      <h3 id="govpay-title" className="govpay__title">
        {tr('payment.govCopay.title')}
      </h3>
      <GovCopaySteps order={order} payment={payment} />
      <PaymentMoves
        order={order}
        payment={payment}
        actions={actions}
        referenceLabel="payment.govCopay.reference"
        showClaim={false}
        notFoundLabel="payment.promptpay.notFound"
      >
        {children}
      </PaymentMoves>
    </section>
  );
}
