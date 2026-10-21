/**
 * Orders board: the detail panel beside the table.
 */
import { formatBaht } from '@sds/i18n';
import type { OrderDto } from '@sds/shared';
import { clockTime } from '../../design/format.ts';
import { Gi } from '../../design/icons.tsx';
import { s } from '../../design/style.ts';
import { useLocale, useT } from '../../ui/hooks.ts';
import { deliveryLabel } from '../cart/delivery-model.ts';
import { MemberLine } from '../cart/MemberLine.tsx';
import { localName } from '../cart/names.ts';
import { OrderCorrectionActions } from '../correction/OrderCorrection.tsx';
import { ReprintButton } from '../print/ReprintButton.tsx';
import { elapsedText } from './elapsed-text.ts';
import { isWaiting, nextStep, StateBadge } from './list-parts.tsx';
import { elapsedMinutes } from './order-board.ts';
import { OrderStatusBadge } from './StatusBadge.tsx';

// ---------- Laptop and iPad: the table with the detail beside it ----------

export const plainButton = s(
  'background:none;border:0;padding:0;margin:0;font:inherit;color:inherit;text-align:left;cursor:pointer;display:block',
);

export function DetailPanel({ order, now }: { order: OrderDto; now: number }) {
  const tr = useT();
  const locale = useLocale();
  const step = nextStep(order);
  const to = deliveryLabel(order);
  const meta = [
    tr(`orders.channel.${order.channel}`),
    tr(`pos.orderEntry.fulfilment.${order.fulfillment}`),
    tr('orders.atTime', { time: clockTime(Date.parse(order.placedAt)) }),
  ].join(' · ');
  const href = `#/orders/${order.id}`;
  const awaiting = order.paymentStatus === 'awaiting_confirmation' && order.status !== 'cancelled';
  const paid = order.paymentStatus === 'paid' || order.status === 'cancelled';
  return (
    <aside
      className="g-glass2 g-slide-up"
      aria-label={tr('orders.detail.label')}
      style={s(
        'flex:0 1 400px;min-width:300px;border-radius:30px;padding:22px 22px 20px;display:flex;flex-direction:column;gap:14px;--d:.1s',
      )}
    >
      <div style={s('display:flex;align-items:center;gap:10px')}>
        <div style={s('flex-grow:1;min-width:0')}>
          <h2 className="g-t-2" style={s('margin:0')}>
            {tr('order.detail.title', { orderNo: order.orderNo })}
          </h2>
          <div className="g-t-c">{meta}</div>
        </div>
        <StateBadge order={order} />
      </div>
      <div style={s('display:flex;align-items:center;gap:8px;flex-wrap:wrap')}>
        {order.status === 'cancelled' ? null : <OrderStatusBadge status={order.status} />}
        {isWaiting(order) ? (
          <span className="g-t-c" style={s('display:inline-flex;align-items:center;gap:6px')}>
            <Gi n="clock" size="sm" />
            {tr('orders.elapsed', { time: elapsedText(tr, elapsedMinutes(order.placedAt, now)) })}
          </span>
        ) : null}
      </div>
      {to || order.roomNo ? (
        <div className="g-t-s" style={s('display:flex;gap:8px;align-items:flex-start')}>
          <Gi n="building" size="sm" style={s('margin-top:2px')} />
          <span>
            {[to?.headline, order.roomNo ? tr('order.detail.room', { room: order.roomNo }) : null]
              .filter(Boolean)
              .join(' · ')}
            {to?.note ? <span style={s('display:block')}>{to.note}</span> : null}
          </span>
        </div>
      ) : null}
      <MemberLine member={order.member} />
      <ul
        className="g-t-s"
        style={s('list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px')}
      >
        {order.items.map((item) => {
          const mods = item.modifiers.map((m) => localName(locale, m.nameTh, m.nameEn));
          return (
            <li key={item.id} style={s('display:flex;justify-content:space-between;gap:12px')}>
              <span>
                {[localName(locale, item.nameTh, item.nameEn), ...mods].join(' · ')}
                {` ×${item.qty}`}
              </span>
              <span className="g-num" style={s('flex:none')}>
                {formatBaht(item.lineTotalSatang, locale)}
              </span>
            </li>
          );
        })}
        {order.discountSatang > 0 ? (
          <li style={s('display:flex;justify-content:space-between;gap:12px')}>
            <span>{tr('orders.detail.discount')}</span>
            <span className="g-num">−{formatBaht(order.discountSatang, locale)}</span>
          </li>
        ) : null}
      </ul>
      <hr className="g-hair" />
      <div style={s('display:flex;flex-direction:column;gap:2px')}>
        <div className="g-t-c">{tr(paid ? 'common.total' : 'orders.detail.amountDue')}</div>
        <div className="g-num" style={s('font-size:34px;line-height:1.3;font-weight:600')}>
          {formatBaht(order.totalSatang, locale)}
        </div>
      </div>
      {awaiting ? (
        <div
          className="g-sunk g-t-s"
          style={s('padding:12px 16px;display:flex;gap:10px;align-items:flex-start')}
        >
          <Gi n="info" size="sm" style={s('margin-top:2px')} />
          <span style={s('color:var(--ink)')}>{tr('orders.hint.awaiting')}</span>
        </div>
      ) : null}
      <a
        className={`g-btn g-btn-lg g-btn-block ${
          step === 'review' ? 'g-btn-ok' : step === 'charge' ? 'g-btn-p' : ''
        }`}
        href={href}
      >
        {step === 'review' ? <Gi n="check" /> : null}
        {tr(`orders.cta.${step}`)}
      </a>
      {awaiting ? (
        <button
          type="button"
          className="g-btn g-btn-block"
          disabled
          aria-disabled="true"
          title={tr('nav.notReady')}
          style={s('color:var(--chili-ink)')}
        >
          {tr('orders.notifyCustomer')}
        </button>
      ) : null}
      <OrderCorrectionActions order={order} />
      <ReprintButton orderId={order.id} status={order.status} />
      <div className="g-t-c" style={s('display:flex;gap:6px;align-items:flex-start')}>
        <Gi n="lock" style={s('width:14px;height:14px;margin-top:3px')} />
        {tr('orders.auditNote')}
      </div>
    </aside>
  );
}
