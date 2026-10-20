/**
 * Platform commission (P7, D-31/D-32). Pure. It is an expense, reported beside revenue, never netted
 * from it. For each counted order:
 *
 * 1. a commission **recorded** on the order (`platformCommissionSatang`, 0 included) is the actual
 *    figure and always wins;
 * 2. otherwise, for a Grab or LINE MAN order, **estimate** = net paid × the platform's rate from
 *    settings (`applyBasisPoints`, half up);
 * 3. otherwise (no recorded figure and the platform's rate is not set) there is no number: the order
 *    is named in `rateNotSetOrderIds` and its platform in `ratesNotSet`. There is no built-in rate.
 *
 * Orders from other channels are never estimated; a recorded figure on one is still counted.
 */
import { applyBasisPoints, type OrderChannel, satang } from '@sds/shared';
import { isCounted, netPaidSatang, type ReportOrder } from './revenue.ts';

/** The per-platform rates in basis points, as saved in settings; null = not set. */
export interface PlatformRates {
  grabRateBp: number | null;
  linemanRateBp: number | null;
}

export type RatedPlatform = 'grab' | 'lineman';

export interface CommissionSummary {
  /** Σ of commissions recorded on orders. */
  recordedSatang: number;
  recordedOrderCount: number;
  /** Σ of rate-based estimates for platform orders with nothing recorded. */
  estimatedSatang: number;
  estimatedOrderCount: number;
  /** `recordedSatang + estimatedSatang`: only orders that have a number. */
  totalSatang: number;
  /** Platform orders with no recorded figure and no rate: the total does not include them. */
  rateNotSetOrderIds: string[];
  /** The platforms behind `rateNotSetOrderIds`, each once. */
  ratesNotSet: RatedPlatform[];
}

const rateOf = (channel: OrderChannel, rates: PlatformRates): number | null | undefined =>
  channel === 'grab' ? rates.grabRateBp : channel === 'lineman' ? rates.linemanRateBp : undefined;

export function platformCommission(
  orders: readonly ReportOrder[],
  rates: PlatformRates,
): CommissionSummary {
  let recorded = 0;
  let recordedCount = 0;
  let estimated = 0;
  let estimatedCount = 0;
  const rateNotSetOrderIds: string[] = [];
  const missing = new Set<RatedPlatform>();
  for (const order of orders) {
    if (!isCounted(order)) continue;
    if (order.platformCommissionSatang !== null) {
      if (!Number.isSafeInteger(order.platformCommissionSatang)) {
        throw new RangeError(
          `platform commission must be an integer, got ${order.platformCommissionSatang}`,
        );
      }
      recorded += order.platformCommissionSatang;
      recordedCount += 1;
      continue;
    }
    const rate = rateOf(order.channel, rates);
    if (rate === undefined) continue; // not a platform order
    if (rate === null) {
      rateNotSetOrderIds.push(order.id);
      missing.add(order.channel as RatedPlatform);
      continue;
    }
    estimated += applyBasisPoints(satang(netPaidSatang(order)), rate);
    estimatedCount += 1;
  }
  return {
    recordedSatang: recorded,
    recordedOrderCount: recordedCount,
    estimatedSatang: estimated,
    estimatedOrderCount: estimatedCount,
    totalSatang: recorded + estimated,
    rateNotSetOrderIds,
    ratesNotSet: [...missing],
  };
}
