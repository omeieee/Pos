import type { MessageKey } from '@sds/i18n';
import { formatBaht } from '@sds/i18n';
import type { TaxReport } from '@sds/shared';
import { useState } from 'react';
import { Gi } from '../../design/icons.tsx';
import { bpToPercentText } from '../../settings/commission-model.ts';
import { useEntities, useLocale, useNow, useT } from '../../ui/hooks.ts';
import { Callout } from '../../ui/Notice.tsx';
import { SelectField } from '../../ui/TextField.tsx';
import { currentBusinessDay } from '../orders/order-board.ts';
import { AllowancesEditor } from './AllowancesEditor.tsx';
import { FinancePage, LoadState, useDayText } from './FinanceParts.tsx';
import { buddhistYear, reasonKey, splitNotes, yearChoices } from './tax-model.ts';
import { useTax, useTaxProfile } from './use-finance.ts';

type Period = 'annual' | 'half';
const PERIODS: readonly Period[] = ['annual', 'half'];

/** A rule's name for the sources list; a rule this app has no words for is shown by its key. */
const RULE_KEYS: Record<string, MessageKey> = {
  brackets: 'tax.rule.brackets',
  flatExpense: 'tax.rule.flatExpense',
  allowances: 'tax.rule.allowances',
  halfPercent: 'tax.rule.halfPercent',
  filing: 'tax.rule.filing',
  vat: 'tax.rule.vat',
  ePayment: 'tax.rule.ePayment',
};

function Estimate({ report }: { report: TaxReport }) {
  const tr = useT();
  const locale = useLocale();
  const money = (satang: number) => formatBaht(satang, locale);
  const method = (m: 'actual' | 'flat') => tr(`tax.method.${m}`);
  return (
    <section className="g-glass fin-card" aria-label={tr('tax.estimate.title')}>
      <div className="fin-card__head">
        <div className="g-t-2 fin-card__title">{tr('tax.estimate.title')}</div>
        <span className="g-badge g-b-mute">{tr('fin.estimate')}</span>
      </div>
      <div className="fin-big">{money(report.taxPayableSatang)}</div>
      <div className="g-t-s">
        {tr('tax.estimate.method', { method: method(report.chosenMethod) })}
      </div>
      <div className="g-t-c">{tr(`tax.chosenBy.${report.chosenBy}`)}</div>
      <div className="g-t-c">
        {report.cheaperMethod === report.chosenMethod
          ? tr('tax.cheaper.same')
          : tr('tax.cheaper.other', { method: method(report.cheaperMethod) })}
      </div>
    </section>
  );
}

