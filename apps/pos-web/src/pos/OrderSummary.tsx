import type { ReactNode } from 'react';
import { Gi } from '../design/icons.tsx';
import { s } from '../design/style.ts';
import { useT } from '../ui/hooks.ts';
import { OutboxPill } from '../ui/SyncPill.tsx';
import { type DishArt, dishArtUrl } from './dish-art.ts';
import { Callout, usePayDims } from './PayParts.tsx';
import './pay-glass.css';

export interface SummaryLine {
  key: string;
  name: string;
  /** The chosen options, already joined. */
  options: string;
  qty: number;
  note: string | null;
  /** The line total; empty when the device cannot know it. */
  amount: string;
  art: DishArt;
  /** A photo of the dish, if it has one. */
  imageUrl: string | null;
}

/**
 * The left column of the payment screen ("ipad-payment"): back button, the order number and where
 * it came from, the dishes, the notes and the amount due in big type. On a phone it is a card above
 * the payment with the dishes folded away. It is shared by the order page and the page of an order
 * that is still only on this device, which differ only in what they put in the slots.
 */
export function OrderSummary({
  title,
  subtitle,
  badges,
  recipient,
  member,
  cancelReason,
  lines,
  orderNote,
  countText,
  totalLabel,
  totalText,
  totalHint,
  below,
}: {
  title: string;
  subtitle: ReactNode;
  badges: ReactNode;
  recipient: { headline: string; note: string | null } | null;
  /** Who the order is for (the customer's optional details), if the page shows them. */
  member?: ReactNode;
  cancelReason?: string | null;
  lines: readonly SummaryLine[];
  orderNote: string | null;
  countText: string;
  totalLabel: string;
  totalText: string;
  totalHint?: ReactNode;
  /** Order moves, queue actions, the "take another order" link. */
  below?: ReactNode;
}) {
  const tr = useT();
  const dims = usePayDims();
  const phone = dims.layout === 'phone';

  const items = (
    <ul style={s('list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px')}>
      {lines.map((line) => (
        <li key={line.key} style={s('display:flex;gap:12px;align-items:center')}>
          <span
            className={`g-tg-${line.art.tint}`}
            aria-hidden="true"
            style={s(
              'width:52px;height:52px;border-radius:17px;flex:none;display:grid;place-items:center;background:linear-gradient(160deg,var(--g1),var(--g2));overflow:hidden',
            )}
          >
            <img
              src={line.imageUrl ?? dishArtUrl(line.art)}
              alt=""
              draggable={false}
              style={s(line.imageUrl ? 'width:100%;height:100%;object-fit:cover' : 'width:40px')}
            />
          </span>
          <div style={s('flex-grow:1;min-width:0')}>
            <div className="g-t-3" style={s('font-size:15px')}>
              {line.name}
            </div>
            <div className="g-t-c">
              {line.options ? <span>{line.options}</span> : null}
              {line.options ? <span aria-hidden="true"> · </span> : null}
              <span>{tr('order.detail.qtyTimes', { count: line.qty })}</span>
            </div>
            {line.note ? (
              <div
                className="g-t-c"
                style={s('display:flex;align-items:center;gap:4px;color:var(--amber-ink)')}
              >
                <Gi n="note" size="sm" />
                <span>{line.note}</span>
              </div>
            ) : null}
          </div>
          <span className="g-num g-t-3">{line.amount}</span>
        </li>
      ))}
    </ul>
  );

  const note = orderNote ? (
    <div
      style={s(
        'display:flex;gap:8px;align-items:center;padding:10px 12px;border-radius:14px;background:var(--amber-soft);color:var(--amber-ink);font-size:14px;font-weight:600',
      )}
    >
      <Gi n="note" size="sm" style={s('flex:none')} />
      <span style={s('min-width:0')}>{orderNote}</span>
    </div>
  ) : null;

  return (
    <aside
      className="g-glass pay-page"
      aria-label={tr('order.detail.summary')}
      style={s(
        phone
          ? 'border-radius:28px;padding:18px 16px;display:flex;flex-direction:column;gap:14px;flex:none'
          : `width:${dims.aside}px;flex:none;border-radius:32px;padding:24px 22px;display:flex;flex-direction:column;gap:16px;min-height:0`,
      )}
    >
      <div style={s('display:flex;align-items:center;gap:12px')}>
        <a className="g-btn g-btn-icon" href="#/orders" aria-label={tr('order.detail.back')}>
          <Gi n="chevronLeft" />
        </a>
        <div style={s('flex-grow:1;min-width:0')}>
          <h1 id="order-title" className="g-t-2" style={s('margin:0')}>
            {title}
          </h1>
          <div className="g-t-c">{subtitle}</div>
        </div>
      </div>
      <div data-testid="order-badges" style={s('display:flex;gap:8px;flex-wrap:wrap')}>
        {badges}
      </div>
      {/* This page has no header of its own: the entries waiting on the device stay in view. */}
      <div className="pay-pillrow" style={s('display:flex')}>
        <OutboxPill />
      </div>
      <hr className="g-hair" />
      {recipient ? (
        <div
          className="g-sunk"
          style={s('padding:12px 14px;display:flex;gap:10px;align-items:flex-start')}
        >
          <Gi n="building" size="sm" style={s('margin-top:3px;flex:none')} />
          <div style={s('min-width:0')}>
            <b className="g-t-3" style={s('font-size:15px')}>
              {recipient.headline}
            </b>
            {recipient.note ? <span className="g-t-c"> {recipient.note}</span> : null}
          </div>
        </div>
      ) : null}
      {member}
      {cancelReason ? <Callout tone="bad">{cancelReason}</Callout> : null}

      {phone ? (
        <details>
          <summary
            className="g-t-3"
            style={s(
              'font-size:15px;cursor:pointer;min-height:44px;display:flex;align-items:center;gap:8px',
            )}
          >
            {tr('order.detail.showItems')}
            <span className="g-t-c">{`· ${countText}`}</span>
          </summary>
          <div style={s('display:flex;flex-direction:column;gap:12px;padding-top:6px')}>
            {items}
            {note}
          </div>
        </details>
      ) : (
        <div
          className="g-scroll"
          style={s('flex-grow:1;min-height:0;display:flex;flex-direction:column;gap:14px')}
        >
          {items}
          {note}
        </div>
      )}

      <div
        className="g-sunk"
        style={s(
          `padding:${phone ? '14px 16px' : '18px 18px 16px'};display:flex;flex-direction:column;gap:2px;flex:none`,
        )}
      >
        <div className="g-t-s" style={s('display:flex;justify-content:space-between')}>
          <span>{countText}</span>
          <span className="g-num">{totalText}</span>
        </div>
        <div className="g-t-c">{totalLabel}</div>
        <div
          className="g-num"
          data-testid="order-total"
          style={s(
            `font-size:${phone ? 44 : 58}px;line-height:1.25;font-weight:600;letter-spacing:-.015em`,
          )}
        >
          {totalText}
        </div>
        {totalHint ? <div className="g-t-c">{totalHint}</div> : null}
      </div>
      {below}
    </aside>
  );
}
