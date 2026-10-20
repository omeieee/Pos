import { formatBaht } from '@sds/i18n';
import { PAYMENT_METHODS, type PaymentMethod } from '@sds/shared';
import { useState } from 'react';
import { Gi } from '../../design/icons.tsx';
import { useEntities, useLocale, useNow, useT } from '../../ui/hooks.ts';
import { Callout } from '../../ui/Notice.tsx';
import { currentBusinessDay } from '../orders/order-board.ts';
import { ExportButtons } from '../reports/ExportButtons.tsx';
import { FinancePage, LoadState, RangePicker, useDayText, useMonthText } from './FinanceParts.tsx';
import { OpeningCash } from './OpeningCash.tsx';
import { useCash, useRange } from './use-finance.ts';

const methodKey = (m: PaymentMethod) => `payment.method.${m}` as const;

/**
 * Receipts and payments (`#/cash`, owner only): the working record behind the Revenue Department's
 * รายงานเงินสดรับ-จ่าย. Every figure is the server's (`GET /v1/reports/cash`); this page formats it.
 * The shop has no cash drawer, so receipts are every payment method and the running figure is a net
 * from the owner's start amount, not a balance. It says plainly that it is a working record and not a
 * filed document or a bank statement, shows the running net only when a start amount is set, and ties
 * the receipts to the revenue report.
 */
