/**
 * The profit-and-loss page's arrangement, outside React. The server did every sum
 * (`GET /v1/reports/pnl`); this only joins category names to the expense lines and counts what the
 * answer lists as missing. No figure is computed here.
 */
import type { Locale } from '@sds/i18n';
import type { ExpenseCategoryEntry, PnlReport } from '@sds/shared';
import { categoryName } from './expense-model.ts';

export interface ExpenseLine {
  category: string;
  name: string;
  totalSatang: number;
  count: number;
}

/** The expense lines in the server's order, each with the category's name (the key if unknown). */
export const expenseRows = (
  lines: PnlReport['expensesByCategory'],
  categories: readonly ExpenseCategoryEntry[],
  locale: Locale,
): ExpenseLine[] =>
  lines.map((line) => ({
    category: line.category,
    name: categoryName(categories, line.category, locale),
    totalSatang: line.totalSatang,
    count: line.count,
  }));

/** What the "incomplete" banner lists. All counts come from the answer's own lists. */
export function incompleteDetails(pnl: PnlReport) {
  return {
    reasons: pnl.incompleteReasons,
    excluded: pnl.missing.excludedOrderIds.length,
    uncostedOrders: pnl.missing.uncostedOrderIds.length,
    uncostedItems: pnl.missing.uncostedMenuItemIds.length,
    uncostedRevenueSatang: pnl.uncostedRevenueSatang,
    rateNotSetOrders: pnl.missing.rateNotSetOrderIds.length,
    platformsNotSet: pnl.missing.ratesNotSet,
  };
}
