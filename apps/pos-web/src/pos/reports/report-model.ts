/**
 * The back-office overview as pure functions (no React, no I/O): which dates a period covers and
 * what it is compared with, how a change is described, how channels share the revenue, which
 * items lead and trail, and the weekday x hour grid. Money stays integer satang; the API did the
 * sums (`/v1/reports/*`), this only arranges them. Dates are business dates (`YYYY-MM-DD`), and
 * the arithmetic runs in UTC on the plain date, so there is no time zone in here.
 */

import type { Locale } from '@sds/i18n';
import type { DayRevenueDto, HeatCellDto, ItemSalesDto, OrderChannel } from '@sds/shared';
import { ORDER_CHANNELS } from '@sds/shared';

export type Period = 'today' | 'week' | 'month' | 'year';
export interface DateRange {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;
const at = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => iso(at(date) + n * DAY_MS);
const lastDayOfMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The range a period covers up to `today`, and the range it is compared with: the same span
 * one step back, so a half-finished week or month meets the same stretch of the one before and
 * the comparison is fair. A week starts on Monday.
 */
export function periodRanges(
  period: Period,
  today: string,
): { current: DateRange; previous: DateRange } {
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  switch (period) {
    case 'today': {
      const yesterday = addDays(today, -1);
      return { current: { from: today, to: today }, previous: { from: yesterday, to: yesterday } };
    }
    case 'week': {
      const sinceMonday = (new Date(at(today)).getUTCDay() + 6) % 7;
      const monday = addDays(today, -sinceMonday);
      return {
        current: { from: monday, to: today },
        previous: { from: addDays(monday, -7), to: addDays(today, -7) },
      };
    }
    case 'month': {
      const prevYear = month === 1 ? year - 1 : year;
      const prevMonth = month === 1 ? 12 : month - 1;
      const prevDay = Math.min(day, lastDayOfMonth(prevYear, prevMonth));
      return {
        current: { from: `${year}-${pad(month)}-01`, to: today },
        previous: {
          from: `${prevYear}-${pad(prevMonth)}-01`,
          to: `${prevYear}-${pad(prevMonth)}-${pad(prevDay)}`,
        },
      };
    }
    case 'year': {
      const prevDay = Math.min(day, lastDayOfMonth(year - 1, month));
      return {
        current: { from: `${year}-01-01`, to: today },
        previous: { from: `${year - 1}-01-01`, to: `${year - 1}-${pad(month)}-${pad(prevDay)}` },
      };
    }
  }
}

export interface Comparison {
  direction: 'up' | 'down' | 'flat';
  /** `current - previous`, satang or a count. */
  diff: number;
  /** Size of the change in tenths of a percent (43 = 4.3%), rounded half up; null with no earlier figure. */
  tenthsPercent: number | null;
}

/** How `current` differs from `previous`. Both are whole numbers. */
export function compare(current: number, previous: number): Comparison {
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(previous)) {
    throw new RangeError('compare needs whole numbers');
  }
  const diff = current - previous;
  const direction = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  const tenthsPercent =
    previous === 0 ? null : Math.floor((2 * Math.abs(diff) * 1000 + previous) / (2 * previous));
  return { direction, diff, tenthsPercent };
}

/**
 * The colour slot (1-5 of the categorical palette) of each channel. It belongs to the channel, not
 * to its rank, so a channel keeps its colour when another one has no sales.
 */
export const CHANNEL_SLOT: Record<OrderChannel, number> = {
  storefront: 1,
  line: 2,
  grab: 3,
  lineman: 4,
  phone: 5,
};

export interface ChannelShare {
  channel: OrderChannel;
  slot: number;
  amountSatang: number;
  /** Whole percent; the shares add up to exactly 100 (largest remainder). */
  percent: number;
}

export function channelShares(days: readonly Pick<DayRevenueDto, 'byChannel'>[]): ChannelShare[] {
  const totals = ORDER_CHANNELS.map((channel) => ({
    channel,
    amountSatang: days.reduce((sum, d) => sum + (d.byChannel[channel] ?? 0), 0),
  })).filter((c) => c.amountSatang > 0);
  const total = totals.reduce((sum, c) => sum + c.amountSatang, 0);
  if (total === 0) return [];
  const shares = totals.map((c) => ({
    ...c,
    percent: Math.floor((c.amountSatang * 100) / total),
    rest: (c.amountSatang * 100) % total,
  }));
  let left = 100 - shares.reduce((sum, s) => sum + s.percent, 0);
  for (const s of [...shares].sort((a, b) => b.rest - a.rest)) {
    if (left === 0) break;
    s.percent += 1;
    left -= 1;
  }
  return shares.map(({ channel, amountSatang, percent }) => ({
    channel,
    slot: CHANNEL_SLOT[channel],
    amountSatang,
    percent,
  }));
}

/** The first `n` of a best-first list. */
export const topItems = <T>(items: readonly T[], n: number): T[] => items.slice(0, n);

/** The last `n` of a best-first list, worst first, leaving out the first `skip` (already shown as top). */
export function bottomItems(items: readonly ItemSalesDto[], n: number, skip = 0): ItemSalesDto[] {
  return items.slice(skip).slice(-n).reverse();
}

export interface HeatRow {
  /** ISO weekday: Monday 1 ... Sunday 7. */
  weekday: number;
  /** Orders per hour, in the order of `HeatGrid.hours`. */
  counts: number[];
}

export interface HeatGrid {
  hours: number[];
  rows: HeatRow[];
  max: number;
}

const MIN_HOURS = 6;

export function heatGrid(cells: readonly HeatCellDto[]): HeatGrid {
  if (cells.length === 0) return { hours: [], rows: [], max: 0 };
  let lo = Math.min(...cells.map((c) => c.hour));
  let hi = Math.max(...cells.map((c) => c.hour));
  while (hi - lo + 1 < MIN_HOURS) {
    if (lo > 0) lo -= 1;
    if (hi - lo + 1 < MIN_HOURS && hi < 23) hi += 1;
  }
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const rows: HeatRow[] = Array.from({ length: 7 }, (_, i) => ({
    weekday: i + 1,
    counts: hours.map(() => 0),
  }));
  for (const c of cells) {
    const row = rows[c.weekday - 1];
    if (row) row.counts[c.hour - lo] = c.orderCount;
  }
  return { hours, rows, max: Math.max(...cells.map((c) => c.orderCount)) };
}

/** 0 for an empty cell, else 1-4 by how close to the busiest cell (a sequential ramp of four steps). */
export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4))) as 1 | 2 | 3 | 4;
}

/** Revenue over orders, rounded half up to one satang; 0 when there are no orders. */
export function averageTicket(revenueSatang: number, orderCount: number): number {
  if (orderCount === 0) return 0;
  return Math.floor((2 * revenueSatang + orderCount) / (2 * orderCount));
}

/** "จ." / "Mon": the short weekday of an ISO weekday number (Monday 1 ... Sunday 7). */
export function weekdayShort(weekday: number, locale: Locale): string {
  const tag = locale === 'th' ? 'th-TH-u-ca-buddhist' : 'en-GB-u-ca-gregory';
  // 2026-10-05 was a Monday.
  return new Intl.DateTimeFormat(tag, { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 9, 4 + weekday)),
  );
}
