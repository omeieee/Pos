/**
 * Expense ledger use cases (D-31). Every write is one transaction that audits and publishes after
 * commit. Rows are never deleted: a mistake is voided. Amounts are positive integer satang from
 * the client; the only total is the server's sum in the list.
 */
import { expensesRepo, insertAudit } from '@sds/db';
import {
  type CreateExpenseInput,
  type ExpenseDto,
  type ExpenseList,
  type ListExpensesQuery,
  type PatchExpenseInput,
  satang,
  type VoidExpenseInput,
} from '@sds/shared';
import type { AuthContext, Principal, RequestMeta } from '../auth/service.ts';
import { conflict, notFound, versionConflict } from '../errors.ts';
import { currentBusinessDate } from '../orders/business-day.ts';
import { type Emit, withTransaction } from '../tx.ts';
import { assertCategoryActive } from './categories.ts';
import { toExpenseDto } from './dto.ts';
import { expenseRequestHash } from './request-hash.ts';

/** A create's answer. `replay` is true when the request id was seen before: nothing was written. */
export interface Created {
  dto: ExpenseDto;
  replay: boolean;
}

const actorOf = (actor: Principal, meta: RequestMeta) => ({
  actorType: 'staff' as const,
  actorId: actor.staffId,
  deviceId: actor.deviceId,
  ip: meta.ip,
});

const publish = (emit: Emit, row: expensesRepo.ExpenseRow) =>
  emit({ type: 'expense.upserted', id: row.id, rev: row.rev, data: toExpenseDto(row) });

const voided = () => conflict('EXPENSE_VOIDED', 'This expense was voided and cannot be changed');

// ---------- Create ----------

export async function createExpense(
  ctx: AuthContext,
  actor: Principal,
  input: CreateExpenseInput,
  meta: RequestMeta,
): Promise<Created> {
  const key = input.clientRequestId;
  const hash = expenseRequestHash(input);
  const replayOf = (row: expensesRepo.ExpenseRow): Created => {
    if (row.requestHash !== null && row.requestHash !== hash) {
      throw conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'This request id was already used for different content. Make a new request id for a new expense',
      );
    }
    return { dto: toExpenseDto(row), replay: true };
  };
  if (key !== undefined) {
    const existing = await expensesRepo.findExpenseByClientRequestId(ctx.db, key);
    if (existing) return replayOf(existing);
  }
  try {
    return { dto: await insertOnce(ctx, actor, input, hash, meta), replay: false };
  } catch (error) {
    if (key === undefined || !(error instanceof expensesRepo.DuplicateExpenseRequest)) throw error;
    const winner = await expensesRepo.findExpenseByClientRequestId(ctx.db, key);
    if (!winner) throw error;
    return replayOf(winner);
  }
}

function insertOnce(
  ctx: AuthContext,
  actor: Principal,
  input: CreateExpenseInput,
  hash: string,
  meta: RequestMeta,
): Promise<ExpenseDto> {
  return withTransaction(ctx, async (tx, emit) => {
    await assertCategoryActive(tx, input.category);
    // Any date is allowed, later ones too: customers may book in advance, so a cost can be known early.
    const businessDate = input.businessDate ?? (await currentBusinessDate(tx, ctx.now()));
    const row = await expensesRepo.insertExpense(tx, {
      businessDate,
      category: input.category,
      amountSatang: input.amountSatang,
      vendor: input.vendor ?? null,
      note: input.note ?? null,
      createdByStaffId: actor.staffId,
      ...(input.clientRequestId === undefined
        ? {}
        : { clientRequestId: input.clientRequestId, requestHash: hash }),
    });
    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action: 'expense.create',
      entity: 'expenses',
      entityId: row.id,
      after: { businessDate, category: row.category, amountSatang: row.amountSatang },
    });
    publish(emit, row);
    return toExpenseDto(row);
  });
}

// ---------- Patch and void ----------

const PATCHABLE = ['businessDate', 'category', 'amountSatang', 'vendor', 'note'] as const;

export async function patchExpense(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  input: PatchExpenseInput,
  meta: RequestMeta,
): Promise<ExpenseDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await expensesRepo.lockExpense(tx, id);
    if (!row) throw notFound('Expense');
    if (row.version !== input.expectedVersion) throw versionConflict(row.version);
    if (row.voidedAt) throw voided();

    const patch: expensesRepo.ExpensePatch = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const field of PATCHABLE) {
      const next = input[field];
      if (next === undefined || next === row[field]) continue;
      (patch as Record<string, unknown>)[field] = next;
      before[field] = row[field];
      after[field] = next;
    }
    if (Object.keys(patch).length === 0) return toExpenseDto(row);

    if (patch.category !== undefined) await assertCategoryActive(tx, patch.category);

    const updated = await expensesRepo.updateExpenseIfVersion(tx, id, row.version, patch);
    if (!updated) throw versionConflict(row.version);
    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action: 'expense.update',
      entity: 'expenses',
      entityId: id,
      before,
      after,
    });
    publish(emit, updated);
    return toExpenseDto(updated);
  });
}

/** Marks the expense void and keeps the row. No step-up: this is an expense, not a payment. */
export async function voidExpense(
  ctx: AuthContext,
  actor: Principal,
  id: string,
  input: VoidExpenseInput,
  meta: RequestMeta,
): Promise<ExpenseDto> {
  return withTransaction(ctx, async (tx, emit) => {
    const row = await expensesRepo.lockExpense(tx, id);
    if (!row) throw notFound('Expense');
    if (row.version !== input.expectedVersion) throw versionConflict(row.version);
    if (row.voidedAt) throw voided();

    const updated = await expensesRepo.updateExpenseIfVersion(tx, id, row.version, {
      voidedAt: ctx.now(),
      voidedByStaffId: actor.staffId,
      voidReason: input.reason,
    });
    if (!updated) throw versionConflict(row.version);
    await insertAudit(tx, {
      ...actorOf(actor, meta),
      action: 'expense.void',
      entity: 'expenses',
      entityId: id,
      before: { voided: false, amountSatang: row.amountSatang },
      after: { voided: true, reason: input.reason },
    });
    publish(emit, updated);
    return toExpenseDto(updated);
  });
}

// ---------- List ----------

export async function listExpenses(
  ctx: AuthContext,
  query: ListExpensesQuery,
): Promise<ExpenseList> {
  const rows = await expensesRepo.listExpenses(ctx.db, query.from, query.to);
  const total = rows.reduce((sum, r) => (r.voidedAt ? sum : sum + r.amountSatang), 0);
  return { expenses: rows.map(toExpenseDto), totalSatang: satang(total) };
}
