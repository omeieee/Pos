import { formatBaht } from '@sds/i18n';
import { useState } from 'react';
import { clockTime, weekdayDate } from '../../design/format.ts';
import { Gi } from '../../design/icons.tsx';
import { PageHeader } from '../../design/PageHeader.tsx';
import { s } from '../../design/style.ts';
import { useAuthState, useEntities, useLocale, useNow, useT } from '../../ui/hooks.ts';
import { ChannelCard } from '../reports/ChannelCard.tsx';
import { CustomersCard } from '../reports/CustomersCard.tsx';
import { ExportButtons } from '../reports/ExportButtons.tsx';
import { HeatmapCard } from '../reports/HeatmapCard.tsx';
import { ItemsCard } from '../reports/ItemsCard.tsx';
import { Delta, Kpi, VsPrevious } from '../reports/Kpi.tsx';
import { PendingCard } from '../reports/PendingCard.tsx';
import {
  averageTicket,
  channelShares,
  compare,
  type Period,
  periodRanges,
} from '../reports/report-model.ts';
import { excludedOrders, useCustomersReport, useReportData } from '../reports/use-report-data.ts';
import { SAMPLE_VAT } from './dashboard-sample.ts';
import { currentBusinessDay } from './order-board.ts';

const PERIODS = ['today', 'week', 'month', 'year'] as const;

/**
 * The back-office overview (`#/dashboard`, laptop design "ภาพรวม"). Every figure comes from the
 * report API (`/v1/reports/*`): paid orders only, net of refunds, grouped by business day, and
 * compared with the same stretch of the period before. The server does the sums; this only lays
 * them out. The VAT meter is still a labelled sample (tax estimates arrive with P7), and the
 * customer list and the CSV exports show only to the roles the API allows.
 */
