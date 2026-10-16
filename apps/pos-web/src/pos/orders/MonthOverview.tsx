import { formatBaht } from '@sds/i18n';
import type { DayTotals } from '@sds/shared';
import { useCallback, useEffect, useState } from 'react';
import { weekdayDate } from '../../design/format.ts';
import { Gi } from '../../design/icons.tsx';
import { useLayout } from '../../design/layout.ts';
import { PageHeader } from '../../design/PageHeader.tsx';
import { s } from '../../design/style.ts';
import { useAuthState, useLocale, useServices, useT } from '../../ui/hooks.ts';
import {
  calendarCells,
  dayToOpen,
  monthLabel,
  monthOf,
  shiftMonth,
  weekdayHeadings,
} from './month-model.ts';

type Load = 'loading' | 'ok' | 'error';

/**
 * The month as a calendar: per business date, how many orders there were and what was received.
 * The server does the sums; this only lays them out and formats them. Revenue counts orders that
 * are fully paid (never unpaid, awaiting or cancelled ones), and is shown to roles with
 * `report.view` only, like the sales figures elsewhere; everyone else sees the order counts.
 * Tapping a day hands it to the day list, where past orders are opened and, for the owner,
 * corrected or voided under the existing step-up rules.
 */
export function MonthOverview({
  today,
  day,
  onPick,
  onClose,
}: {
  today: string;
  /** The business date the list is showing; the calendar opens on its month. */
  day: string;
  /** A date to show in the day list; `null` is today. */
  onPick: (day: string | null) => void;
  onClose: () => void;
}) {
  const tr = useT();
  const locale = useLocale();
  const layout = useLayout();
  const { api } = useServices();
  const canSeeSales = useAuthState().session?.permissions.includes('report.view') ?? false;
  const [month, setMonth] = useState(monthOf(day));
  const [load, setLoad] = useState<Load>('loading');
  const [totals, setTotals] = useState<Map<string, DayTotals>>(new Map());
  const [attempt, setAttempt] = useState(0);
  const phone = layout === 'phone';
  const thisMonth = monthOf(today);

  // `attempt` re-runs the load when the person taps "try again".
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let live = true;
    setLoad('loading');
    api.orders.summary({ month }).then(
      (summary) => {
        if (!live) return;
        setTotals(new Map(summary.days.map((d) => [d.date, d])));
        setLoad('ok');
      },
      () => {
        if (live) setLoad('error');
      },
    );
    return () => {
      live = false;
    };
  }, [api, month, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const all = [...totals.values()];
  const monthCount = all.reduce((sum, d) => sum + d.orderCount, 0);
  const monthSatang = all.reduce((sum, d) => sum + d.paidSatang, 0);
  const dateText = (date: string) => weekdayDate(Date.parse(`${date}T12:00:00+07:00`), locale);
  const money = (satang: number) => formatBaht(satang, locale, { decimals: 'auto' });

  const step = (delta: number) => {
    const next = shiftMonth(month, delta);
    if (next <= thisMonth) setMonth(next);
  };
  const navButton = s('width:48px;height:48px;padding:0;flex:none');
  const gap = phone ? 4 : 8;

  return (
    <section
      aria-labelledby="month-title"
      className="g-scroll"
      style={s(
        phone
          ? 'flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;padding:calc(env(safe-area-inset-top, 0px) + 16px) 12px 0;overflow-y:auto'
          : 'flex:1;min-height:0;display:flex;flex-direction:column;gap:14px;padding:10px 12px 8px 8px;overflow-y:auto',
      )}
    >
      <PageHeader id="month-title" title={tr('orders.month.title')} wrap>
        <button type="button" className="g-btn" style={s('min-height:48px')} onClick={onClose}>
          <Gi n="chevronLeft" size="sm" />
          {tr('orders.month.back')}
        </button>
      </PageHeader>

      <div style={s('display:flex;align-items:center;gap:8px;flex:none')}>
        <button
          type="button"
          className="g-btn g-btn-icon"
          style={navButton}
          aria-label={tr('orders.month.prev')}
          onClick={() => step(-1)}
        >
          <Gi n="chevronLeft" />
        </button>
        <h2 aria-live="polite" style={s('margin:0;flex:1;text-align:center;min-width:0')}>
          {monthLabel(month, locale)}
        </h2>
        <button
          type="button"
          className="g-btn g-btn-icon"
          style={navButton}
          aria-label={tr('orders.month.next')}
          disabled={month >= thisMonth}
          onClick={() => step(1)}
        >
          <Gi n="chevronRight" />
        </button>
        {month === thisMonth ? null : (
          <button
            type="button"
            className="g-btn"
            style={s('min-height:48px')}
            onClick={() => setMonth(thisMonth)}
          >
            {tr('orders.month.thisMonth')}
          </button>
        )}
      </div>

      {load === 'error' ? (
        <div
          className="g-sunk"
          role="alert"
          style={s(
            'display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;color:var(--chili-ink);font-weight:600',
          )}
        >
          <Gi n="warn" />
          <span style={s('flex:1 1 200px')}>{tr('orders.month.failed')}</span>
          <button type="button" className="g-btn" onClick={retry}>
            {tr('common.retry')}
          </button>
        </div>
      ) : null}

      <div className="g-t-s" role="status" style={s('flex:none;min-height:20px')}>
        {load === 'loading'
          ? tr('orders.month.loading')
          : load === 'ok' && canSeeSales
            ? tr('orders.month.total', { count: monthCount, amount: money(monthSatang) })
            : load === 'ok'
              ? tr('orders.month.totalCounts', { count: monthCount })
              : null}
      </div>

      <div
        aria-busy={load === 'loading'}
        style={s(
          `display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:${gap}px;flex:none`,
        )}
      >
        {weekdayHeadings(locale).map((name) => (
          <div
            key={name}
            aria-hidden="true"
            className="g-t-c"
            style={s('text-align:center;font-weight:600')}
          >
            {name}
          </div>
        ))}
        {calendarCells(month).map((date, index) => {
          if (!date) {
            // biome-ignore lint/suspicious/noArrayIndexKey: blank padding cells have no identity
            return <div key={`blank-${index}`} aria-hidden="true" />;
          }
          const entry = totals.get(date);
          const isToday = date === today;
          const count = entry?.orderCount ?? 0;
          const open = count > 0 || isToday;
          const label = !entry
            ? tr('orders.month.cellEmpty', { date: dateText(date) })
            : canSeeSales
              ? tr('orders.month.cell', {
                  date: dateText(date),
                  count,
                  amount: money(entry.paidSatang),
                })
              : tr('orders.month.cellCounts', { date: dateText(date), count });
          const background = isToday ? 'var(--amber-soft)' : count > 0 ? 'var(--glass)' : 'none';
          const border = isToday ? '2px solid var(--chili)' : '1px solid var(--line)';
          const cellStyle = {
            ...s(
              `display:flex;flex-direction:column;align-items:stretch;justify-content:space-between;gap:2px;min-height:${phone ? 62 : 92}px;padding:${phone ? '5px 3px' : '8px 10px'};border-radius:${phone ? 10 : 14}px;font:inherit;color:inherit;text-align:left;overflow:hidden;width:100%;height:100%;background:${background};border:${border};${open ? 'cursor:pointer' : 'opacity:.6'}`,
            ),
          };
          const body = (
            <>
              <span
                className="g-num"
                style={s(`font-size:${phone ? 12 : 14}px;font-weight:${isToday ? 800 : 500}`)}
              >
                {Number(date.slice(8))}
              </span>
              {count > 0 ? (
                <>
                  <span
                    className="g-num"
                    style={s(`font-size:${phone ? 17 : 24}px;font-weight:700;line-height:1`)}
                  >
                    {count}
                  </span>
                  {canSeeSales ? (
                    <span
                      className="g-num"
                      style={s(
                        `font-size:${phone ? 10 : 13}px;color:var(--jade-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis`,
                      )}
                    >
                      {entry?.paidSatang ? money(entry.paidSatang) : '–'}
                    </span>
                  ) : null}
                </>
              ) : null}
            </>
          );
          return (
            <div key={date} aria-current={isToday ? 'date' : undefined}>
              {open ? (
                <button
                  type="button"
                  aria-label={label}
                  style={cellStyle}
                  onClick={() => {
                    onPick(dayToOpen(date, today));
                    onClose();
                  }}
                >
                  {body}
                </button>
              ) : (
                <div role="img" aria-label={label} style={cellStyle}>
                  {body}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="g-t-c" style={s('margin:0 0 12px')}>
        {canSeeSales ? tr('orders.month.legend') : tr('orders.month.legendCounts')}
      </p>
    </section>
  );
}
