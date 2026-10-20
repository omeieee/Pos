import { DISPLAY_TIME_ZONE, formatBaht } from '@sds/i18n';
import type { PnlReport } from '@sds/shared';
import { Gi } from '../../design/icons.tsx';
import { useEntities, useLocale, useNow, useT } from '../../ui/hooks.ts';
import { Callout } from '../../ui/Notice.tsx';
import { currentBusinessDay } from '../orders/order-board.ts';
import { FinancePage, LoadState, RangePicker } from './FinanceParts.tsx';
import { expenseRows, incompleteDetails } from './pnl-model.ts';
import { useExpenseCategories, usePnl, useRange } from './use-finance.ts';

/** "ต.ค. 2569" / "Oct 2026" for a `YYYY-MM` month. */
function useMonthText() {
  const locale = useLocale();
  const tag = locale === 'th' ? 'th-TH-u-ca-buddhist' : 'en-GB-u-ca-gregory';
  const format = new Intl.DateTimeFormat(tag, {
    month: 'short',
    year: 'numeric',
    timeZone: DISPLAY_TIME_ZONE,
  });
  return (month: string) => format.format(new Date(`${month}-15T12:00:00+07:00`));
}

function IncompleteBanner({ pnl }: { pnl: PnlReport }) {
  const tr = useT();
  const locale = useLocale();
  const d = incompleteDetails(pnl);
  const money = (satang: number) => formatBaht(satang, locale);
  const platforms = d.platformsNotSet.map((p) => tr(`orders.channel.${p}`)).join(', ');
  const needsCosts = d.uncostedOrders > 0 || d.uncostedItems > 0;
  const needsRates = d.platformsNotSet.length > 0 || d.rateNotSetOrders > 0;
  return (
    <div className="gcall gcall--warn" role="alert">
      <Gi n="warn" size="sm" />
      <div className="gcall__text fin-banner">
        <strong>{tr('pnl.incomplete.title')}</strong>
        <span>{tr('pnl.incomplete.note')}</span>
        <ul className="fin-bullets">
          {d.reasons.map((reason) => (
            <li key={reason}>{tr(`pnl.reason.${reason}`)}</li>
          ))}
          {d.excluded > 0 ? <li>{tr('pnl.count.excluded', { count: d.excluded })}</li> : null}
          {d.uncostedOrders > 0 ? (
            <li>
              {tr('pnl.count.uncostedOrders', {
                count: d.uncostedOrders,
                amount: money(d.uncostedRevenueSatang),
              })}
            </li>
          ) : null}
          {d.uncostedItems > 0 ? (
            <li>{tr('pnl.count.uncostedItems', { count: d.uncostedItems })}</li>
          ) : null}
          {needsRates ? (
            <li>{tr('pnl.count.rateNotSet', { platforms, count: d.rateNotSetOrders })}</li>
          ) : null}
        </ul>
        {needsCosts || needsRates ? (
          <div className="fin-actions">
            {needsCosts ? (
              <a className="g-btn" href="#/settings/menu">
                {tr('pnl.fix.costs')}
              </a>
            ) : null}
            {needsRates ? (
              <a className="g-btn" href="#/settings/platform-commission">
                {tr('pnl.fix.rates')}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Line({
  label,
  amount,
  sub,
  total,
  children,
}: {
  label: string;
  amount?: string;
  sub?: boolean;
  total?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={`fin-line${sub ? ' fin-line--sub' : ''}${total ? ' fin-line--total' : ''}`}>
      <dt>{label}</dt>
      {amount !== undefined ? (
        <dd className={total ? 'fin-big' : undefined}>
          {amount}
          {children}
        </dd>
      ) : null}
    </div>
  );
}

/**
 * Profit and loss (`#/pnl`, owner only). Every figure is the server's (`GET /v1/reports/pnl`):
 * revenue, cost of goods, gross profit, commission, expenses by category, and net profit before
 * income tax. While anything is missing the answer says `complete: false` and this page says so
 * first, loudly: the profit shown can then only be too high. Nothing is added up here.
 */
export function PnlScreen() {
  const tr = useT();
  const locale = useLocale();
  const monthText = useMonthText();
  const now = useNow(60_000);
  const today = currentBusinessDay(useEntities().settings, now);
  const period = useRange(today);
  const report = usePnl(period.range);
  const categories = useExpenseCategories();
  const money = (satang: number) => formatBaht(satang, locale);
  const pnl = report.data;

  return (
    <FinancePage id="pnl-title" title={tr('pnl.title')} subtitle={tr('pnl.subtitle')}>
      <RangePicker
        name="pnl-range"
        choice={period.choice}
        custom={period.custom}
        result={period.result}
        onChoice={period.setChoice}
        onCustom={period.setCustom}
      />
      <LoadState load={report.load} hasData={pnl !== null} onRetry={report.reload} />

      {pnl ? (
        <>
          <div role="note" className="g-sunk fin-info">
            <Gi n="info" size="sm" />
            <span>{tr('pnl.estimateNote')}</span>
          </div>
          {pnl.complete ? null : <IncompleteBanner pnl={pnl} />}
          {pnl.platformFeesAlsoCommission ? (
            <Callout tone="warn" role="status">
              {tr('pnl.feesTwice')}
            </Callout>
          ) : null}
          {pnl.orderCount === 0 ? <p className="g-t-s fin-note">{tr('pnl.empty')}</p> : null}

          <div className="g-glass fin-card">
            <fieldset aria-label={tr('pnl.title')} className="fin-fieldset">
              <dl className="fin-lines">
                <Line label={tr('pnl.line.revenue')} amount={money(pnl.revenueSatang)} />
                <Line sub label={tr('pnl.line.orders', { count: pnl.orderCount })} />
                {pnl.uncostedRevenueSatang > 0 ? (
                  <Line
                    sub
                    label={tr('pnl.line.uncosted', { amount: money(pnl.uncostedRevenueSatang) })}
                  />
                ) : null}
                <Line label={tr('pnl.line.cost')} amount={money(pnl.costOfGoodsSatang)} />
                <Line label={tr('pnl.line.gross')} amount={money(pnl.grossProfitSatang)} />
                <Line label={tr('pnl.line.commission')} amount={money(pnl.commissionSatang)} />
                {pnl.commission.recordedOrderCount > 0 ? (
                  <Line
                    sub
                    label={tr('pnl.line.commissionRecorded', {
                      amount: money(pnl.commission.recordedSatang),
                    })}
                  />
                ) : null}
                {pnl.commission.estimatedOrderCount > 0 ? (
                  <Line
                    sub
                    label={tr('pnl.line.commissionEstimated', {
                      amount: money(pnl.commission.estimatedSatang),
                    })}
                  />
                ) : null}
                <Line label={tr('pnl.line.expenses')} amount={money(pnl.expensesSatang)} />
                {expenseRows(pnl.expensesByCategory, categories.categories, locale).map((row) => (
                  <Line
                    key={row.category}
                    sub
                    label={tr('pnl.line.expenseRow', { name: row.name, count: row.count })}
                    amount={money(row.totalSatang)}
                  />
                ))}
                <Line total label={tr('pnl.line.net')} amount={money(pnl.netProfitSatang)}>
                  {pnl.netProfitSatang < 0 ? (
                    <span className="g-badge g-b-bad fin-loss">{tr('pnl.loss')}</span>
                  ) : null}
                </Line>
              </dl>
            </fieldset>
            {pnl.voidedExpenseCount > 0 ? (
              <p className="g-t-c fin-note">
                {tr('pnl.voidedExpenses', { count: pnl.voidedExpenseCount })}
              </p>
            ) : null}
          </div>

          <div className="g-glass fin-card">
            <div className="g-t-2">{tr('pnl.copay.title')}</div>
            <p className="g-t-s fin-note">
              {tr('pnl.copay.revenue', { amount: money(pnl.govCopay.revenueSatang) })}
            </p>
            <p className="g-t-s fin-note">{tr('pnl.copay.receivable')}</p>
          </div>

          {pnl.months.length > 0 ? (
            <div className="g-glass fin-card">
              <div className="g-t-2">{tr('pnl.months.title')}</div>
              <table className="fin-table" aria-label={tr('pnl.months.title')}>
                <thead>
                  <tr>
                    <th scope="col">{tr('pnl.months.col.month')}</th>
                    <th scope="col">{tr('pnl.months.col.revenue')}</th>
                    <th scope="col">{tr('pnl.months.col.cost')}</th>
                    <th scope="col">{tr('pnl.months.col.gross')}</th>
                    <th scope="col">{tr('pnl.months.col.commission')}</th>
                    <th scope="col">{tr('pnl.months.col.expenses')}</th>
                    <th scope="col">{tr('pnl.months.col.net')}</th>
                    <th scope="col">{tr('pnl.months.col.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pnl.months.map((m) => (
                    <tr key={m.month}>
                      <th scope="row">{monthText(m.month)}</th>
                      <td data-label={tr('pnl.months.col.revenue')}>{money(m.revenueSatang)}</td>
                      <td data-label={tr('pnl.months.col.cost')}>{money(m.costOfGoodsSatang)}</td>
                      <td data-label={tr('pnl.months.col.gross')}>{money(m.grossProfitSatang)}</td>
                      <td data-label={tr('pnl.months.col.commission')}>
                        {money(m.commissionSatang)}
                      </td>
                      <td data-label={tr('pnl.months.col.expenses')}>{money(m.expensesSatang)}</td>
                      <td data-label={tr('pnl.months.col.net')}>{money(m.netProfitSatang)}</td>
                      <td data-label={tr('pnl.months.col.status')}>
                        {m.complete ? tr('pnl.months.complete') : tr('pnl.months.incomplete')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="g-t-c fin-note">{tr('pnl.months.partial')}</p>
            </div>
          ) : null}
        </>
      ) : null}
    </FinancePage>
  );
}
