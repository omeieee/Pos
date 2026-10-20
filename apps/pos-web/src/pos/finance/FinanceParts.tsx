import { formatDate } from '@sds/i18n';
import type { ReactNode } from 'react';
import { errorText } from '../../api/errors.ts';
import { PageHeader } from '../../design/PageHeader.tsx';
import { useLocale, useT } from '../../ui/hooks.ts';
import { TextField } from '../../ui/TextField.tsx';
import type { DateRange } from '../reports/report-model.ts';
import { RANGE_CHOICES, type RangeChoice, type RangeResult } from './range-model.ts';
import type { Load } from './use-finance.ts';
import './finance.css';

/** The frame of a finance page: the overview's scrolling column with a header and its own controls. */
export function FinancePage({
  id,
  title,
  subtitle,
  controls,
  children,
}: {
  id: string;
  title: string;
  subtitle: string;
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="g-scroll fin-page">
      <PageHeader id={id} wrap title={title} subtitle={subtitle}>
        {controls}
      </PageHeader>
      {children}
    </section>
  );
}

/** A business date `YYYY-MM-DD` as a day in the language of the screen (Buddhist Era in Thai). */
export function useDayText() {
  const locale = useLocale();
  return (isoDate: string) => formatDate(`${isoDate}T12:00:00+07:00`, locale);
}

/**
 * Today, this week, this month, this year, or two dates of your own. The presets are the overview's
 * ranges; a custom range that is not valid says why and asks nothing of the API.
 */
export function RangePicker({
  name,
  choice,
  custom,
  result,
  onChoice,
  onCustom,
}: {
  name: string;
  choice: RangeChoice;
  custom: DateRange;
  result: RangeResult;
  onChoice: (choice: RangeChoice) => void;
  onCustom: (range: DateRange) => void;
}) {
  const tr = useT();
  const problem = !result.ok && result.problem !== 'missing' ? result.problem : null;
  return (
    <div className="fin-range">
      <fieldset className="g-seg fin-seg" aria-label={tr('fin.range.label')}>
        {RANGE_CHOICES.map((value) => (
          <label key={value} className={`g-chip${value === choice ? ' g-on' : ''}`}>
            <input
              type="radio"
              name={name}
              checked={value === choice}
              onChange={() => onChoice(value)}
            />
            {value === 'custom' ? tr('fin.range.custom') : tr(`dash.range.${value}`)}
          </label>
        ))}
      </fieldset>
      {choice === 'custom' ? (
        <div className="fin-dates">
          <TextField
            type="date"
            label={tr('fin.range.from')}
            value={custom.from}
            onChange={(from) => onCustom({ ...custom, from })}
          />
          <TextField
            type="date"
            label={tr('fin.range.to')}
            value={custom.to}
            onChange={(to) => onCustom({ ...custom, to })}
            error={
              problem === 'invalid'
                ? tr('fin.range.invalid')
                : problem === 'tooLong'
                  ? tr('fin.range.tooLong', { days: 366 })
                  : undefined
            }
          />
        </div>
      ) : null}
    </div>
  );
}

/** Loading and failure of a finance read, in one place. Renders nothing once the data is there. */
export function LoadState({
  load,
  hasData,
  onRetry,
  error,
}: {
  load: Load;
  hasData: boolean;
  onRetry: () => void;
  /** What failed, so a refusal with its own words (no rules for that year) is said as such. */
  error?: unknown;
}) {
  const tr = useT();
  if (load === 'loading' && !hasData) {
    return (
      <p role="status" className="g-t-s fin-quiet">
        {tr('common.loading')}
      </p>
    );
  }
  if (load === 'error') {
    return (
      <div role="alert" className="g-sunk fin-error">
        <span>{error ? errorText(tr, error) : tr('fin.error')}</span>
        <button type="button" className="g-btn" onClick={onRetry}>
          {tr('common.retry')}
        </button>
      </div>
    );
  }
  return null;
}
