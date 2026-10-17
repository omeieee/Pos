import { formatBaht } from '@sds/i18n';
import type { OrderDto } from '@sds/shared';
import { Gi } from '../../design/icons.tsx';
import { s } from '../../design/style.ts';
import { useEntities, useLocale, useT } from '../../ui/hooks.ts';

const WAITING = ['awaiting_confirmation', 'unpaid', 'partially_paid'] as const;
const SHOWN = 5;

/** Today's orders that are not cancelled and not paid yet, oldest first. From the live order feed. */
export function waitingOrders(orders: Iterable<OrderDto>, today: string): OrderDto[] {
  return [...orders]
    .filter(
      (o) =>
        o.businessDate === today &&
        o.status !== 'cancelled' &&
        (WAITING as readonly string[]).includes(o.paymentStatus),
    )
    .sort((a, b) => a.placedAt.localeCompare(b.placedAt) || a.orderNo.localeCompare(b.orderNo));
}

/** What still needs a person today: payments to check and orders not paid yet. */
export function PendingCard({ today }: { today: string }) {
  const tr = useT();
  const locale = useLocale();
  const waiting = waitingOrders(useEntities().orders.values(), today);
  return (
    <div className="g-glass g-rise rpt-card" style={s('--d:.31s')}>
      <div style={s('display:flex;align-items:baseline')}>
        <div className="g-t-2" style={s('flex-grow:1')}>
          {tr('dash.pending')}
        </div>
        <a
          className="g-t-s"
          href="#/orders"
          style={s('color:var(--chili);font-weight:600;text-decoration:none')}
        >
          {tr('dash.seeAll')}
        </a>
      </div>
      {waiting.length === 0 && <div className="g-t-s">{tr('dash.pending.none')}</div>}
      {waiting.slice(0, SHOWN).map((o) => {
        const review = o.paymentStatus === 'awaiting_confirmation';
        const status = tr(`status.payment.${o.paymentStatus}`);
        return (
          <a
            key={o.id}
            className="g-row"
            href={`#/orders/${o.id}`}
            style={s('padding:8px 0;text-decoration:none;color:inherit')}
          >
            <div style={s('flex-grow:1')}>
              <div className="g-t-3" style={s('font-size:15px')}>
                {o.orderNo} · {tr(`orders.channel.${o.channel}`)}
              </div>
              <div className="g-t-c">
                {tr('dash.pending.unpaidDetail', {
                  amount: formatBaht(o.totalSatang, locale, { decimals: 'auto' }),
                  status,
                })}
              </div>
            </div>
            <span className={`g-badge ${review ? 'g-b-info' : 'g-b-warn'}`}>
              <Gi n={review ? 'clock' : 'pending'} />
              {status}
            </span>
          </a>
        );
      })}
    </div>
  );
}
