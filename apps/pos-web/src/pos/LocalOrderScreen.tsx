import { formatBaht } from '@sds/i18n';
import { satang } from '@sds/shared';
import { useLocale, useServices, useStoreState, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';
import { CashPanel } from './CashPanel.tsx';
import { localName } from './names.ts';
import type { QueuedOrder, QueuedPayment } from './outbox-model.ts';
import { isPlatformChannel } from './platform-model.ts';
import { QueueActions, QueueStateBadge } from './QueueActions.tsx';
import { QueuedCash } from './QueuedCash.tsx';

/**
 * An order that is saved on this device and has not reached the server. It is shown from what was
 * saved with it (names, quantities, the estimate), not from the menu, so it opens even after a
 * reload with no connection. It has a temporary number and says so; the real number and total come
 * from the server after the sync, and this page then moves to the real order.
 *
 * Cash can be taken here: the keypad and the change are the usual ones, against the ESTIMATED total,
 * and the cash is saved to the outbox behind the order. PromptPay and ไทยช่วยไทย are not offered
 * until the order is on the server (they need the internet), and a platform order's payment is
 * recorded after it has synced. Status moves are not available offline.
 */
export function LocalOrderScreen({ item }: { item: QueuedOrder }) {
  const { outbox } = useServices();
  const state = useStoreState(outbox);
  const tr = useT();
  const locale = useLocale();
  const money = (value: number) => formatBaht(value, locale);
  const payment = state.items.find(
    (i): i is QueuedPayment => i.kind === 'payment' && i.dependsOn === item.id,
  );
  const canTakeCash =
    !payment &&
    item.state !== 'attention' &&
    !isPlatformChannel(item.channel) &&
    item.estimateSatang !== null;

  return (
    <section className="odetail odetail--wide" aria-labelledby="order-title">
      <a className="link link--back" href="#/orders">
        <Icon name="back" />
        {tr('order.detail.back')}
      </a>
      <header className="odetail__head">
        <h1 id="order-title" className="order-no">
          {tr('outbox.order.title', { label: item.label })}
        </h1>
        <div className="odetail__badges">
          <QueueStateBadge item={item} />
        </div>
        <p className="muted">{tr('outbox.order.notYet')}</p>
        {item.recipient ? (
          <p className="odetail__to">
            <strong>{`${item.recipient.building} · ${item.recipient.name}`}</strong>
            {item.recipient.note ? <span className="muted"> {item.recipient.note}</span> : null}
          </p>
        ) : null}
      </header>

      <QueueActions item={item} />

      <div className="opay">
        <div className="opay__order">
          <h2 className="odetail__h">{tr('order.detail.items')}</h2>
          <ul className="odetail__lines">
            {item.lines.map((line, index) => (
              // The lines were saved in order and never change, so the position is a stable key.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <li key={index} className="oline">
                <span className="oline__qty">{tr('order.detail.qty', { count: line.qty })}</span>
                <span className="oline__what">
                  <span>{localName(locale, line.name.th, line.name.en)}</span>
                  {line.options.length > 0 ? (
                    <span className="muted">
                      {line.options
                        .map((option) => localName(locale, option.th, option.en))
                        .join(' · ')}
                    </span>
                  ) : null}
                  {line.note ? <span className="line__note">{line.note}</span> : null}
                </span>
                <span className="money">
                  {line.lineTotalSatang === null ? '' : money(line.lineTotalSatang)}
                </span>
              </li>
            ))}
          </ul>
          {item.note ? <p className="muted">{`${tr('common.note')}: ${item.note}`}</p> : null}
          <div className="sumrow total odetail__total">
            <span>{tr('pos.orderEntry.estimate')}</span>
            <span className="money">
              {item.estimateSatang === null ? '' : money(item.estimateSatang)}
            </span>
          </div>
          <p className="hint">{tr('outbox.order.estimateHint')}</p>
        </div>

        <section className="ppanel" aria-labelledby="pay-title">
          <header className="ppanel__head">
            <h2 id="pay-title" className="ppanel__title">
              {tr('payment.title')}
            </h2>
            {item.estimateSatang === null ? null : (
              <div className="due">
                <span className="lbl">{tr('pos.orderEntry.estimate')}</span>
                <span className="amount-hero money">{money(item.estimateSatang)}</span>
              </div>
            )}
          </header>
          <div className="ppanel__body">
            {payment ? (
              <QueuedCash item={payment} />
            ) : isPlatformChannel(item.channel) ? (
              <p className="notice">{tr('platform.payment.hint')}</p>
            ) : item.estimateSatang === null ? (
              <p className="notice">{tr('outbox.order.noEstimate')}</p>
            ) : canTakeCash ? (
              <>
                <p className="notice">
                  <Icon name="wifi-off" />
                  <span>{tr('outbox.onlineOnly')}</span>
                </p>
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
              </>
            ) : null}
          </div>
        </section>
      </div>

      <a className="btn btn-primary" href="#/new">
        {tr('order.detail.takeAnother')}
      </a>
    </section>
  );
}
