import { formatBaht } from '@sds/i18n';
import { satang } from '@sds/shared';
import { useLocale, useT } from '../ui/hooks.ts';
import type { QueuedPayment } from './outbox-model.ts';
import { cashView } from './payment-model.ts';
import { QueueActions, QueueStateBadge } from './QueueActions.tsx';

/**
 * The cash that was taken while offline and is waiting to be sent: what was received and the change
 * (from the shared cash calculation, against the total the keypad showed), its state, and the
 * reminder that it does not count as paid until the server confirms it. The server decides: it may
 * still refuse (the real total can differ from an estimate), and then the entry needs attention.
 */
export function QueuedCash({ item }: { item: QueuedPayment }) {
  const tr = useT();
  const locale = useLocale();
  const tendered = satang(item.tenderedSatang);
  const view = item.totalSatang === null ? null : cashView(satang(item.totalSatang), tendered);
  const money = (value: number) => formatBaht(value, locale);
  return (
    <section className="qcash" aria-labelledby={`qcash-${item.id}`}>
      <h3 id={`qcash-${item.id}`} className="cash__title">
        {tr('outbox.cash.title')}
      </h3>
      <p className="qcash__summary money">
        {tr('outbox.cash.summary', {
          tendered: money(item.tenderedSatang),
          change: view === null || view.change === null ? '-' : money(view.change),
        })}
      </p>
      <QueueStateBadge item={item} />
      <p className="hint">{tr('outbox.cash.waiting')}</p>
      <QueueActions item={item} />
    </section>
  );
}
