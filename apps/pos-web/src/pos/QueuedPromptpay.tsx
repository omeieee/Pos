import { formatBaht } from '@sds/i18n';
import { s } from '../design/style.ts';
import { useLocale, useT } from '../ui/hooks.ts';
import { amountKindKey } from './offline-promptpay-model.ts';
import type { QueuedPromptpayPayment } from './outbox-model.ts';
import { Callout } from './PayParts.tsx';
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
    <section
      aria-labelledby={`qpp-${item.id}`}
      className="g-sunk"
      style={s(
        'padding:18px 20px;display:flex;flex-direction:column;gap:12px;width:100%;min-width:0',
      )}
    >
      <h3 id={`qpp-${item.id}`} className="g-t-3" style={s('margin:0')}>
        {tr('outbox.promptpay.title')}
      </h3>
      <p className="g-num g-t-2" style={s('margin:0')}>
        {tr('outbox.promptpay.summary', {
          amount: money(item.qrAmountSatang),
          kind: tr(amountKindKey(item.amountKind)),
        })}
      </p>
      {item.serverAmountSatang !== null ? (
        <Callout tone="warn" role="status">
          {tr('outbox.promptpay.serverAmount', { amount: money(item.serverAmountSatang) })}
        </Callout>
      ) : null}
      <div style={s('display:flex;gap:8px;flex-wrap:wrap')}>
        <QueueStateBadge item={item} />
      </div>
      <p className="g-t-c" style={s('margin:0')}>
        {tr(item.confirmOnly ? 'outbox.promptpay.confirmOnly' : 'outbox.promptpay.waiting')}
      </p>
      {item.state === 'attention' ? (
        <Callout tone="bad" role="alert">
          {tr('outbox.promptpay.moneyTaken')}
        </Callout>
      ) : null}
      <QueueActions item={item} />
    </section>
  );
}
