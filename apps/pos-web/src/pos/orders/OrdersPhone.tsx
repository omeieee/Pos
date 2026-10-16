/**
 * Orders board: the iPhone layout: summary line and cards.
 */
import { formatBaht } from '@sds/i18n';
import type { OrderDto } from '@sds/shared';
import { useState } from 'react';
import { clockTime, weekdayDate } from '../../design/format.ts';
import { Gi } from '../../design/icons.tsx';
import { s } from '../../design/style.ts';
import { useAuthState, useLocale, useT } from '../../ui/hooks.ts';
import { SyncPill } from '../../ui/SyncPill.tsx';
import { deliveryLabel } from '../cart/delivery-model.ts';
import { MemberLine } from '../cart/MemberLine.tsx';
import { useStorefrontHours } from '../cart/use-storefront-hours.ts';
import { DayPicker, emptyText, PastDayNote } from './DayPicker.tsx';
import { elapsedText } from './elapsed-text.ts';
import { isWaiting, itemsSummary, Notices, nextStep, StateBadge } from './list-parts.tsx';
import {
  byNewest,
  elapsedMinutes,
  matchesPhoneFilter,
  matchesQuery,
  PHONE_FILTERS,
  type PhoneFilter,
  paidByHour,
  paidToday,
} from './order-board.ts';

// ---------- iPhone: the list of cards ----------

function Sparkline({ series, label }: { series: number[]; label: string }) {
  if (series.length < 2) return null;
  const max = Math.max(...series, 1);
  const points = series.map((value, index) => {
    const x = 2 + (index / (series.length - 1)) * 116;
    const y = 52 - (value / max) * 46;
    return [Number(x.toFixed(1)), Number(y.toFixed(1))] as const;
  });
  const line = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
  const last = points[points.length - 1] ?? [118, 6];
  return (
    <svg viewBox="0 0 120 56" width="120" height="56" role="img" aria-label={label}>
      <defs>
        <linearGradient id="orders-spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c62828" stopOpacity=".28" />
          <stop offset="1" stopColor="#c62828" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} V56 H2z`} fill="url(#orders-spark)" />
      <path
        d={line}
        fill="none"
        stroke="#c62828"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r="4" fill="#c62828" />
    </svg>
  );
}

function PhoneCard({ order, now, delay }: { order: OrderDto; now: number; delay: number }) {
  const tr = useT();
  const locale = useLocale();
  const step = nextStep(order);
  const to = deliveryLabel(order);
  const awaiting = order.paymentStatus === 'awaiting_confirmation' && order.status !== 'cancelled';
  const meta = [
    tr(`orders.channel.${order.channel}`),
    tr(`pos.orderEntry.fulfilment.${order.fulfillment}`),
    tr(`status.order.${order.status}`),
    tr('orders.atTime', { time: clockTime(Date.parse(order.placedAt)) }),
  ].join(' · ');
  const small = [
    awaiting ? tr('orders.hint.awaiting') : null,
    isWaiting(order)
      ? tr('orders.elapsed', { time: elapsedText(tr, elapsedMinutes(order.placedAt, now)) })
      : null,
  ].filter(Boolean);
  return (
    <li>
      <a
        className="g-glass g-rise orders-card"
        href={`#/orders/${order.id}`}
        style={s(
          `--d:${delay}s;border-radius:28px;padding:16px 18px;display:flex;flex-direction:column;gap:10px;text-decoration:none;color:inherit;${
            awaiting ? 'border-color:rgba(36,87,184,.35);' : ''
          }`,
        )}
      >
        <div style={s('display:flex;align-items:center;gap:10px')}>
          <span className="g-t-2 g-num" style={s('flex-grow:1')}>
            {order.orderNo}
          </span>
          <StateBadge order={order} />
        </div>
        <div className="g-t-s">{meta}</div>
        <div className="g-t-b">{itemsSummary(order, locale, true)}</div>
        <MemberLine member={order.member} />
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
        <div style={s('display:flex;align-items:center;gap:10px')}>
          <span className="g-num g-t-2" style={s('flex-grow:1')}>
            {formatBaht(order.totalSatang, locale)}
          </span>
          {step === 'open' ? null : (
            <span className={`g-btn g-btn-sm ${step === 'review' ? 'g-btn-ok' : 'g-btn-p'}`}>
              {tr(`orders.cta.${step}`)}
            </span>
          )}
        </div>
        {small.length > 0 ? <div className="g-t-c">{small.join(' · ')}</div> : null}
      </a>
    </li>
  );
}

