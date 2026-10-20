/** Typed API client: the expense ledger and its category list (P7). `expense.edit`: owner and manager. */
import {
  createExpenseInputSchema,
  type ExpenseDto,
  expenseCategoriesResponseSchema,
  expenseDtoSchema,
  expenseListSchema,
  listExpensesQuerySchema,
  patchExpenseInputSchema,
  putExpenseCategoriesInputSchema,
  voidExpenseInputSchema,
} from '@sds/shared';
import type { z } from 'zod';
import { checked, type Transport } from '../http.ts';

export type NewExpenseInput = Omit<z.input<typeof createExpenseInputSchema>, 'clientRequestId'>;
export type ExpenseRange = z.input<typeof listExpensesQuerySchema>;

export function makeExpenses({ get, patch, post, put, menuId, create }: Transport) {
  const one = (id: string) => `/v1/expenses/${menuId(id)}`;
  return {
    /** The rows of the range, oldest first, voided ones included; `totalSatang` leaves them out. */
    list: async (range: ExpenseRange) =>
      (
        await get({
          path: '/v1/expenses',
          query: checked(listExpensesQuerySchema, range) as Record<string, string>,
          schema: expenseListSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /**
     * A new expense. `clientRequestId` is the idempotency key: a caller that may retry makes it
     * once and passes it on every attempt (same id and same content answers 200 with the row).
     */
    create: (input: NewExpenseInput, options?: { clientRequestId?: string }) =>
      create('/v1/expenses', createExpenseInputSchema, expenseDtoSchema, input, options),

    /** A correction: only the fields given change; `expectedVersion` is the row's version. */
    patch: async (id: string, body: z.input<typeof patchExpenseInputSchema>): Promise<ExpenseDto> =>
      (
        await patch({
          path: one(id),
          body: checked(patchExpenseInputSchema, body),
          schema: expenseDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** A mistake is voided with a reason, never deleted. */
    void: async (id: string, body: z.input<typeof voidExpenseInputSchema>): Promise<ExpenseDto> =>
      (
        await post({
          path: `${one(id)}/void`,
          body: checked(voidExpenseInputSchema, body),
          schema: expenseDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** The shop's category list (never saved: the nine built-in ones at version 0). */
    categories: {
      read: async () =>
        (
          await get({
            path: '/v1/expenses/categories',
            schema: expenseCategoriesResponseSchema,
            session: true,
            device: 'optional',
          })
        ).data,
      /** Replaces the whole list; a key may be switched off but never left out. */
      save: async (body: z.input<typeof putExpenseCategoriesInputSchema>) =>
        (
          await put({
            path: '/v1/expenses/categories',
            body: checked(putExpenseCategoriesInputSchema, body),
            schema: expenseCategoriesResponseSchema,
            session: true,
            device: 'optional',
          })
        ).data,
    },
  };
}
