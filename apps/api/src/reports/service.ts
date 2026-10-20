/**
 * Reports (P6). Read-only: `@sds/db` loads the orders, `@sds/finance` does the maths, and this
 * only joins the two and shapes the response.
 */
import { type Db, reportsRepo } from '@sds/db';
import {
  favouriteItems,
  heatmap,
  itemSales,
  periodMargin,
  platformCommission,
  revenueByDay,
  segmentOf,
  segmentSummary,
  splitInconsistent,
} from '@sds/finance';
import {
  CUSTOMERS_LISTED,
  type CustomersReport,
  FAVOURITE_ITEMS_PER_CUSTOMER,
  type HeatmapReport,
  type ItemsReport,
  type RevenueReport,
  type RevenueReportQuery,
  type Satang,
  satang,
} from '@sds/shared';
import { currentPlatformCommission } from '../settings/service.ts';

/** The finance package works in plain integers; the wire type is branded satang. */
function brand<K extends string>(amounts: Partial<Record<K, number>>): Partial<Record<K, Satang>> {
  const out: Partial<Record<K, Satang>> = {};
  for (const key of Object.keys(amounts) as K[]) out[key] = satang(amounts[key] ?? 0);
  return out;
}

/**
 * Loads that are running right now, by database and range. The overview asks for the same range
 * three times at once (revenue, items, heatmap); they share one load. An entry is dropped the
 * moment its load ends, so a later request always reads fresh data.
 */
const loading = new WeakMap<Db, Map<string, Promise<ReturnType<typeof splitInconsistent>>>>();

/** The orders of a range, minus any whose refunds exceed their payment (named in the answer). */
export function loadReportOrders(db: Db, query: RevenueReportQuery) {
  let byRange = loading.get(db);
  if (!byRange) {
    byRange = new Map();
    loading.set(db, byRange);
  }
  const key = `${query.from}:${query.to}`;
  const running = byRange.get(key);
  if (running) return running;
  const started = reportsRepo
    .listReportOrders(db, query.from, query.to)
    .then(splitInconsistent)
    .finally(() => byRange.delete(key));
  byRange.set(key, started);
  return started;
}

export async function revenueReport(db: Db, query: RevenueReportQuery): Promise<RevenueReport> {
  const { usable, excludedOrderIds } = await loadReportOrders(db, query);
  const days = revenueByDay(usable);
  const margin = periodMargin(usable);
  const commissionSummary = platformCommission(usable, await currentPlatformCommission(db));
  let revenue = 0;
  let orderCount = 0;
  let commission = 0;
  for (const d of days) {
    revenue += d.revenueSatang;
    orderCount += d.orderCount;
    commission += d.commissionSatang;
  }
  return {
    from: query.from,
    to: query.to,
    excludedOrderIds,
    days: days.map((d) => ({
      ...d,
      revenueSatang: satang(d.revenueSatang),
      averageTicketSatang: satang(d.averageTicketSatang),
      commissionSatang: satang(d.commissionSatang),
      byChannel: brand(d.byChannel),
      byMethod: brand(d.byMethod),
    })),
    totals: {
      revenueSatang: satang(revenue),
      orderCount,
      commissionSatang: satang(commission),
    },
    margin: {
      ...margin,
      costedRevenueSatang: satang(margin.costedRevenueSatang),
      costSatang: satang(margin.costSatang),
      grossProfitSatang:
        margin.grossProfitSatang === null ? null : satang(margin.grossProfitSatang),
      uncostedRevenueSatang: satang(margin.uncostedRevenueSatang),
    },
    commission: {
      ...commissionSummary,
      recordedSatang: satang(commissionSummary.recordedSatang),
      estimatedSatang: satang(commissionSummary.estimatedSatang),
      totalSatang: satang(commissionSummary.totalSatang),
    },
  };
}

export async function itemsReport(db: Db, query: RevenueReportQuery): Promise<ItemsReport> {
  const { usable, excludedOrderIds } = await loadReportOrders(db, query);
  const items = itemSales(usable);
  return {
    from: query.from,
    to: query.to,
    excludedOrderIds,
    items: items.map((i) => ({
      ...i,
      revenueSatang: satang(i.revenueSatang),
      costedRevenueSatang: satang(i.costedRevenueSatang),
      costSatang: i.costSatang === null ? null : satang(i.costSatang),
      grossProfitSatang: i.grossProfitSatang === null ? null : satang(i.grossProfitSatang),
    })),
    uncostedMenuItemIds: items.filter((i) => i.costedQty < i.qty).map((i) => i.menuItemId),
  };
}

export async function customersReport(db: Db, now: Date): Promise<CustomersReport> {
  const [rows, units] = await Promise.all([
    reportsRepo.listReportCustomers(db),
    reportsRepo.listCustomerItemUnits(db),
  ]);
  const favourites = favouriteItems(units, FAVOURITE_ITEMS_PER_CUSTOMER);
  return {
    summary: segmentSummary(rows, now),
    customers: rows.slice(0, CUSTOMERS_LISTED).map((c) => ({
      id: c.id,
      name: c.name,
      building: c.building,
      segment: segmentOf(c, now),
      orderCount: c.orderCount,
      totalSpentSatang: satang(c.totalSpentSatang),
      firstSeenAt: c.firstSeenAt.toISOString(),
      lastOrderAt: c.lastOrderAt?.toISOString() ?? null,
      favourites: favourites.get(c.id) ?? [],
    })),
  };
}

export async function heatmapReport(db: Db, query: RevenueReportQuery): Promise<HeatmapReport> {
  const { usable, excludedOrderIds } = await loadReportOrders(db, query);
  return {
    from: query.from,
    to: query.to,
    excludedOrderIds,
    cells: heatmap(usable).map((c) => ({ ...c, revenueSatang: satang(c.revenueSatang) })),
  };
}
