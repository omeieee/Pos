import { formatBaht } from '@sds/i18n';
import type { OrderDto } from '@sds/shared';
import { type ReactNode, useState } from 'react';
import { clockTime, weekdayDate } from '../design/format.ts';
import { Gi } from '../design/icons.tsx';
import { type Layout, useLayout } from '../design/layout.ts';
import { PageHeader } from '../design/PageHeader.tsx';
import { s } from '../design/style.ts';
import {
  useAuthState,
  useEntities,
  useLocale,
  useNow,
  useServices,
  useStoreState,
  useT,
} from '../ui/hooks.ts';
import { SyncPill } from '../ui/SyncPill.tsx';
import { deliveryLabel } from './delivery-model.ts';
import { elapsedText } from './elapsed-text.ts';
import { MemberLine } from './MemberLine.tsx';
import { localName } from './names.ts';
import { OrderCorrectionActions } from './OrderCorrection.tsx';
import {
  byNewest,
  currentBusinessDay,
  elapsedMinutes,
  matchesPaymentFilter,
  matchesPhoneFilter,
  matchesQuery,
  ordersForDay,
  PAYMENT_FILTERS,
  type PaymentFilter,
  PHONE_FILTERS,
  type PhoneFilter,
  paidByHour,
  paidToday,
} from './order-board.ts';
import { QueuedOrders } from './QueuedOrders.tsx';
import { OrderStatusBadge, PaymentStatusBadge } from './StatusBadge.tsx';
import { useLoadOrders } from './use-load-orders.ts';
import { useStorefrontHours } from './use-storefront-hours.ts';

const WAITING = ['new', 'preparing', 'ready'] as const;
const isWaiting = (order: OrderDto) => (WAITING as readonly string[]).includes(order.status);

type Tr = ReturnType<typeof useT>;

/** "เย็นตาโฟ, ชาเย็น" (the design's table) or "เย็นตาโฟ ×1, ชาเย็น ×1" (its phone card). */
function itemsSummary(order: OrderDto, locale: 'th' | 'en', always: boolean): string {
  return order.items
    .map((item) => {
      const name = localName(locale, item.nameTh, item.nameEn);
      return always || item.qty > 1 ? `${name} ×${item.qty}` : name;
    })
    .join(', ');
}

/** The one button the order needs next, as words: it only opens the order page, it never pays. */
function nextStep(order: OrderDto): 'review' | 'charge' | 'open' {
  if (order.status === 'cancelled') return 'open';
  if (order.paymentStatus === 'awaiting_confirmation') return 'review';
  if (order.paymentStatus === 'unpaid' || order.paymentStatus === 'partially_paid') return 'charge';
  return 'open';
}

/** The payment badge; a cancelled order shows that instead, because it owes nothing. */
function StateBadge({ order }: { order: OrderDto }) {
  return order.status === 'cancelled' ? (
    <OrderStatusBadge status="cancelled" />
  ) : (
    <PaymentStatusBadge status={order.paymentStatus} />
  );
}

// ---------- The notices every layout shows above the orders ----------

function Notices({ load, retry }: { load: 'loading' | 'ok' | 'error'; retry: () => void }) {
  const tr = useT();
  const { cart } = useServices();
  const cartState = useStoreState(cart);
  return (
    <>
      {cartState.phase === 'unsure' ? (
        <div
          className="g-sunk"
          role="status"
          style={s('display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px')}
        >
          <Gi n="warn" />
          <span style={s('flex:1 1 220px')}>{tr('orders.unsureCart')}</span>
          <a className="g-btn" href="#/new">
            {tr('orders.unsureCartBack')}
          </a>
        </div>
      ) : null}

      <QueuedOrders />

      {load === 'error' ? (
        <div
          className="g-sunk"
          role="alert"
          style={s(
            'display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;color:var(--chili-ink);font-weight:600',
          )}
        >
          <Gi n="warn" />
          <span style={s('flex:1 1 200px')}>{tr('orders.loadFailed')}</span>
          <button type="button" className="g-btn" onClick={retry}>
            {tr('common.retry')}
          </button>
        </div>
      ) : null}
    </>
  );
}

function emptyText(
  tr: Tr,
  load: 'loading' | 'ok' | 'error',
  anyToday: boolean,
  query: string,
): { text: string; status: boolean } {
  if (!anyToday) {
    return load === 'loading'
      ? { text: tr('orders.loading'), status: true }
      : { text: tr('orders.empty'), status: false };
  }
  return { text: tr(query.trim() === '' ? 'orders.emptyFilter' : 'orders.noMatch'), status: false };
}

// ---------- Laptop and iPad: the table with the detail beside it ----------

const plainButton = s(
  'background:none;border:0;padding:0;margin:0;font:inherit;color:inherit;text-align:left;cursor:pointer;display:block',
);

function DetailPanel({ order, now }: { order: OrderDto; now: number }) {
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
      <div className="g-t-c" style={s('display:flex;gap:6px;align-items:flex-start')}>
        <Gi n="lock" style={s('width:14px;height:14px;margin-top:3px')} />
        {tr('orders.auditNote')}
      </div>
    </aside>
  );
}

function OrdersTable({
  layout,
  todays,
  now,
  load,
  retry,
}: {
  layout: Layout;
  todays: OrderDto[];
  now: number;
  load: 'loading' | 'ok' | 'error';
  retry: () => void;
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
  const empty = rows.length === 0 ? emptyText(tr, load, todays.length > 0, query) : null;

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
        {layout === 'rail' ? <SyncPill /> : null}
      </PageHeader>

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

function OrdersPhone({
  todays,
  now,
  load,
  retry,
}: {
  todays: OrderDto[];
  now: number;
  load: 'loading' | 'ok' | 'error';
  retry: () => void;
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
  const empty = rows.length === 0 ? emptyText(tr, load, todays.length > 0, query) : null;
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
            {tr('orders.title')}
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
        {canSeeSales ? (
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

/**
 * Today's orders (design "Orders"): on a laptop or iPad a table of the day with a search box, a
 * payment filter and the chosen order's detail beside it; on an iPhone a list of cards with the
 * day's receipts on top. The orders come from the entity store (realtime keeps them live); opening
 * the page also fetches today's list once, so a fresh device sees them without waiting for the
 * first sync. Choosing a row only shows its detail: the order page (`#/orders/<id>`), where the
 * moves and the payment are, opens from the detail's main button or a phone card.
 */
export function OrdersScreen() {
  const state = useEntities();
  const now = useNow(30_000);
  const layout = useLayout();
  const { load, retry } = useLoadOrders();

  const day = currentBusinessDay(state.settings, now);
  const todays = ordersForDay(state.orders.values(), day);

  return layout === 'phone' ? (
    <OrdersPhone todays={todays} now={now} load={load} retry={retry} />
  ) : (
    <OrdersTable layout={layout} todays={todays} now={now} load={load} retry={retry} />
  );
}
