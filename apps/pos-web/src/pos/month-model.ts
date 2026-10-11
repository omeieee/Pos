/**
 * The calendar grid of the month overview as pure functions over `YYYY-MM` and `YYYY-MM-DD`
 * strings (no I/O, no money). Dates are business dates, so there is no time zone arithmetic:
 * the calendar is computed in UTC on the plain date.
 */
import type { Locale } from '@sds/i18n';

export const monthOf = (day: string): string => day.slice(0, 7);

/** The month `delta` months from `month` (negative goes back), across year ends. */
export function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  const at = year * 12 + (mon - 1) + delta;
  return `${Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, '0')}`;
}

/**
 * The cells of a month, Sunday first, as full weeks: `null` pads the days of the neighbouring
 * months, a date string is a day of this one.
 */
export function calendarCells(month: string): (string | null)[] {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  const lead = new Date(Date.UTC(year, mon - 1, 1)).getUTCDay();
  const length = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= length; d += 1) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

const tagOf = (locale: Locale) => (locale === 'th' ? 'th-TH-u-ca-buddhist' : 'en-GB-u-ca-gregory');

/** "ตุลาคม 2569" (Buddhist Era in Thai) or "October 2026". */
export function monthLabel(month: string, locale: Locale): string {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat(tagOf(locale), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, mon - 1, 15)));
}

/** "ส" "อา" ...: the seven weekday headings, Sunday first. */
export function weekdayHeadings(locale: Locale): string[] {
  const format = new Intl.DateTimeFormat(tagOf(locale), { weekday: 'short', timeZone: 'UTC' });
  // 2026-10-04 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(Date.UTC(2026, 9, 4 + i))));
}

/** What the day list should open for a tapped date: today is `null` (the live day), else the date. */
export const dayToOpen = (date: string, today: string): string | null =>
  date >= today ? null : date;
