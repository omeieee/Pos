/**
 * The profit-and-loss page's arrangement, outside React. The server did every sum
 * (`GET /v1/reports/pnl`); this only joins category names to the expense lines and counts what the
 * answer lists as missing. No figure is computed here.
 */
import type { Locale, MessageKey } from '@sds/i18n';
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

export interface OverlapNote {
  key: MessageKey;
  /** The amount that was deducted. */
  keptSatang: number;
  /** The amount of the other side: shown in the answer, not deducted (the smaller). */
  leftSatang: number;
}

/**
 * The notes for the two "larger of the two" pairs (owner-approved 2026-10-21). The server chose the
 * side (`foodCostBasis`, `platformFeesBasis`); this only names it. `only_one` has no note.
 */
export function overlapNotes(pnl: PnlReport): OverlapNote[] {
  const notes: OverlapNote[] = [];
  if (pnl.foodCostBasis === 'cost_of_goods') {
    notes.push({
      key: 'pnl.foodCost.costOfGoodsUsed',
      keptSatang: pnl.costOfGoodsSatang,
      leftSatang: pnl.ingredientsExpensesSatang,
    });
  } else if (pnl.foodCostBasis === 'ingredients_expenses') {
    notes.push({
      key: 'pnl.foodCost.ingredientsUsed',
      keptSatang: pnl.ingredientsExpensesSatang,
      leftSatang: pnl.costOfGoodsSatang,
    });
  }
  if (pnl.platformFeesBasis === 'commission') {
    notes.push({
      key: 'pnl.fees.commissionUsed',
      keptSatang: pnl.commissionSatang,
      leftSatang: pnl.platformFeesExpensesSatang,
    });
  } else if (pnl.platformFeesBasis === 'platform_fees_expenses') {
    notes.push({
      key: 'pnl.fees.expensesUsed',
      keptSatang: pnl.platformFeesExpensesSatang,
      leftSatang: pnl.commissionSatang,
    });
  }
  return notes;
}
