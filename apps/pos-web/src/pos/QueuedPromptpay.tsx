import { formatBaht } from '@sds/i18n';
import { useLocale, useT } from '../ui/hooks.ts';
import { amountKindKey } from './offline-promptpay-model.ts';
import type { QueuedPromptpayPayment } from './outbox-model.ts';
import { QueueActions, QueueStateBadge } from './QueueActions.tsx';

/**
 * The PromptPay payment that was taken while offline and is waiting to be sent: the amount the QR
 * showed (and whether it was an estimate), its state, and the reminder that it does not count as
 * paid until the server confirms it. If the server charged another amount, or the shop's account
 * changed after the QR was shown, the entry is not confirmed and says that money was taken and a
 * person must reconcile.
 */
export function QueuedPromptpay({ item }: { item: QueuedPromptpayPayment }) {
  const tr = useT();
  const locale = useLocale();
  const money = (value: number) => formatBaht(value, locale);
  return (
    <section className="qcash" aria-labelledby={`qpp-${item.id}`}>
      <h3 id={`qpp-${item.id}`} className="cash__title">
        {tr('outbox.promptpay.title')}
      </h3>
      <p className="qcash__summary money">
        {tr('outbox.promptpay.summary', {
          amount: money(item.qrAmountSatang),
          kind: tr(amountKindKey(item.amountKind)),
        })}
      </p>
      {item.serverAmountSatang !== null ? (
        <p className="notice" role="status">
          {tr('outbox.promptpay.serverAmount', { amount: money(item.serverAmountSatang) })}
        </p>
      ) : null}
      <QueueStateBadge item={item} />
      <p className="hint">
        {tr(item.confirmOnly ? 'outbox.promptpay.confirmOnly' : 'outbox.promptpay.waiting')}
      </p>
      {item.state === 'attention' ? (
        <p className="notice oqr__banner" role="alert">
          {tr('outbox.promptpay.moneyTaken')}
        </p>
      ) : null}
      <QueueActions item={item} />
    </section>
  );
}