export function CashScreen() {
  const tr = useT();
  const locale = useLocale();
  const dayText = useDayText();
  const monthText = useMonthText();
  const now = useNow(60_000);
  const today = currentBusinessDay(useEntities().settings, now);
  const period = useRange(today);
  const [emptyDays, setEmptyDays] = useState(false);
  const report = useCash(period.range, emptyDays);
  const money = (satang: number) => formatBaht(satang, locale);
  const orNone = (satang: number | null) =>
    satang === null ? tr('cash.running.none') : money(satang);
  const cash = report.data;

  return (
    <FinancePage
      id="cash-title"
      title={tr('cash.title')}
      subtitle={tr('cash.subtitle')}
      controls={period.range ? <ExportButtons range={period.range} kinds={['cash']} /> : null}
    >
      <RangePicker
        name="cash-range"
        choice={period.choice}
        custom={period.custom}
        result={period.result}
        onChoice={period.setChoice}
        onCustom={period.setCustom}
      />
      <label className="fin-check">
        <input
          type="checkbox"
          checked={emptyDays}
          onChange={(event) => setEmptyDays(event.target.checked)}
        />
        {tr('cash.emptyDays')}
      </label>

      <div role="note" className="g-sunk fin-info">
        <Gi n="info" size="sm" />
        <span className="fin-banner">
          <span>{tr('cash.workingRecord')}</span>
          <span>{tr('cash.assumptions')}</span>
          <span>{tr('cash.notBank')}</span>
          <span>{tr('cash.purchasesNote')}</span>
        </span>
      </div>

      <LoadState load={report.load} hasData={cash !== null} onRetry={report.reload} />

      <OpeningCash today={today} onSaved={report.reload} />

      {cash ? (
        <>
          {cash.complete ? null : (
            <Callout tone="warn" role="alert">
              {tr('cash.incomplete', { count: cash.excludedOrderIds.length })}
            </Callout>
          )}

          <div className="g-glass fin-card">
            <div className="g-t-2">{tr('cash.summary.title')}</div>
            <dl className="fin-lines">
              <div className="fin-line">
                <dt>{tr('cash.summary.receipts')}</dt>
                <dd>{money(cash.totals.receiptsSatang)}</dd>
              </div>
              <div className="fin-line">
                <dt>{tr('cash.summary.payments')}</dt>
                <dd>{money(cash.totals.paymentsSatang)}</dd>
              </div>
              <div className="fin-line fin-line--sub">
                <dt>
                  {tr('cash.summary.paymentsSplit', {
                    goods: money(cash.totals.purchasesSatang),
                    other: money(cash.totals.otherExpensesSatang),
                  })}
                </dt>
              </div>
              <div className="fin-line">
                <dt>{tr('cash.summary.difference')}</dt>
                <dd>{money(cash.totals.receiptsMinusPaymentsSatang)}</dd>
              </div>
              <div className="fin-line">
                <dt>{tr('cash.running.start')}</dt>
                <dd>{orNone(cash.runningStartSatang)}</dd>
              </div>
              <div className="fin-line fin-line--total">
                <dt>{tr('cash.running.end')}</dt>
                <dd className="fin-big">{orNone(cash.runningEndSatang)}</dd>
              </div>
            </dl>
            <p role="status" className="g-t-s fin-note">
              {cash.reconciliation.differenceSatang === 0
                ? tr('cash.reconcile.ok', { amount: money(cash.totals.receiptsSatang) })
                : tr('cash.reconcile.bad', {
                    amount: money(cash.totals.receiptsSatang),
                    revenue: money(cash.reconciliation.revenueReportSatang),
                    difference: money(cash.reconciliation.differenceSatang),
                  })}
            </p>
          </div>

          {cash.days.length === 0 ? <p className="g-t-s fin-note">{tr('cash.empty')}</p> : null}

          {cash.days.length > 0 ? (
            <div className="g-glass fin-card">
              <table className="fin-table" aria-label={tr('cash.table')}>
                <thead>
                  <tr>
                    <th scope="col" rowSpan={2}>
                      {tr('cash.col.date')}
                    </th>
                    <th scope="colgroup" colSpan={PAYMENT_METHODS.length + 1}>
                      {tr('cash.group.receipts')}
                    </th>
                    <th scope="colgroup" colSpan={3}>
                      {tr('cash.group.payments')}
                    </th>
                    <th scope="col" rowSpan={2}>
                      {tr('cash.col.running')}
                    </th>
                  </tr>
                  <tr>
                    {PAYMENT_METHODS.map((m) => (
                      <th key={m} scope="col">
                        {tr(methodKey(m))}
                      </th>
                    ))}
                    <th scope="col">{tr('cash.col.receipts')}</th>
                    <th scope="col">{tr('cash.col.purchases')}</th>
                    <th scope="col">{tr('cash.col.otherExpenses')}</th>
                    <th scope="col">{tr('cash.col.payments')}</th>
                  </tr>
                </thead>
                <tbody>
                  {cash.days.map((d) => (
                    <tr key={d.businessDate}>
                      <th scope="row">{dayText(d.businessDate)}</th>
                      {PAYMENT_METHODS.map((m) => (
                        <td key={m} data-label={tr(methodKey(m))}>
                          {money(d.receiptsByMethod[m])}
                        </td>
                      ))}
                      <td data-label={tr('cash.col.receipts')}>{money(d.receiptsSatang)}</td>
                      <td data-label={tr('cash.col.purchases')}>{money(d.purchasesSatang)}</td>
                      <td data-label={tr('cash.col.otherExpenses')}>
                        {money(d.otherExpensesSatang)}
                      </td>
                      <td data-label={tr('cash.col.payments')}>{money(d.paymentsSatang)}</td>
                      <td data-label={tr('cash.col.running')}>{orNone(d.runningNetSatang)}</td>
                    </tr>
                  ))}
                </tbody>
                {cash.days.length > 1 ? (
                  <tfoot>
                    <tr>
                      <th scope="row">{tr('cash.total')}</th>
                      {PAYMENT_METHODS.map((m) => (
                        <td key={m} data-label={tr(methodKey(m))}>
                          {money(cash.totals.receiptsByMethod[m])}
                        </td>
                      ))}
                      <td data-label={tr('cash.col.receipts')}>
                        {money(cash.totals.receiptsSatang)}
                      </td>
                      <td data-label={tr('cash.col.purchases')}>
                        {money(cash.totals.purchasesSatang)}
                      </td>
                      <td data-label={tr('cash.col.otherExpenses')}>
                        {money(cash.totals.otherExpensesSatang)}
                      </td>
                      <td data-label={tr('cash.col.payments')}>
                        {money(cash.totals.paymentsSatang)}
                      </td>
                      <td data-label={tr('cash.col.running')} />
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          ) : null}

          {cash.months.length > 0 ? (
            <div className="g-glass fin-card">
              <div className="g-t-2">{tr('cash.months.title')}</div>
              <table className="fin-table" aria-label={tr('cash.months.title')}>
                <thead>
                  <tr>
                    <th scope="col">{tr('pnl.months.col.month')}</th>
                    <th scope="col">{tr('cash.col.receipts')}</th>
                    <th scope="col">{tr(methodKey('cash'))}</th>
                    <th scope="col">{tr('cash.col.purchases')}</th>
                    <th scope="col">{tr('cash.col.otherExpenses')}</th>
                    <th scope="col">{tr('cash.col.payments')}</th>
                  </tr>
                </thead>
                <tbody>
                  {cash.months.map((m) => (
                    <tr key={m.month}>
                      <th scope="row">{monthText(m.month)}</th>
                      <td data-label={tr('cash.col.receipts')}>{money(m.receiptsSatang)}</td>
                      <td data-label={tr(methodKey('cash'))}>{money(m.cashInSatang)}</td>
                      <td data-label={tr('cash.col.purchases')}>{money(m.purchasesSatang)}</td>
                      <td data-label={tr('cash.col.otherExpenses')}>
                        {money(m.otherExpensesSatang)}
                      </td>
                      <td data-label={tr('cash.col.payments')}>{money(m.paymentsSatang)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
    </FinancePage>
  );
}
