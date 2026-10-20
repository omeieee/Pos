/**
 * The period picker of the finance screens, outside React. A preset (today, week, month, year) is
 * exactly the range of the overview (`periodRanges`); a custom range is two dates the person typed,
 * checked against the same limit the API enforces (`REPORT_MAX_DAYS`), so a bad range is told here
 * instead of coming back as a refusal.
 */
import { REPORT_MAX_DAYS, reportRangeDays } from '@sds/shared';
import { type DateRange, type Period, periodRanges } from '../reports/report-model.ts';

export type RangeChoice = Period | 'custom';
export const RANGE_CHOICES: readonly RangeChoice[] = ['today', 'week', 'month', 'year', 'custom'];

export type RangeResult =
  | { ok: true; range: DateRange }
  /** `missing`: a date is still empty (nothing to say yet); `invalid`: from is after to. */
  | { ok: false; problem: 'missing' | 'invalid' | 'tooLong' };

export function resolveRange(choice: RangeChoice, today: string, custom: DateRange): RangeResult {
  if (choice !== 'custom') return { ok: true, range: periodRanges(choice, today).current };
  if (custom.from === '' || custom.to === '') return { ok: false, problem: 'missing' };
  if (custom.from > custom.to) return { ok: false, problem: 'invalid' };
  if (reportRangeDays(custom.from, custom.to) > REPORT_MAX_DAYS) {
    return { ok: false, problem: 'tooLong' };
  }
  return { ok: true, range: { from: custom.from, to: custom.to } };
}
