import { formatBaht, formatDate } from '@sds/i18n';
import type { PaymentDto, PaymentStatus } from '@sds/shared';
import { Gi, type GiName } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useLocale, useT } from '../ui/hooks.ts';
import { SlipView } from './SlipView.tsx';

const STATUS: Record<
  PaymentStatus,
  { tone: 'warn' | 'info' | 'ok' | 'bad' | 'mute'; icon: GiName }
> = {
  pending: { tone: 'warn', icon: 'pending' },
  claimed: { tone: 'info', icon: 'clock' },
  confirmed: { tone: 'ok', icon: 'check' },
  cancelled: { tone: 'mute', icon: 'x' },
  voided: { tone: 'bad', icon: 'x' },
  refunded: { tone: 'mute', icon: 'clock' },
};

/** Colour + icon + words, always together (brand §3). */
export function PaymentStatusChip({ status }: { status: PaymentStatus }) {
  const tr = useT();
  const { tone, icon } = STATUS[status];
  return (
    <span className={`g-badge g-b-${tone}`}>
      <Gi n={icon} />
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
    <section
      className="g-sunk"
      aria-labelledby="phistory-title"
      style={s('padding:16px 18px;display:flex;flex-direction:column;gap:10px;flex:none')}
    >
      <h3 id="phistory-title" className="g-t-3" style={s('margin:0;font-size:15px')}>
        {tr('payment.history.title')}
      </h3>
      <ul
        style={s('list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px')}
      >
        {newestFirst.map((p) => {
          const at = p.confirmedAt ?? p.claimedAt;
          return (
            <li key={p.id} style={s('display:flex;flex-direction:column;gap:2px;min-width:0')}>
              <div style={s('display:flex;align-items:center;gap:10px;flex-wrap:wrap')}>
                <span className="g-t-3" style={s('font-size:15px')}>
                  {tr(`payment.method.${p.method}`)}
                </span>
                <PaymentStatusChip status={p.status} />
                <span className="g-num g-t-3" style={s('margin-left:auto;font-size:15px')}>
                  {money(p.amountSatang)}
                </span>
              </div>
              {p.method === 'cash' && p.tenderedSatang !== null && p.changeSatang !== null ? (
                <span className="g-t-c">
                  {tr('payment.history.cash', {
                    tendered: money(p.tenderedSatang),
                    change: money(p.changeSatang),
                  })}
                </span>
              ) : null}
              {p.method === 'gov_copay' &&
              p.estGovShareSatang !== null &&
              p.estCustomerShareSatang !== null ? (
                <span className="g-t-c">
                  {tr('payment.history.estimate', {
                    gov: money(p.estGovShareSatang),
                    customer: money(p.estCustomerShareSatang),
                  })}
                </span>
              ) : null}
              {p.referenceNote ? (
                <span className="g-t-c">
                  {tr('payment.history.reference', { reference: p.referenceNote })}
                </span>
              ) : null}
              {p.reason ? (
                <span className="g-t-c">{tr('payment.history.reason', { reason: p.reason })}</span>
              ) : null}
              {at ? <span className="g-t-c">{formatDate(at, locale, 'dateTime')}</span> : null}
              {p.method === 'promptpay' ? (
                <SlipView orderId={p.orderId} paymentId={p.id} rev={p.rev} quiet />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
