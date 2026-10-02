import { formatBaht } from '@sds/i18n';
import { satang } from '@sds/shared';
import { useState } from 'react';
import { useLocale, useServices, useT } from '../ui/hooks.ts';
import { Modal } from '../ui/Modal.tsx';
import { CashPanel } from './CashPanel.tsx';
import type { QueuedCashPayment } from './outbox-model.ts';
import { cashView } from './payment-model.ts';
import { QueueActions, QueueStateBadge } from './QueueActions.tsx';

/**
 * The cash that was taken while offline and is waiting to be sent: what was received and the change
 * (from the shared cash calculation, against the total the keypad showed), its state, and the
 * reminder that it does not count as paid until the server confirms it. The server decides: it may
 * still refuse (the real total can differ from an estimate), and then the entry needs attention.
 *
 * While the entry has not been sent the amount can be corrected (the same keypad); the entry is
 * replaced, never doubled. After a send was tried it is frozen: the first request may have landed.
 */
export function QueuedCash({ item }: { item: QueuedCashPayment }) {
  const tr = useT();
  const locale = useLocale();
  const { outbox } = useServices();
  const [correcting, setCorrecting] = useState(false);
  const tendered = satang(item.tenderedSatang);
  const view = item.totalSatang === null ? null : cashView(satang(item.totalSatang), tendered);
  const money = (value: number) => formatBaht(value, locale);
  const orderRef = item.dependsOn ?? item.orderId;
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
      {item.tenderChanged ? (
        <p className="notice" role="status">
          {tr('outbox.cash.changed')}
        </p>
      ) : null}
      {item.canChangeTender && item.totalSatang !== null && orderRef !== null ? (
        <button type="button" className="btn btn-soft" onClick={() => setCorrecting(true)}>
          {tr('outbox.cash.change')}
        </button>
      ) : null}
      {correcting && item.totalSatang !== null && orderRef !== null ? (
        <Modal labelledBy={`qcash-change-${item.id}`} onClose={() => setCorrecting(false)}>
          <h2 id={`qcash-change-${item.id}`} className="sheet__title">
            {tr('outbox.cash.change.title')}
          </h2>
          <CashPanel
            order={{ id: orderRef, totalSatang: satang(item.totalSatang) }}
            queue={{
              estimated: item.dependsOn !== null,
              submit: (tender) =>
                outbox.enqueueCash({
                  target: item.dependsOn ? { entryId: item.dependsOn } : { orderId: orderRef },
                  tenderedSatang: tender,
                  totalSatang: item.totalSatang,
                  label: item.label,
                }),
            }}
            onDone={() => setCorrecting(false)}
          />
          <button type="button" className="btn btn-block" onClick={() => setCorrecting(false)}>
            {tr('common.cancel')}
          </button>
        </Modal>
      ) : null}
      <QueueActions item={item} />
    </section>
  );
}
