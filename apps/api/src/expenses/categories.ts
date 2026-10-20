/**
 * Expense categories (D-31): the owner's list lives in `settings` under `expense_categories`. A
 * key can be switched off but never removed, because expenses already point at it. Not part of the
 * synced settings feed and not under /v1/settings (that is readable by cashiers).
 */
import {
  type Db,
  getSettingRow,
  insertAudit,
  insertSettingRow,
  lockSettingRow,
  type SettingRow,
  updateSettingRowIfVersion,
} from '@sds/db';
import {
  buyingGoodsKeys,
  DEFAULT_EXPENSE_CATEGORIES,
  type ExpenseCategories,
  type ExpenseCategoriesResponse,
  expenseCategoriesSchema,
  isBuyingGoods,
  missingCategoryKeys,
  type PutExpenseCategoriesInput,
} from '@sds/shared';
import type { AuthContext, Principal, RequestMeta } from '../auth/service.ts';
import { ApiError, versionConflict } from '../errors.ts';
import { withTransaction } from '../tx.ts';

export const SETTING_KEY = 'expense_categories';

export const unknownCategory = () =>
  new ApiError(422, 'UNKNOWN_EXPENSE_CATEGORY', 'That expense category does not exist or is off');

function toResponse(row: SettingRow | undefined): ExpenseCategoriesResponse {
  if (!row) return { value: DEFAULT_EXPENSE_CATEGORIES, version: 0, rev: 0, updatedAt: null };
  return {
    value: expenseCategoriesSchema.parse(row.value),
    version: row.version,
    rev: row.rev,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function readCategories(ctx: AuthContext): Promise<ExpenseCategoriesResponse> {
  return toResponse(await getSettingRow(ctx.db, SETTING_KEY));
}

/** Throws 422 unless `key` is an active category now (the saved list, or the nine defaults). */
export async function assertCategoryActive(db: Db, key: string): Promise<void> {
  const row = await getSettingRow(db, SETTING_KEY);
  const list = row ? expenseCategoriesSchema.parse(row.value) : DEFAULT_EXPENSE_CATEGORIES;
  if (!list.categories.some((c) => c.key === key && c.active)) throw unknownCategory();
}

/** The keys flagged "buying goods" now (the saved list, else the defaults), for the cash report. */
export async function currentBuyingGoodsKeys(db: Db): Promise<string[]> {
  const row = await getSettingRow(db, SETTING_KEY);
  const list = row ? expenseCategoriesSchema.parse(row.value) : DEFAULT_EXPENSE_CATEGORIES;
  return buyingGoodsKeys(list.categories);
}

/** Keys by what changed, for the audit row (names are the owner's own words, not personal data). */
function listChanges(before: ExpenseCategories, after: ExpenseCategories) {
  const old = new Map(before.categories.map((c) => [c.key, c]));
  const added: string[] = [];
  const deactivated: string[] = [];
  const reactivated: string[] = [];
  const renamed: string[] = [];
  const buyingGoodsChanged: string[] = [];
  for (const c of after.categories) {
    const was = old.get(c.key);
    if (!was) {
      added.push(c.key);
      continue;
    }
    if (was.active && !c.active) deactivated.push(c.key);
    if (!was.active && c.active) reactivated.push(c.key);
    if (was.nameTh !== c.nameTh || was.nameEn !== c.nameEn) renamed.push(c.key);
    if (isBuyingGoods(was) !== isBuyingGoods(c)) buyingGoodsChanged.push(c.key);
  }
  return { added, deactivated, reactivated, renamed, buyingGoodsChanged };
}

export async function putCategories(
  ctx: AuthContext,
  actor: Principal,
  input: PutExpenseCategoriesInput,
  meta: RequestMeta,
): Promise<ExpenseCategoriesResponse> {
  // The list is not a synced setting, so nothing is emitted: no frame carries it.
  return withTransaction(ctx, async (tx) => {
    const row = await lockSettingRow(tx, SETTING_KEY);
    const version = row?.version ?? 0;
    if (input.expectedVersion !== version) throw versionConflict(version);

    const current = row ? expenseCategoriesSchema.parse(row.value) : DEFAULT_EXPENSE_CATEGORIES;
    const next = expenseCategoriesSchema.parse({ categories: input.categories });
    const removed = missingCategoryKeys(current.categories, next.categories);
    if (removed.length > 0) {
      throw new ApiError(
        422,
        'EXPENSE_CATEGORY_REMOVED',
        'A category cannot be removed, only switched off',
        { keys: removed },
      );
    }
    if (row && JSON.stringify(current) === JSON.stringify(next)) return toResponse(row);

    const saved = row
      ? await updateSettingRowIfVersion(tx, SETTING_KEY, version, next, actor.staffId)
      : await insertSettingRow(tx, SETTING_KEY, next, actor.staffId);
    if (!saved) throw versionConflict(version + 1); // another request created or changed it first
    await insertAudit(tx, {
      actorType: 'staff',
      actorId: actor.staffId,
      deviceId: actor.deviceId,
      action: 'expense.categories_update',
      entity: 'settings',
      entityId: SETTING_KEY,
      after: listChanges(current, next),
      ip: meta.ip,
    });
    return toResponse(saved);
  });
}
