/**
 * Business date (D-11, 03 §1): the local date in the shop's time zone after
 * subtracting the cutoff, so sales before the cutoff count for the previous day.
 */
export const SHOP_TIME_ZONE = 'Asia/Bangkok';
export const DEFAULT_CUTOFF_MINUTES = 4 * 60;

const formatters = new Map<string, Intl.DateTimeFormat>();

function isoDateIn(timeZone: string, instant: Date): string {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    // en-CA formats as YYYY-MM-DD with the Gregorian calendar.
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, fmt);
  }
  return fmt.format(instant);
}

/** Returns the business date as an ISO `YYYY-MM-DD` string (Gregorian, for storage). */
export function businessDate(
  instant: Date,
  cutoffMinutes: number = DEFAULT_CUTOFF_MINUTES,
  timeZone: string = SHOP_TIME_ZONE,
): string {
  if (Number.isNaN(instant.getTime())) throw new RangeError('invalid instant');
  if (!Number.isInteger(cutoffMinutes) || cutoffMinutes < 0 || cutoffMinutes >= 24 * 60) {
    throw new RangeError(`cutoff must be an integer 0–1439 minutes, got ${cutoffMinutes}`);
  }
  return isoDateIn(timeZone, new Date(instant.getTime() - cutoffMinutes * 60_000));
}
