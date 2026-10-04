import { formatBaht } from '@sds/i18n';
import type { OrderDto, PaymentDto } from '@sds/shared';
import type { ReactNode } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useEntities, useLocale, useT } from '../ui/hooks.ts';
import { PaymentMoves } from './PaymentMoves.tsx';
import { Callout, PaySteps, usePayDims } from './PayParts.tsx';
import { copayEstimate, govCopayScheme, type PaymentActions } from './payment-model.ts';
import './pay-glass.css';

/**
 * The guided steps for ไทยช่วยไทย พลัส (docs/02 §4.3, 04 §3.2), shown before the payment exists and
 * while it waits. Two columns as in the design: the face-to-face warning and the four steps, and
 * the money. `children` goes at the foot of the money column (the confirm, once it is started).
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
  children,
}: {
  order: OrderDto;
  /** The waiting payment, once it has been started. */
  payment: PaymentDto | undefined;
  children?: ReactNode;
}) {
  const tr = useT();
  const locale = useLocale();
  const dims = usePayDims();
  const phone = dims.layout === 'phone';
  const scheme = govCopayScheme(useEntities().settings);
  const estimate = copayEstimate(order.totalSatang, payment, scheme);
  const money = (value: number) => formatBaht(value, locale);
  const amount = money(order.totalSatang);
  const started = payment !== undefined;

  return (
    <div
      className="g-rise pay-grow"
      data-testid="copay"
      style={s(
        `display:flex;gap:${dims.gap}px;width:100%;min-width:0;${phone ? 'flex-direction:column;' : ''}`,
      )}
    >
      <div style={s('flex-grow:1;min-width:0;display:flex;flex-direction:column;gap:14px')}>
        <div
          style={s(
            'display:flex;gap:10px;align-items:flex-start;padding:14px 16px;border-radius:20px;background:var(--amber-soft);color:var(--amber-ink)',
          )}
        >
          <Gi n="warn" style={s('margin-top:2px;flex:none')} />
          <div className="g-t-3" style={s('font-size:15px;line-height:1.5')}>
            {tr('payment.govCopay.faceToFace')}
            <br />
            <span style={s('font-weight:400')}>{tr('payment.govCopay.faceToFaceSub')}</span>
          </div>
        </div>
        <div className="g-sunk" style={s('padding:18px 20px')}>
          <PaySteps
            gap={16}
            steps={[
              {
                state: 'done',
                title: tr('payment.govCopay.stepWindow'),
                sub: tr('payment.govCopay.stepWindowSub'),
              },
              {
                state: started ? 'done' : 'now',
                title: tr('payment.govCopay.step1', { amount }),
              },
              {
                state: started ? 'now' : 'todo',
                title: tr('payment.govCopay.step2'),
                sub: tr('payment.govCopay.step2Hint'),
              },
              {
                state: 'todo',
                title: tr('payment.govCopay.step3'),
                sub: tr('payment.govCopay.step4Sub'),
              },
            ]}
          />
        </div>
        <Callout tone="info" icon="bank">
          {tr('payment.govCopay.noQr')}
        </Callout>
      </div>
      <div
        style={s(
          `${phone ? '' : `width:${dims.keypad}px;flex:none;`}display:flex;flex-direction:column;gap:14px;min-width:0`,
        )}
      >
        <div
          className="g-sunk"
          style={s('padding:18px 20px;display:flex;flex-direction:column;gap:10px')}
        >
          <div className="g-t-c">{tr('payment.govCopay.typeAmount')}</div>
          <div
            className="g-num"
            data-amount="typed"
            style={s('font-size:48px;line-height:1.25;font-weight:600;letter-spacing:-.015em')}
          >
            {amount}
          </div>
          {estimate ? (
            <>
              <hr className="g-hair" />
              <div
                className="g-t-c"
                style={s('display:flex;gap:6px;align-items:center;color:var(--amber-ink)')}
              >
                <Gi n="info" size="sm" />
                {tr('payment.govCopay.estimateLabel')}
              </div>
              <div className="g-t-s" style={s('display:flex;justify-content:space-between')}>
                <span>{tr('payment.govCopay.govShare')}</span>
                <span className="g-num" data-amount="figure">
                  {money(estimate.govShare)}
                </span>
              </div>
              <div className="g-t-s" style={s('display:flex;justify-content:space-between')}>
                <span>{tr('payment.govCopay.customerShare')}</span>
                <span className="g-num" data-amount="figure">
                  {money(estimate.customerShare)}
                </span>
              </div>
              {estimate.capped ? (
                <div className="g-t-c">{tr('payment.govCopay.capped')}</div>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="g-t-c" style={s('padding:0 6px')}>
          {tr('payment.govCopay.settingsNote')}
        </div>
        {children}
      </div>
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
    <section
      aria-labelledby="govpay-title"
      className="pay-grow"
      style={s('width:100%;min-width:0;display:flex')}
    >
      <h3 id="govpay-title" className="visually-hidden">
        {tr('payment.govCopay.title')}
      </h3>
      <GovCopaySteps order={order} payment={payment}>
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
      </GovCopaySteps>
    </section>
  );
}