function Compare({ report }: { report: TaxReport }) {
  const tr = useT();
  const locale = useLocale();
  const money = (satang: number) => formatBaht(satang, locale);
  const { actual, flat } = report.methods;
  const income = money(report.income.assessableSatang);
  const rows: { label: MessageKey; actual: string; flat: string; strong?: boolean }[] = [
    { label: 'tax.compare.income', actual: income, flat: income },
    {
      label: 'tax.compare.expenses',
      actual: money(actual.expenseSatang),
      flat: money(flat.expenseSatang),
    },
    {
      label: 'tax.compare.net',
      actual: money(actual.netBeforeAllowancesSatang),
      flat: money(flat.netBeforeAllowancesSatang),
    },
    {
      label: 'tax.compare.allowances',
      actual: money(actual.allowancesSatang),
      flat: money(flat.allowancesSatang),
    },
    {
      label: 'tax.compare.taxable',
      actual: money(actual.taxableNetSatang),
      flat: money(flat.taxableNetSatang),
    },
    {
      label: 'tax.compare.bracket',
      actual: money(actual.bracketTaxSatang),
      flat: money(flat.bracketTaxSatang),
    },
    {
      label: 'tax.compare.payable',
      actual: money(actual.payableSatang),
      flat: money(flat.payableSatang),
      strong: true,
    },
  ];
  const head = (m: 'actual' | 'flat') => (
    <th scope="col" className="fin-cmp__head">
      <span>{tr(`tax.method.${m}`)}</span>
      {report.chosenMethod === m ? (
        <span className="g-badge g-b-info">{tr('tax.compare.chosen')}</span>
      ) : null}
      {report.cheaperMethod === m && report.cheaperMethod !== report.chosenMethod ? (
        <span className="g-badge g-b-ok">{tr('tax.compare.cheaper')}</span>
      ) : null}
    </th>
  );
  return (
    <div className="g-glass fin-card">
      <div className="g-t-2">{tr('tax.compare.title')}</div>
      <table className="fin-cmp" aria-label={tr('tax.compare.title')}>
        <thead>
          <tr>
            <th scope="col" className="visually-hidden">
              {tr('tax.compare.title')}
            </th>
            {head('actual')}
            {head('flat')}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className={row.strong ? 'fin-cmp__strong' : undefined}>
              <th scope="row">{tr(row.label)}</th>
              <td>{row.actual}</td>
              <td>{row.flat}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HalfPercent({ block }: { block: NonNullable<TaxReport['halfPercent']> }) {
  const tr = useT();
  const locale = useLocale();
  const money = (satang: number) => formatBaht(satang, locale);
  return (
    <div className="g-glass fin-card">
      <div className="g-t-2">{tr('tax.half.title')}</div>
      <p className="g-t-s fin-note">
        {tr('tax.half.line', {
          rate: `${bpToPercentText(block.rateBasisPoints)}%`,
          amount: money(block.taxSatang),
        })}
      </p>
      <p className="g-t-s fin-note">
        {tr('tax.half.threshold', { amount: money(block.thresholdSatang) })}
      </p>
      <p className="g-t-s fin-note">
        {block.status === 'applied' ? tr('tax.half.applied') : tr('tax.half.notApplied')}
      </p>
      {block.thresholdStatus === 'conflict' ? (
        <p className="g-t-c fin-note">{tr('tax.half.conflict')}</p>
      ) : null}
    </div>
  );
}

function FilingAndWatch({ report }: { report: TaxReport }) {
  const tr = useT();
  const locale = useLocale();
  const dayText = useDayText();
  const money = (satang: number) => formatBaht(satang, locale);
  const { filing, watch } = report;
  const ePay = watch.ePayment;
  return (
    <>
      <div className="g-glass fin-card">
        <div className="g-t-2">{tr('tax.filing.title')}</div>
        <p className="g-t-s fin-note">
          {filing.mustFile
            ? tr('tax.filing.must', { amount: money(filing.incomeOverSatang) })
            : tr('tax.filing.notYet', { amount: money(filing.incomeOverSatang) })}
        </p>
        <p className="g-t-s fin-note">
          {tr('tax.filing.window', {
            from: dayText(filing.window.from),
            to: dayText(filing.window.to),
          })}
        </p>
        {filing.pastDue ? (
          <span className="g-badge g-b-bad">{tr('tax.filing.pastDue')}</span>
        ) : null}
      </div>
      <div className="g-glass fin-card">
        <div className="g-t-2">{tr('tax.watch.title')}</div>
        <div className="g-t-3">{tr('tax.watch.vat')}</div>
        <p className="g-t-s fin-note">
          {tr('tax.watch.vatLine', {
            revenue: money(watch.vat.revenueSatang),
            limit: money(watch.vat.registrationOverSatang),
            percent: watch.vat.percentOfThreshold,
          })}
        </p>
        <div>
          <span className={`g-badge ${watch.vat.status === 'below' ? 'g-b-ok' : 'g-b-warn'}`}>
            {tr(`tax.watch.vatStatus.${watch.vat.status}`)}
          </span>
        </div>
        <div className="g-t-3">{tr('tax.watch.ePayment')}</div>
        {ePay ? (
          <>
            <p className="g-t-s fin-note">
              {tr('tax.watch.ePaymentLine', {
                count: ePay.count,
                amount: money(ePay.totalSatang),
                limit: ePay.transferCount,
                altCount: ePay.altTransferCount,
                altAmount: money(ePay.altTotalSatang),
              })}
            </p>
            <div>
              <span className={`g-badge ${ePay.status === 'below' ? 'g-b-ok' : 'g-b-warn'}`}>
                {tr(`tax.watch.ePaymentStatus.${ePay.status}`)}
              </span>
            </div>
          </>
        ) : (
          <p className="g-t-s fin-note">{tr('tax.watch.ePaymentNone')}</p>
        )}
      </div>
    </>
  );
}

function Sources({ report }: { report: TaxReport }) {
  const tr = useT();
  const dayText = useDayText();
  return (
    <div className="g-glass fin-card">
      <div className="g-t-2">{tr('tax.sources.title')}</div>
      <ul className="fin-sources" aria-label={tr('tax.sources.title')}>
        {report.sources.map((source) => (
          <li key={`${source.rule}~${source.url}~${source.says}`} className="fin-source">
            <span className="g-t-3">
              {RULE_KEYS[source.rule] ? tr(RULE_KEYS[source.rule] as MessageKey) : source.rule}
            </span>
            <span className="g-t-s">{source.says}</span>
            <span className="g-t-c">
              {tr('tax.sources.checked', { date: dayText(source.checkedOn) })}
            </span>
            <a href={source.url} target="_blank" rel="noopener noreferrer">
              {tr('tax.sources.open')}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The income tax estimate (`#/tax`, owner only): a Buddhist Era year, the whole year (ภ.ง.ด.90) or
 * the half year (ภ.ง.ด.94). It is an estimate to plan with, never a filing, and says so on every
 * state of the page: the disclaimer, the rule year and the "proposed, confirm with the Revenue
 * Department" status are shown while loading, on failure and on success, and each rule links to the
 * Revenue Department page it came from. All the maths is the server's; this page lays it out and
 * saves the owner's allowances (a step-up call).
 */
export function TaxScreen() {
  const tr = useT();
  const now = useNow(60_000);
  const today = currentBusinessDay(useEntities().settings, now);
  const [year, setYear] = useState(() => buddhistYear(today));
  const [period, setPeriod] = useState<Period>('annual');
  const tax = useTax(year, period);
  const profile = useTaxProfile(year);
  // An answer for another year or return than the one selected is never shown.
  const report = tax.load === 'ok' ? tax.data : null;
  const shownYear = report?.ruleYear ?? year;
  const { warnings, notes } = report ? splitNotes(report) : { warnings: [], notes: [] };

  return (
    <FinancePage
      id="tax-title"
      title={tr('tax.title')}
      subtitle={tr('tax.subtitle')}
      controls={
        <>
          <SelectField
            label={tr('tax.year')}
            value={String(year)}
            onChange={(value) => setYear(Number(value))}
          >
            {yearChoices(today).map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </SelectField>
          <fieldset className="g-seg fin-seg" aria-label={tr('tax.period.label')}>
            {PERIODS.map((value) => (
              <label key={value} className={`g-chip${value === period ? ' g-on' : ''}`}>
                <input
                  type="radio"
                  name="tax-period"
                  checked={value === period}
                  onChange={() => setPeriod(value)}
                />
                {tr(`tax.period.${value}`)}
              </label>
            ))}
          </fieldset>
        </>
      }
    >
      <div className="fin-disclaimer">
        <Callout tone="info" icon="info" role="note">
          {tr('tax.disclaimer', { year: shownYear })}
        </Callout>
        <div className="fin-actions">
          <span className="g-badge g-b-warn">{tr('tax.status.proposed')}</span>
          {report ? (
            <span className="g-t-s">{tr('tax.ruleYear', { year: report.ruleYear })}</span>
          ) : null}
        </div>
      </div>

      <LoadState load={tax.load} hasData={report !== null} onRetry={tax.reload} error={tax.error} />

      {report ? (
        <>
          <DatesLine report={report} />
          {warnings.map((key) => (
            <Callout key={key} tone="warn" role="alert">
              <span>{tr(key)}</span>
              {key === 'tax.note.pnlIncomplete' && report.incompleteReasons.length > 0 ? (
                <ul className="fin-bullets" aria-label={tr('tax.reasons.title')}>
                  {report.incompleteReasons.map((reason) => {
                    const message = reasonKey(reason);
                    return message ? <li key={reason}>{tr(message)}</li> : null;
                  })}
                </ul>
              ) : null}
            </Callout>
          ))}
          <Estimate report={report} />
          <Compare report={report} />
          {report.halfPercent ? <HalfPercent block={report.halfPercent} /> : null}
          <FilingAndWatch report={report} />
        </>
      ) : null}

      <AllowancesEditor
        year={year}
        personalSatang={tax.data?.allowances.personalSatang ?? null}
        profile={profile}
        onSaved={tax.reload}
      />

      {report && notes.length > 0 ? (
        <div className="g-glass fin-card">
          <div className="g-t-2">{tr('tax.notes.title')}</div>
          <ul className="fin-bullets">
            {notes.map((key) => (
              <li key={key}>{tr(key)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {report ? <Sources report={report} /> : null}
    </FinancePage>
  );
}

function DatesLine({ report }: { report: TaxReport }) {
  const tr = useT();
  const dayText = useDayText();
  return (
    <div className="g-t-s fin-info">
      <Gi n="clock" size="sm" />
      <span>{report.form}</span>
      <span>
        {tr('tax.range', { from: dayText(report.range.from), to: dayText(report.range.to) })}
      </span>
      <span>{tr('tax.coversThrough', { date: dayText(report.coversThrough) })}</span>
    </div>
  );
}
