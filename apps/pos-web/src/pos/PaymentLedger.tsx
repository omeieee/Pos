import { formatBaht, formatDate } from '@sds/i18n';
import { s } from '../design/style.ts';
import { useLocale, useT } from '../ui/hooks.ts';
import { useLedger } from './use-ledger.ts';

/**
 * Net paid, the partial refunds and what is still due, exactly as the server says (never added up
 * here). Hidden for an order that was simply paid in one go.
 */
export function PaymentLedger({ orderId }: { orderId: string }) {
  const tr = useT();
  const locale = useLocale();
  const ledger = useLedger(orderId);
  if (!ledger) return null;
  const { refunds, netPaidSatang, dueSatang } = ledger;
  const owing = dueSatang !== null && dueSatang > 0 && (netPaidSatang ?? 0) > 0;
  if (refunds.length === 0 && !owing) return null;
  const money = (value: number) => formatBaht(value, locale);
  return (
    <section
      className="g-sunk"
      data-testid="payment-ledger"
      aria-labelledby="pledger-title"
      style={s('padding:16px 18px;display:flex;flex-direction:column;gap:8px;flex:none')}
    >
      <h3 id="pledger-title" className="g-t-3" style={s('margin:0;font-size:15px')}>
        {tr('payment.ledger.title')}
      </h3>
      {netPaidSatang !== null ? (
        <div style={s('display:flex;justify-content:space-between;gap:10px')}>
          <span className="g-t-3" style={s('font-size:15px')}>
            {tr('payment.ledger.netPaid')}
          </span>
          <span className="g-num g-t-3" style={s('font-size:15px')}>
            {money(netPaidSatang)}
          </span>
        </div>
      ) : null}
      {refunds.map((refund) => (
        <div key={refund.id} style={s('display:flex;flex-direction:column;gap:2px')}>
          <div style={s('display:flex;justify-content:space-between;gap:10px')}>
            <span className="g-t-3" style={s('font-size:15px')}>
              {tr('payment.ledger.refund', { method: tr(`payment.method.${refund.method}`) })}
            </span>
            <span className="g-num g-t-3" style={s('font-size:15px')}>
              {money(refund.amountSatang)}
            </span>
          </div>
          <span className="g-t-c">
            {formatDate(refund.refundedAt, locale, 'dateTime')}
            {refund.referenceNote ? ` · ${refund.referenceNote}` : ''}
          </span>
        </div>
      ))}
      {owing && dueSatang !== null ? (
        <div style={s('display:flex;justify-content:space-between;gap:10px')}>
          <span className="g-t-3" style={s('font-size:15px')}>
            {tr('payment.ledger.due')}
          </span>
          <span className="g-num g-t-3" style={s('font-size:15px')}>
            {money(dueSatang)}
          </span>
        </div>
      ) : null}
    </section>
  );
}
