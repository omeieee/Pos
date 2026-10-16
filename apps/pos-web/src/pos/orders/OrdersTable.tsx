/**
 * Orders board: the wide layout (iPad, laptop): table plus detail panel.
 */
import { formatBaht } from '@sds/i18n';
import type { OrderDto } from '@sds/shared';
import { type ReactNode, useState } from 'react';
import { clockTime } from '../../design/format.ts';
import { Gi } from '../../design/icons.tsx';
import type { Layout } from '../../design/layout.ts';
import { PageHeader } from '../../design/PageHeader.tsx';
import { s } from '../../design/style.ts';
import { useLocale, useT } from '../../ui/hooks.ts';
import { SyncPill } from '../../ui/SyncPill.tsx';
import { DayPicker, emptyText, PastDayNote } from './DayPicker.tsx';
import { DetailPanel, plainButton } from './DetailPanel.tsx';
import { itemsSummary, Notices, StateBadge } from './list-parts.tsx';
import {
  byNewest,
  matchesPaymentFilter,
  matchesQuery,
  PAYMENT_FILTERS,
  type PaymentFilter,
} from './order-board.ts';

export function OrdersTable({
  layout,
  todays,
  now,
  load,
  retry,
  day,
  today,
  onPickDay,
  onOpenMonth,
}: {
  layout: Layout;
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
  const [filter, setFilter] = useState<PaymentFilter>('all');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);

  const count = (f: PaymentFilter) => todays.filter((o) => matchesPaymentFilter(o, f)).length;
  const rows = todays
    .filter((o) => matchesPaymentFilter(o, filter) && matchesQuery(o, query))
    .sort(byNewest);
  // Like the design, the first row is open until another is chosen.
  const selected = rows.find((o) => o.id === picked) ?? rows[0] ?? null;

  const filterLabel = (f: PaymentFilter) =>
    f === 'all' ? tr('orders.filter.all') : tr(`status.payment.${f}`);
  const badge = (f: PaymentFilter, n: number): ReactNode => {
    const tone = f === 'awaiting_confirmation' ? 'g-b-info' : f === 'unpaid' ? 'g-b-warn' : null;
    return tone && n > 0 ? (
      <span className={`g-badge ${tone}`} style={s('height:22px;padding:0 8px;font-size:12px')}>
        {n}
      </span>
    ) : (
      <span className="g-t-c g-num">{n}</span>
    );
  };
  const isToday = day === today;
  const empty = rows.length === 0 ? emptyText(tr, load, todays.length > 0, query, isToday) : null;

  return (
    <section
      aria-labelledby="orders-title"
      className="g-scroll"
      style={s(
        'flex:1;min-height:0;display:flex;flex-direction:column;gap:18px;padding:10px 12px 8px 8px;overflow-y:auto',
      )}
    >
      <PageHeader
        id="orders-title"
        wrap
        title={tr('nav.ordersPayments')}
        subtitle={tr('orders.subtitle')}
      >
        <label
          className="g-field"
          style={s(
            'width:260px;height:46px;border-radius:999px;background:var(--glass);border-color:var(--line)',
          )}
        >
          <Gi n="search" size="sm" />
          <input
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            aria-label={tr('common.search')}
            placeholder={tr('orders.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <DayPicker day={day} today={today} onPick={onPickDay} onOpenMonth={onOpenMonth} />
        {layout === 'rail' ? <SyncPill /> : null}
      </PageHeader>

      {isToday ? null : <PastDayNote day={day} />}

      <Notices load={load} retry={retry} />

      <fieldset
        className="g-seg"
        style={s('align-self:flex-start;flex-wrap:wrap;border:0;margin:0;min-width:0')}
      >
        <legend className="visually-hidden">{tr('orders.filter.label')}</legend>
        {PAYMENT_FILTERS.map((f) => (
          <label key={f} className={`g-chip${filter === f ? ' g-on' : ''}`}>
            <input
              type="radio"
              name="orders-filter"
              checked={filter === f}
              onChange={() => setFilter(f)}
            />
            {filterLabel(f)} {badge(f, count(f))}
          </label>
        ))}
      </fieldset>

      <div style={s('display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start')}>
        <div
          className="g-glass g-rise"
          style={s(
            'flex:1 1 560px;min-width:0;border-radius:28px;padding:10px 8px 8px;overflow-x:auto',
          )}
        >
          {empty ? (
            <p
              className="g-t-s"
              role={empty.status ? 'status' : undefined}
              style={s('margin:0;padding:24px 14px;text-align:center')}
            >
              {empty.text}
            </p>
          ) : (
            <table
              aria-label={tr('orders.table')}
              style={s('width:100%;border-collapse:collapse;min-width:560px')}
            >
              <thead>
                <tr>
                  <th className="g-th" scope="col">
                    {tr('orders.col.order')}
                  </th>
                  <th className="g-th" scope="col">
                    {tr('orders.channel')}
                  </th>
                  <th className="g-th" scope="col">
                    {tr('orders.col.items')}
                  </th>
                  <th className="g-th" scope="col" style={s('text-align:right')}>
                    {tr('orders.col.total')}
                  </th>
                  <th className="g-th" scope="col">
                    {tr('orders.col.status')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((order) => {
                  const on = order.id === selected?.id;
                  return (
                    <tr
                      key={order.id}
                      className="g-hv"
                      onClick={() => setPicked(order.id)}
                      style={s(`cursor:pointer;${on ? 'background:rgba(36,87,184,.08);' : ''}`)}
                    >
                      <td className="g-td g-num" style={s('font-weight:600;white-space:nowrap')}>
                        <button
                          type="button"
                          aria-pressed={on}
                          aria-label={tr('orders.select', { orderNo: order.orderNo })}
                          style={plainButton}
                        >
                          {order.orderNo}
                          <div className="g-t-c" style={s('font-weight:500')}>
                            {clockTime(Date.parse(order.placedAt))}
                          </div>
                        </button>
                      </td>
                      <td className="g-td" style={s('white-space:nowrap')}>
                        {tr(`orders.channel.${order.channel}`)}
                        <div className="g-t-c">{tr(`status.order.${order.status}`)}</div>
                      </td>
                      <td className="g-td" style={s('width:100%;max-width:0;min-width:140px')}>
                        <div
                          title={itemsSummary(order, locale, false)}
                          style={s('overflow:hidden;text-overflow:ellipsis;white-space:nowrap')}
                        >
                          {itemsSummary(order, locale, false)}
                        </div>
                      </td>
                      <td className="g-td g-num" style={s('text-align:right;font-weight:600')}>
                        {formatBaht(order.totalSatang, locale)}
                      </td>
                      <td className="g-td" style={s('white-space:nowrap')}>
                        <StateBadge order={order} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {selected ? (
          <DetailPanel key={selected.id} order={selected} now={now} />
        ) : (
          <aside
            className="g-glass2"
            aria-label={tr('orders.detail.label')}
            style={s('flex:0 1 400px;min-width:300px;border-radius:30px;padding:22px')}
          >
            <p className="g-t-s" style={s('margin:0')}>
              {tr('orders.detail.empty')}
            </p>
          </aside>
        )}
      </div>
    </section>
  );
}
