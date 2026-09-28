import type { Locale } from './translate.ts';

export const DISPLAY_TIME_ZONE = 'Asia/Bangkok';

/** Thai shows Buddhist Era, English shows Gregorian (N10, D-12). */
const DATE_LOCALE: Record<Locale, string> = {
  th: 'th-TH-u-ca-buddhist',
  en: 'en-GB-u-ca-gregory',
};

const NUMBER_LOCALE: Record<Locale, string> = { th: 'th-TH', en: 'en-GB' };

export interface FormatBahtOptions {
  /** 'always' (default) shows 2 decimals; 'auto' drops ".00" for whole-baht menu prices. */
  decimals?: 'always' | 'auto';
}

/**
 * Formats integer satang as baht: 125075 → "฿1,250.75", -1250 → "-฿12.50".
 * No float math: baht and satang are split with integer remainder and exact division.
 */
export function formatBaht(
  satang: number,
  locale: Locale = 'th',
  options: FormatBahtOptions = {},
): string {
  if (!Number.isSafeInteger(satang)) {
    throw new RangeError(`satang must be a safe integer, got ${satang}`);
  }
  const abs = Math.abs(satang);
  const fraction = abs % 100;
  const baht = (abs - fraction) / 100;
  const grouped = new Intl.NumberFormat(NUMBER_LOCALE[locale], {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(baht);
  const showFraction = (options.decimals ?? 'always') === 'always' || fraction !== 0;
  const body = showFraction ? `${grouped}.${String(fraction).padStart(2, '0')}` : grouped;
  return `${satang < 0 ? '-' : ''}฿${body}`;
}

export type DateStyle = 'date' | 'dateTime' | 'time';

const STYLE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  date: { day: 'numeric', month: 'short', year: 'numeric' },
  dateTime: {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  },
  time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
};

/** Formats an instant in Asia/Bangkok: Thai "29 ก.ย. 2569", English "29 Sept 2026". */
export function formatDate(
  value: Date | string | number,
  locale: Locale = 'th',
  style: DateStyle = 'date',
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`invalid date: ${String(value)}`);
  return new Intl.DateTimeFormat(DATE_LOCALE[locale], {
    ...STYLE_OPTIONS[style],
    timeZone: DISPLAY_TIME_ZONE,
  }).format(date);
}
