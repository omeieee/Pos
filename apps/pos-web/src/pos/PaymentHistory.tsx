import { formatBaht, formatDate } from '@sds/i18n';
import type { PaymentDto, PaymentStatus } from '@sds/shared';
import type { IconName } from '../app/routes.ts';
import { useLocale, useT } from '../ui/hooks.ts';
import { Icon } from '../ui/Icon.tsx';

const STATUS: Record<PaymentStatus, { tone: string; icon: IconName }> = {
  pending: { tone: 'warning', icon: 'circle' },
  claimed: { tone: 'info', icon: 'clock' },
  confirmed: { tone: 'success', icon: 'check-circle' },
  cancelled: { tone: 'neutral', icon: 'x' },
  voided: { tone: 'danger', icon: 'x' },
  refunded: { tone: 'neutral', icon: 'sync' },
};

/** Colour + icon + words, always together (brand §3). */
export function PaymentStatusChip({ status }: { status: PaymentStatus }) {
  const tr = useT();
  const { tone, icon } = STATUS[status];
  return (
    <span className={`status status--${tone}`}>
      <Icon name={icon} />
      {tr(`payment.status.${status}`)}
    </span>
  );
}

/**
 * Every payment of the order, newest first: method, status, the amount (always the server's), the
 * cash handed over and the change, the reference staff typed, why it was cancelled or voided, and
 * (for ไทยช่วยไทย) the estimate, labelled as one. It follows the store, so a frame from another
 * device adds or changes a row at once.
 */
export function PaymentHistory({ payments }: { payments: readonly PaymentDto[] }) {
  const tr = useT();
  const locale = useLocale();
  if (payments.length === 0) return null;
  const newestFirst = [...payments].reverse();
  const money = (value: number) => formatBaht(value, locale);
  return (
    <section className="phistory" aria-labelledby="phistory-title">
      <h3 id="phistory-title" className="phistory__title">
        {tr('payment.history.title')}
      </h3>
      <ul className="phistory__list">
        {newestFirst.map((p) => {
          const at = p.confirmedAt ?? p.claimedAt;
          return (
            <li key={p.id} className="phistory__row">
              <div className="phistory__main">
                <span className="strong">{tr(`payment.method.${p.method}`)}</span>
                <PaymentStatusChip status={p.status} />
                <span className="money phistory__amount">{money(p.amountSatang)}</span>
              </div>
              {p.method === 'cash' && p.tenderedSatang !== null && p.changeSatang !== null ? (
                <span className="muted small">
                  {tr('payment.history.cash', {
                    tendered: money(p.tenderedSatang),
                    change: money(p.changeSatang),
                  })}
                </span>
              ) : null}
              {p.method === 'gov_copay' &&
              p.estGovShareSatang !== null &&
              p.estCustomerShareSatang !== null ? (
                <span className="muted small">
                  {tr('payment.history.estimate', {
                    gov: money(p.estGovShareSatang),
                    customer: money(p.estCustomerShareSatang),
                  })}
                </span>
              ) : null}
              {p.referenceNote ? (
                <span className="muted small">
                  {tr('payment.history.reference', { reference: p.referenceNote })}
                </span>
              ) : null}
              {p.reason ? (
                <span className="muted small">
                  {tr('payment.history.reason', { reason: p.reason })}
                </span>
              ) : null}
              {at ? (
                <span className="muted small">{formatDate(at, locale, 'dateTime')}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
