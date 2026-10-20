/**
 * The income tax estimate (P7, D-34). Read only, owner only. `@sds/finance` does the maths and holds
 * the rules (data per tax year); this loads the P&L of the period, the owner's tax profile and the
 * PromptPay payments, and shapes the answer. A year with no rules file is refused: another year's
 * numbers are never used.
 */
import { type Db, taxProfilesRepo } from '@sds/db';
import {
  estimateTax,
  incomingPromptpayTransfers,
  taxRulesFor,
  taxYearsAvailable,
} from '@sds/finance';
import {
  businessDate,
  type TaxReport,
  type TaxReportQuery,
  taxProfileValueSchema,
  taxReportSchema,
} from '@sds/shared';
import { ApiError } from '../errors.ts';
import { loadReportOrders, pnlReport } from './service.ts';

/** B.E. to Gregorian: 2569 is 2026. */
const gregorian = (beYear: number) => beYear - 543;

export async function taxReport(db: Db, query: TaxReportQuery, now: Date): Promise<TaxReport> {
  const rules = taxRulesFor(query.year);
  if (!rules) {
    throw new ApiError(422, 'TAX_RULES_NOT_AVAILABLE', 'There are no tax rules for that year yet', {
      year: query.year,
      available: taxYearsAvailable(),
    });
  }
  const ce = gregorian(query.year);
  const range = {
    from: `${ce}-01-01`,
    to: query.period === 'half' ? `${ce}-06-30` : `${ce}-12-31`,
  };
  const [pnl, { usable }, row] = await Promise.all([
    pnlReport(db, range),
    loadReportOrders(db, range),
    taxProfilesRepo.getTaxProfile(db, query.year),
  ]);
  const profile = row
    ? taxProfileValueSchema.parse({
        allowances: row.allowances,
        methodPreference: row.methodPreference,
      })
    : { allowances: { items: [] }, methodPreference: null };
  const ingredients = pnl.expensesByCategory.find((c) => c.category === 'ingredients');

  const estimate = estimateTax({
    rules,
    period: query.period,
    range,
    asOf: businessDate(now),
    grossIncomeSatang: pnl.revenueSatang,
    expenses: {
      costOfGoodsSatang: pnl.costOfGoodsSatang,
      commissionSatang: pnl.commissionSatang,
      ledgerSatang: pnl.expensesSatang,
      ingredientsLedgerSatang: ingredients?.totalSatang ?? 0,
    },
    pnlComplete: pnl.complete,
    allowanceItems: profile.allowances.items,
    methodPreference: profile.methodPreference,
    incomingTransfers: incomingPromptpayTransfers(usable),
  });
  return taxReportSchema.parse({ ...estimate, incompleteReasons: pnl.incompleteReasons });
}
