import { formatBaht } from '@sds/i18n';
import { satang } from '@sds/shared';
import { useState } from 'react';
import { Gi } from '../design/icons.tsx';
import { useLayout } from '../design/layout.ts';
import { s } from '../design/style.ts';
import { useLocale, useNow, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { CashPanel } from './CashPanel.tsx';
import { dishArt } from './dish-art.ts';
import { MethodNotes, MethodTiles } from './MethodTiles.tsx';
import { localName } from './names.ts';
import { OfflinePromptPay } from './OfflinePromptPay.tsx';
import { OrderSummary, type SummaryLine } from './OrderSummary.tsx';
import type { QueuedOrder, QueuedPayment } from './outbox-model.ts';
import { Callout, PayFrame, PayPage } from './PayParts.tsx';
import { localMethodOptions, type PayMethod } from './payment-model.ts';
import { isPlatformChannel } from './platform-model.ts';
import { QueueActions, QueueStateBadge } from './QueueActions.tsx';
import { QueuedPaymentView } from './QueuedPaymentView.tsx';

/**
 * An order that is saved on this device and has not reached the server. It is shown from what was
 * saved with it (names, quantities, the estimate), not from the menu, so it opens even after a
 * reload with no connection. It has a temporary number and says so; the real number and total come
 * from the server after the sync, and this page then moves to the real order.
 *
 * Cash can be taken here: the keypad and the change are the usual ones, against the ESTIMATED total,
 * and the cash is saved to the outbox behind the order. So can PromptPay (D-20), when this device
 * holds a PromptPay ID it may still draw a QR from: the QR is for the ESTIMATE and says so, and the
 * payment is saved behind the order when staff say the money is in the bank app. ไทยช่วยไทย is not
 * offered until the order is on the server, and a platform order's payment is recorded after it has
 * synced. Status moves are not available offline.
 */
export function LocalOrderScreen({ item }: { item: QueuedOrder }) {
  const { outbox, promptpay } = useServices();
  const state = useStoreState(outbox);
  useStoreState(promptpay);
  // An old saved ID must stop being offered while this page stays open.
  useNow(30_000);
  const tr = useT();
  const locale = useLocale();
  const phone = useLayout() === 'phone';
  const money = (value: number) => formatBaht(value, locale);
  const [method, setMethod] = useState<PayMethod>('cash');
  const methods = localMethodOptions(promptpay.idStatus());
  const choice = methods.find((m) => m.method === method && m.enabled) ? method : 'cash';
  const payment = state.items.find(
    (i): i is QueuedPayment => i.kind === 'payment' && i.dependsOn === item.id,
  );
  const canTakeCash =
    !payment &&
    item.state !== 'attention' &&
    !isPlatformChannel(item.channel) &&
    item.estimateSatang !== null;
  const lines: SummaryLine[] = item.lines.map((line, index) => ({
    // The lines were saved in order and never change, so the position is a stable key.
    key: String(index),
    name: localName(locale, line.name.th, line.name.en),
    options: line.options.map((option) => localName(locale, option.th, option.en)).join(' · '),
    qty: line.qty,
    note: line.note,
    amount: line.lineTotalSatang === null ? '' : money(line.lineTotalSatang),
    art: dishArt(line.name.th, line.name.en),
    imageUrl: null,
  }));
  const count = item.lines.reduce((sum, line) => sum + line.qty, 0);
  const actions = (
    <>
      <QueueActions item={item} />
      <a className="g-btn" href="#/new">
        <Gi n="plus" />
        {tr('order.detail.takeAnother')}
      </a>
    </>
  );

  return (
    <PayPage labelledBy="order-title">
      <OrderSummary
        title={tr('outbox.order.title', { label: item.label })}
        subtitle={tr('outbox.order.notYet')}
        badges={<QueueStateBadge item={item} />}
        recipient={
          item.recipient
            ? {
                headline: `${item.recipient.building} · ${item.recipient.name}`,
                note: item.recipient.note || null,
              }
            : null
        }
        lines={lines}
        orderNote={item.note}
        countText={tr('pos.orderEntry.itemsCount', { count })}
        totalLabel={tr('pos.orderEntry.estimate')}
        totalText={item.estimateSatang === null ? '' : money(item.estimateSatang)}
        totalHint={tr('outbox.order.estimateHint')}
        below={phone ? undefined : actions}
      />
      <PayFrame
        title={tr(payment ? 'payment.titleDone' : 'payment.title')}
        notes={canTakeCash ? <MethodNotes options={methods} choice={choice} /> : null}
        amountLabel={tr('pos.orderEntry.estimate')}
        amountText={item.estimateSatang === null ? undefined : money(item.estimateSatang)}
        switcher={
          canTakeCash && methods.length > 1 ? (
            <MethodTiles
              options={methods}
              choice={choice}
              name="local-pay-method"
              onChoose={setMethod}
              fill={phone}
            />
          ) : null
        }
      >
        <div className="pay-body">
          {payment ? (
            <QueuedPaymentView item={payment} />
          ) : isPlatformChannel(item.channel) ? (
            <Callout tone="info" icon="store">
              {tr('platform.payment.hint')}
            </Callout>
          ) : item.estimateSatang === null ? (
            <Callout tone="warn" icon="warn">
              {tr('outbox.order.noEstimate')}
            </Callout>
          ) : canTakeCash ? (
            <>
              <Callout tone="info" icon="info" role="status">
                {tr(
                  methods.some((m) => m.method === 'promptpay' && m.enabled)
                    ? 'outbox.onlineOnlyCopay'
                    : 'outbox.onlineOnly',
                )}
              </Callout>
              {choice === 'promptpay' ? (
                <OfflinePromptPay
                  amountSatang={item.estimateSatang}
                  amountKind="estimate"
                  submit={(qr) =>
                    outbox.enqueuePromptpay({
                      target: { entryId: item.id },
                      qrAmountSatang: qr.qrAmountSatang,
                      amountKind: 'estimate',
                      qrTargetMasked: qr.qrTargetMasked,
                      label: item.label,
                    })
                  }
                />
              ) : (
                <CashPanel
                  order={{ id: item.id, totalSatang: satang(item.estimateSatang) }}
                  queue={{
                    estimated: true,
                    submit: (tender) =>
                      outbox.enqueueCash({
                        target: { entryId: item.id },
                        tenderedSatang: tender,
                        totalSatang: item.estimateSatang,
                        label: item.label,
                      }),
                  }}
                />
              )}
            </>
          ) : null}
        </div>
      </PayFrame>
      {phone ? (
        <div style={s('display:flex;flex-direction:column;gap:12px;padding-bottom:8px')}>
          {actions}
        </div>
      ) : null}
    </PayPage>
  );
}
