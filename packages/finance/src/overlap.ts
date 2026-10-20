/**
 * The "larger of the two" rules for amounts that can describe the same money twice (P7, D-33/D-34
 * amendment, owner-approved 2026-10-21). One place, used by the P&L and the tax estimate so the two
 * cannot drift apart.
 *
 *   food cost      menu cost of goods (D-32 snapshots)  vs  `ingredients` ledger expenses
 *   platform fees  platform commission (D-32)            vs  `platform_fees` ledger expenses
 *
 * When BOTH amounts of a pair are above 0 in the period, only the larger is deducted; the smaller is
 * `notDeductedSatang`. Both raw numbers stay in the answers: nothing is removed from the ledger or
 * the order figures, the overlap is only not subtracted a second time. The tie goes to the first
 * name (cost of goods, commission): the amount left out is the same either way.
 *
 * `basis` says which one was deducted. `only_one` also covers "neither": there is nothing to choose
 * between, so nothing is left out. A zero is "no figure" (a recorded commission of 0 included).
 */
export type FoodCostBasis = 'cost_of_goods' | 'ingredients_expenses' | 'only_one';
export type PlatformFeesBasis = 'commission' | 'platform_fees_expenses' | 'only_one';

export interface Overlap<B extends string> {
  basis: B;
  /** The smaller of the two, 0 when `basis` is `only_one`. Add it back to profit, take it off expenses. */
  notDeductedSatang: number;
}

function larger<B extends string>(
  first: number,
  second: number,
  names: readonly [B, B],
  only: B,
): Overlap<B> {
  for (const v of [first, second]) {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new RangeError(`amount must be a whole number of satang, 0 or more, got ${v}`);
    }
  }
  if (first === 0 || second === 0) return { basis: only, notDeductedSatang: 0 };
  return {
    basis: first >= second ? names[0] : names[1],
    notDeductedSatang: Math.min(first, second),
  };
}

export function foodCostOverlap(
  costOfGoodsSatang: number,
  ingredientsExpensesSatang: number,
): Overlap<FoodCostBasis> {
  return larger(
    costOfGoodsSatang,
    ingredientsExpensesSatang,
    ['cost_of_goods', 'ingredients_expenses'],
    'only_one',
  );
}

export function platformFeesOverlap(
  commissionSatang: number,
  platformFeesExpensesSatang: number,
): Overlap<PlatformFeesBasis> {
  return larger(
    commissionSatang,
    platformFeesExpensesSatang,
    ['commission', 'platform_fees_expenses'],
    'only_one',
  );
}
