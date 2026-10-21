import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { Db } from './client.ts';
import { expenses } from './schema.ts';

export type ExpenseRow = typeof expenses.$inferSelect;

export interface NewExpense {
  businessDate: string;
  category: string;
  amountSatang: number;
  vendor: string | null;
  note: string | null;
  createdByStaffId: string;
  /** Idempotency of the create route (migration 0037); both or neither. */
  clientRequestId?: string | undefined;
  requestHash?: string | undefined;
}

export type ExpensePatch = Partial<
  Pick<
    ExpenseRow,
    | 'businessDate'
    | 'category'
    | 'amountSatang'
    | 'vendor'
    | 'note'
    | 'voidedAt'
    | 'voidedByStaffId'
    | 'voidReason'
    | 'receiptImageKey'
    | 'receiptRequestId'
    | 'receiptRequestHash'
  >
>;

/**
 * A keyed insert found another expense with the same client request id (a concurrent request
 * committed first). Thrown so the caller's transaction rolls back; the caller then reads the winner.
 */
export class DuplicateExpenseRequest extends Error {
  constructor() {
    super('another request with the same client request id committed first');
    this.name = 'DuplicateExpenseRequest';
  }
}

export async function findExpenseByClientRequestId(
  db: Db,
  clientRequestId: string,
): Promise<ExpenseRow | undefined> {
  const [row] = await db
    .select()
    .from(expenses)
    .where(eq(expenses.clientRequestId, clientRequestId))
    .limit(1);
  return row;
}

export async function insertExpense(db: Db, input: NewExpense): Promise<ExpenseRow> {
  const [row] = await db
    .insert(expenses)
    .values(input)
    .onConflictDoNothing({ target: expenses.clientRequestId })
    .returning();
  if (!row) throw new DuplicateExpenseRequest();
  return row;
}

export async function findExpenseById(db: Db, id: string): Promise<ExpenseRow | undefined> {
  const [row] = await db.select().from(expenses).where(eq(expenses.id, id)).limit(1);
  return row;
}

/** Locks the row until the transaction ends. */
export async function lockExpense(db: Db, id: string): Promise<ExpenseRow | undefined> {
  const [row] = await db.select().from(expenses).where(eq(expenses.id, id)).for('update').limit(1);
  return row;
}

/** One UPDATE guarded by the version the caller saw; the sync trigger bumps version and rev. */
export async function updateExpenseIfVersion(
  db: Db,
  id: string,
  expectedVersion: number,
  patch: ExpensePatch,
): Promise<ExpenseRow | undefined> {
  const [row] = await db
    .update(expenses)
    .set(patch)
    .where(and(eq(expenses.id, id), eq(expenses.version, expectedVersion)))
    .returning();
  return row;
}

/** Every expense (voided ones too) whose business date is in the range, both ends included. */
export async function listExpenses(db: Db, from: string, to: string): Promise<ExpenseRow[]> {
  return db
    .select()
    .from(expenses)
    .where(and(gte(expenses.businessDate, from), lte(expenses.businessDate, to)))
    .orderBy(asc(expenses.businessDate), asc(expenses.id));
}