export function OrdersPhone({
  todays,
  now,
  load,
  retry,
  day,
  today,
  onPickDay,
  onOpenMonth,
}: {
  todays: OrderDto[];
  now: number;
  load: 'loading' | 'ok' | 'error';
  retry: () => void;
  day: string;
  today: string;
  onPickDay: (day: string | null) => void;
  onOpenMonth: () => void;
}) {
  const tr = useT();
  const locale = useLocale();
  const hours = useStorefrontHours();
  const canSeeSales = useAuthState().session?.permissions.includes('report.view') ?? false;
  const [filter, setFilter] = useState<PhoneFilter>('all');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);

  const rows = todays
    .filter((o) => matchesPhoneFilter(o, filter) && matchesQuery(o, query))
    .sort(byNewest);
  const toPay = todays.filter((o) => matchesPhoneFilter(o, 'pay')).length;
  const paid = paidToday(todays);
  const isToday = day === today;
  const empty = rows.length === 0 ? emptyText(tr, load, todays.length > 0, query, isToday) : null;
  const subtitle = [weekdayDate(now, locale), hours ? tr('orders.hoursLine', { hours }) : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <section
      aria-labelledby="orders-title"
      style={s(
        'flex:1;min-height:0;display:flex;flex-direction:column;gap:14px;padding:calc(env(safe-area-inset-top, 0px) + 16px) 20px 0',
      )}
    >
      <div style={s('display:flex;align-items:center;gap:12px;flex:none')}>
        <div style={s('flex-grow:1;min-width:0')}>
          <h1 id="orders-title" className="g-t-1" style={s('margin:0')}>
            {tr(isToday ? 'orders.title' : 'orders.day.pastTitle')}
          </h1>
          <div className="g-t-c">{subtitle}</div>
        </div>
        <button
          type="button"
          className="g-btn g-btn-icon g-glass"
          aria-label={tr('common.search')}
          aria-expanded={searching}
          style={s('background:var(--glass)')}
          onClick={() => setSearching((v) => !v)}
        >
          <Gi n="search" />
        </button>
        <SyncPill compact />
      </div>

      <DayPicker day={day} today={today} onPick={onPickDay} onOpenMonth={onOpenMonth} />

      {searching ? (
        <label className="g-field" style={s('flex:none')}>
          <Gi n="search" />
          <input
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: the person just tapped the search button
            autoFocus
            aria-label={tr('common.search')}
            placeholder={tr('orders.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      ) : null}

      <div
        className="g-scroll"
        style={s(
          'flex:1;min-height:0;margin:0 -20px;padding:0 20px 24px;display:flex;flex-direction:column;gap:14px',
        )}
      >
        {isToday ? null : <PastDayNote day={day} />}

        {canSeeSales && isToday ? (
          <div
            className="g-glass2 g-rise"
            style={s(
              'border-radius:28px;padding:16px 18px;display:flex;align-items:center;gap:14px;--d:.04s;flex:none',
            )}
          >
            <div style={s('flex-grow:1;min-width:0')}>
              <div className="g-t-c">{tr('orders.paidToday')}</div>
              <div
                className="g-num"
                style={s('font-size:36px;line-height:1.3;font-weight:600;letter-spacing:-.01em')}
              >
                {formatBaht(paid.totalSatang, locale)}
              </div>
              <div className="g-t-s">
                {tr('orders.paidTodaySub', {
                  count: todays.filter((o) => o.status !== 'cancelled').length,
                  // To whole baht, like the design's "เฉลี่ย ฿128".
                  average: formatBaht(
                    paid.count === 0 ? 0 : Math.round(paid.totalSatang / paid.count / 100) * 100,
                    locale,
                    { decimals: 'auto' },
                  ),
                })}
              </div>
            </div>
            <Sparkline series={paidByHour(todays)} label={tr('orders.paidChart')} />
          </div>
        ) : null}

        <Notices load={load} retry={retry} />

        <fieldset
          className="g-scroll"
          style={s(
            'display:flex;gap:8px;border:0;margin:0 -20px;padding:0 20px;min-width:auto;flex:none',
          )}
        >
          <legend className="visually-hidden">{tr('orders.filter.label')}</legend>
          {PHONE_FILTERS.map((f) => (
            <label key={f} className={`g-chip${filter === f ? ' g-on' : ''}`}>
              <input
                type="radio"
                name="orders-filter"
                checked={filter === f}
                onChange={() => setFilter(f)}
              />
              {tr(`orders.filter.${f}`)}
              {f === 'pay' && toPay > 0 ? (
                <span
                  className="g-badge g-b-warn"
                  style={s('height:22px;padding:0 8px;font-size:12px')}
                >
                  {toPay}
                </span>
              ) : null}
            </label>
          ))}
        </fieldset>

        {empty ? (
          <p className="g-t-s" role={empty.status ? 'status' : undefined} style={s('margin:0')}>
            {empty.text}
          </p>
        ) : (
          <ul
            aria-label={tr('orders.table')}
            style={s(
              'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px',
            )}
          >
            {rows.map((order, index) => (
              <PhoneCard
                key={order.id}
                order={order}
                now={now}
                delay={Math.min(0.08 + index * 0.04, 0.4)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
