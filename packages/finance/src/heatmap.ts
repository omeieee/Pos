/**
 * Hour x weekday heatmap (P6). Pure. The weekday is the weekday of the order's `business_date`,
 * like every other report, so a 00:30 order sits under the previous day. The hour is the local
 * hour of `placed_at` in the shop's time zone (0-23), so the cells show when customers really
 * order. Revenue is net paid; only orders that count as revenue are included.
 */
import { SHOP_TIME_ZONE } from '@sds/shared';
import { isCounted, netPaidSatang, type ReportOrder } from './revenue.ts';

export interface HeatCell {
  /** ISO weekday: Monday 1 ... Sunday 7. */
  weekday: number;
  hour: number;
  orderCount: number;
  revenueSatang: number;
}

const hourFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: SHOP_TIME_ZONE,
  hour: '2-digit',
  hourCycle: 'h23',
});

function localHour(instant: Date): number {
  return Number(hourFormat.format(instant));
}

function isoWeekday(isoDate: string): number {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function heatmap(orders: readonly ReportOrder[]): HeatCell[] {
  const cells = new Map<number, HeatCell>();
  for (const order of orders) {
    if (!isCounted(order)) continue;
    const weekday = isoWeekday(order.businessDate);
    const hour = localHour(order.placedAt);
    const key = weekday * 24 + hour;
    const cell = cells.get(key) ?? { weekday, hour, orderCount: 0, revenueSatang: 0 };
    cell.orderCount += 1;
    cell.revenueSatang += netPaidSatang(order);
    cells.set(key, cell);
  }
  return [...cells.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
}
