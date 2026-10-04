import { DISPLAY_TIME_ZONE, type Locale } from '@sds/i18n';
import { type OpeningHours, openingHoursSchema, openingWindow } from '@sds/shared';

/** "อาทิตย์ 4 ต.ค. 2569": the weekday without the word "วัน", then the date in Buddhist Era (Thai). */
export function weekdayDate(value: number | Date, locale: Locale): string {
  const date = value instanceof Date ? value : new Date(value);
  const tag = locale === 'th' ? 'th-TH-u-ca-buddhist' : 'en-GB-u-ca-gregory';
  const weekday = new Intl.DateTimeFormat(tag, {
    weekday: 'long',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(date);
  const day = new Intl.DateTimeFormat(tag, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(date);
  return `${locale === 'th' ? weekday.replace(/^วัน/, '') : weekday} ${day}`;
}

/** 14:05 as shown on a ticket or a clock. */
export function clockTime(value: number | Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: DISPLAY_TIME_ZONE,
  }).format(value instanceof Date ? value : new Date(value));
}

const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** "10:00 – 15:00" for the storefront on the day of `now`, or null when the hours are unknown or closed. */
export function storefrontHoursText(data: unknown, now: number): string | null {
  const parsed = openingHoursSchema.safeParse(data);
  if (!parsed.success) return null;
  const hours: OpeningHours = parsed.data;
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const window = openingWindow(hours, day, 'storefront');
  return window ? `${hhmm(window.openMinute)} – ${hhmm(window.closeMinute)}` : null;
}
