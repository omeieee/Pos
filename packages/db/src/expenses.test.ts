import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as auth from './auth.ts';
import * as repo from './expenses.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';

let db: PgliteDb;
let client: PGlite;
let staffId: string;
beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
  staffId = (
    await auth.insertOwner(db, {
      email: 'o@example.test',
      displayName: 'o',
      passwordHash: 'x',
      pinHash: null,
      encryptTotpSecret: () => 'e',
      recoveryCodeHashes: [],
    })
  ).staffId;
}, 60_000);
afterAll(async () => {
  await client.close();
});

const input = (over: Partial<repo.NewExpense> = {}): repo.NewExpense => ({
  businessDate: '2026-10-20',
  category: 'gas',
  amountSatang: 25000,
  vendor: null,
  note: null,
  createdByStaffId: staffId,
  ...over,
});

describe('expenses', () => {
  test('any category key is stored: the old CHECK on the nine defaults is gone', async () => {
    const row = await repo.insertExpense(db, input({ category: 'lunch_boxes' }));
    expect(row).toMatchObject({ category: 'lunch_boxes', version: 1, voidedAt: null });
    expect(row.rev).toBeGreaterThan(0);
    expect(row.receiptImageKey).toBeNull();
  });

  test('a negative amount is still refused by the database', async () => {
    await expect(repo.insertExpense(db, input({ amountSatang: -1 }))).rejects.toThrow();
  });

  test('a keyed insert twice: the second throws DuplicateExpenseRequest, nothing is added', async () => {
    const key = crypto.randomUUID();
    const first = await repo.insertExpense(db, {
      ...input(),
      clientRequestId: key,
      requestHash: 'h',
    });
    await expect(
      repo.insertExpense(db, { ...input(), clientRequestId: key, requestHash: 'h' }),
    ).rejects.toBeInstanceOf(repo.DuplicateExpenseRequest);
    expect(await repo.findExpenseByClientRequestId(db, key)).toMatchObject({
      id: first.id,
      requestHash: 'h',
    });
  });

  test('update is guarded by the version and bumps version and rev', async () => {
    const row = await repo.insertExpense(db, input());
    expect(await repo.updateExpenseIfVersion(db, row.id, 99, { note: 'x' })).toBeUndefined();
    const updated = await repo.updateExpenseIfVersion(db, row.id, row.version, { note: 'x' });
    expect(updated).toMatchObject({ note: 'x', version: row.version + 1 });
    expect(updated?.rev).toBeGreaterThan(row.rev);
  });

  test('lockExpense finds a row or nothing', async () => {
    const row = await repo.insertExpense(db, input());
    expect((await repo.lockExpense(db, row.id))?.id).toBe(row.id);
    expect(await repo.lockExpense(db, crypto.randomUUID())).toBeUndefined();
  });

  test('a row cannot be deleted (the no-delete trigger)', async () => {
    const row = await repo.insertExpense(db, input());
    await expect(client.query('delete from expenses where id = $1', [row.id])).rejects.toThrow();
  });

  test('list by business date: inclusive range, oldest day first, voided rows included', async () => {
    const day = (businessDate: string, amountSatang: number) =>
      repo.insertExpense(db, input({ businessDate, amountSatang, category: 'rent' }));
    const a = await day('2031-01-02', 100);
    const b = await day('2031-01-01', 200);
    await day('2031-02-01', 300);
    await repo.updateExpenseIfVersion(db, a.id, a.version, {
      voidedAt: new Date(),
      voidedByStaffId: staffId,
      voidReason: 'typo',
    });
    const rows = await repo.listExpenses(db, '2031-01-01', '2031-01-31');
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(rows[1]?.voidedAt).not.toBeNull();
  });
});
