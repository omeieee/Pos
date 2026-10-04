import { formatBaht } from '@sds/i18n';
import { satang } from '@sds/shared';
import { useState } from 'react';
import { s } from '../design/style.ts';
import { useLocale, useServices, useT } from '../ui/hooks.ts';
import { CashPanel } from './CashPanel.tsx';
import type { QueuedCashPayment } from './outbox-model.ts';
import { Callout, PayModal, SheetBody, SheetTitle } from './PayParts.tsx';
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
    <section
      aria-labelledby={`qcash-${item.id}`}
      className="g-sunk"
      style={s(
        'padding:18px 20px;display:flex;flex-direction:column;gap:12px;width:100%;min-width:0',
      )}
    >
      <h3 id={`qcash-${item.id}`} className="g-t-3" style={s('margin:0')}>
        {tr('outbox.cash.title')}
      </h3>
      <p className="g-num g-t-2" style={s('margin:0')}>
        {tr('outbox.cash.summary', {
          tendered: money(item.tenderedSatang),
          change: view === null || view.change === null ? '-' : money(view.change),
        })}
      </p>
      <div style={s('display:flex;gap:8px;flex-wrap:wrap')}>
        <QueueStateBadge item={item} />
      </div>
      <p className="g-t-c" style={s('margin:0')}>
        {tr('outbox.cash.waiting')}
      </p>
      {item.tenderChanged ? (
        <Callout tone="warn" role="status">
          {tr('outbox.cash.changed')}
        </Callout>
      ) : null}
      {item.canChangeTender && item.totalSatang !== null && orderRef !== null ? (
        <div>
          <button type="button" className="g-btn" onClick={() => setCorrecting(true)}>
            {tr('outbox.cash.change')}
          </button>
        </div>
      ) : null}
      {correcting && item.totalSatang !== null && orderRef !== null ? (
        <PayModal labelledBy={`qcash-change-${item.id}`} onClose={() => setCorrecting(false)}>
          <SheetBody>
            <SheetTitle id={`qcash-change-${item.id}`}>{tr('outbox.cash.change.title')}</SheetTitle>
            <CashPanel
              order={{ id: orderRef, totalSatang: satang(item.totalSatang) }}
              stacked
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
            <button
              type="button"
              className="g-btn g-btn-block"
              onClick={() => setCorrecting(false)}
            >
              {tr('common.cancel')}
            </button>
          </SheetBody>
        </PayModal>
      ) : null}
      <QueueActions item={item} />
    </section>
  );
}