export function DashboardScreen() {
  const tr = useT();
  const locale = useLocale();
  const now = useNow(60_000);
  const permissions = useAuthState().session?.permissions ?? [];
  const canSeeCustomers = permissions.includes('customer.report');
  const canExport = permissions.includes('data.export');
  const today = currentBusinessDay(useEntities().settings, now);
  const [period, setPeriod] = useState<Period>('today');
  const { load, data, reload } = useReportData(period, today);
  const customers = useCustomersReport(canSeeCustomers);
  const money = (satang: number) => formatBaht(satang, locale, { decimals: 'auto' });

  const current = data?.revenue.totals;
  const before = data?.previous.totals;
  const hasBefore = before !== undefined && before.orderCount > 0;
  const avg = current ? averageTicket(current.revenueSatang, current.orderCount) : 0;
  const avgBefore = before ? averageTicket(before.revenueSatang, before.orderCount) : 0;

  return (
    <section
      aria-labelledby="dashboard-title"
      className="g-scroll"
      style={s(
        'flex:1;min-height:0;display:flex;flex-direction:column;gap:20px;padding:10px 12px 8px 8px;overflow-y:auto',
      )}
    >
      <PageHeader
        id="dashboard-title"
        wrap
        title={tr('dash.title')}
        subtitle={tr('dash.updated', { date: weekdayDate(now, locale), time: clockTime(now) })}
      >
        <fieldset
          className="g-seg"
          aria-label={tr('dash.range.label')}
          style={s('border:0;margin:0')}
        >
          {PERIODS.map((value) => (
            <label key={value} className={`g-chip${value === period ? ' g-on' : ''}`}>
              <input
                type="radio"
                name="dash-range"
                checked={value === period}
                onChange={() => setPeriod(value)}
              />
              {tr(`dash.range.${value}`)}
            </label>
          ))}
        </fieldset>
        {canExport && <ExportButtons range={periodRanges(period, today).current} />}
      </PageHeader>
      <div role="note" className="g-sunk rpt-note g-t-s" style={s('color:var(--ink2)')}>
        <Gi n="info" size="sm" />
        <span>{tr('dash.live')}</span>
      </div>

      {load === 'loading' && !data && (
        <div role="status" className="g-t-s">
          {tr('dash.loading')}
        </div>
      )}
      {load === 'error' && (
        <div
          role="alert"
          className="g-sunk rpt-note"
          style={s('flex-wrap:wrap;color:var(--amber-ink);background:var(--amber-soft)')}
        >
          <Gi n="warn" size="sm" />
          <span style={s('font-weight:600')}>{tr('dash.error')}</span>
          <button type="button" className="g-btn" onClick={reload}>
            {tr('common.retry')}
          </button>
        </div>
      )}

      {data && current && (
        <>
          {excludedOrders(data).length > 0 && (
            <div
              data-testid="excluded-orders"
              className="g-sunk rpt-note"
              style={s('color:var(--amber-ink);background:var(--amber-soft)')}
            >
              <Gi n="warn" size="sm" />
              <span>{tr('dash.excluded', { count: excludedOrders(data).length })}</span>
            </div>
          )}
          <div
            style={s(
              'display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px',
            )}
          >
            <Kpi
              delay=".03s"
              color="var(--chili)"
              icon="cash"
              label={tr('dash.kpi.paid')}
              value={money(current.revenueSatang)}
            >
              {hasBefore && (
                <Delta unit="money" change={compare(current.revenueSatang, before.revenueSatang)} />
              )}
              <VsPrevious period={period} value={hasBefore ? money(before.revenueSatang) : null} />
            </Kpi>
            <Kpi
              delay=".07s"
              color="#3a3330"
              icon="receipt2"
              label={tr('dash.kpi.orders')}
              value={tr('dash.orderUnit', { count: current.orderCount })}
            >
              {hasBefore && (
                <Delta unit="count" change={compare(current.orderCount, before.orderCount)} />
              )}
              <VsPrevious
                period={period}
                value={hasBefore ? tr('dash.orderUnit', { count: before.orderCount }) : null}
              />
            </Kpi>
            <Kpi
              delay=".11s"
              color="#2457b8"
              icon="bag"
              label={tr('dash.kpi.avg')}
              value={money(avg)}
            >
              {hasBefore && <Delta unit="money" change={compare(avg, avgBefore)} />}
              <VsPrevious period={period} value={hasBefore ? money(avgBefore) : null} />
            </Kpi>
          </div>

          <div style={s('display:flex;flex-wrap:wrap;gap:16px')}>
            <HeatmapCard cells={data.heatmap.cells} />
            <ChannelCard shares={channelShares(data.revenue.days)} />
          </div>

          <div style={s('display:flex;flex-wrap:wrap;gap:16px')}>
            <ItemsCard items={data.items.items} />
            <PendingCard today={today} />
            <div className="g-glass g-rise rpt-card" style={s('--d:.35s')}>
              <div style={s('display:flex;align-items:baseline;gap:10px;flex-wrap:wrap')}>
                <div className="g-t-2" style={s('flex-grow:1')}>
                  {tr('dash.vat')}
                </div>
                <span className="g-badge g-b-mute" title={tr('dash.sample.hint')}>
                  <Gi n="info" />
                  {tr('dash.sample')}
                </span>
              </div>
              <div style={s('display:flex;align-items:baseline;gap:8px')}>
                <div className="g-num" style={s('font-size:36px;line-height:1.3;font-weight:600')}>
                  {SAMPLE_VAT.percent}%
                </div>
                <div className="g-t-s">{tr('dash.vatOf', { amount: SAMPLE_VAT.limit })}</div>
              </div>
              <div
                style={s(
                  'height:14px;border-radius:7px;background:rgba(70,35,20,.08);overflow:hidden',
                )}
              >
                <div
                  style={s(
                    `height:100%;width:${SAMPLE_VAT.percent}%;border-radius:7px;background:linear-gradient(90deg,#f5a524,#d63a2e)`,
                  )}
                />
              </div>
              <div className="g-t-s">{tr('dash.vatNote', { amount: SAMPLE_VAT.year })}</div>
              <div className="g-t-c">{tr('dash.vatDisclaimer')}</div>
            </div>
          </div>
        </>
      )}

      {canSeeCustomers && (
        <CustomersCard load={customers.load} report={customers.data} onRetry={customers.reload} />
      )}
    </section>
  );
}
