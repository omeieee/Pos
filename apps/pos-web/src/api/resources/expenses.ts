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
import { ApiClientError } from '../errors.ts';
import { checked, errorFromResponse, newClientRequestId, type Transport } from '../http.ts';

export type NewExpenseInput = Omit<z.input<typeof createExpenseInputSchema>, 'clientRequestId'>;
export type ExpenseRange = z.input<typeof listExpensesQuerySchema>;

export function makeExpenses({
  get,
  patch,
  post,
  put,
  del,
  menuId,
  create,
  options,
  doFetch,
  buildUrl,
}: Transport) {
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

    /**
     * The receipt photo of an expense (D-36; the file stays on the server's photo store). Nothing
     * here is optimistic: the caller shows "pending" until the answer, and a 503
     * `RECEIPT_STORAGE_UNAVAILABLE` means photo storage is not set up yet.
     */
    receipt: {
      /**
       * Attaches or replaces the photo (JPEG or PNG, the server shrinks it). `requestId` is the
       * Idempotency-Key: pass the same one for every retry of the same picture.
       */
      attach: async (
        id: string,
        file: Blob,
        input: { expectedVersion: number; requestId?: string },
      ) => {
        const path = `${one(id)}/receipt`;
        if (
          !Number.isInteger(input.expectedVersion) ||
          input.expectedVersion < 1 ||
          file.size === 0
        ) {
          throw new ApiClientError('REQUEST_INVALID');
        }
        const requestId = input.requestId ?? newClientRequestId();
        const { data, status } = await post({
          path,
          query: { expectedVersion: String(input.expectedVersion) },
          rawBody: { data: file, contentType: file.type },
          schema: expenseDtoSchema,
          session: true,
          device: 'optional',
          headers: { 'Idempotency-Key': requestId },
        });
        return { row: data, replay: status === 200, requestId };
      },

      /**
       * The picture as a Blob. It is fetched with the session header (an `<img>` cannot send one),
       * shown from a blob URL that the caller revokes, and never stored.
       */
      read: async (id: string): Promise<Blob> => {
        const path = `${one(id)}/receipt`;
        const bearer = options.getSessionToken();
        if (!bearer) throw new ApiClientError('UNAUTHENTICATED', { status: 401 });
        const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
        const deviceToken = options.getDeviceToken();
        if (deviceToken) headers['X-Device-Token'] = deviceToken;
        let response: Response;
        try {
          response = await doFetch(buildUrl(path), {
            method: 'GET',
            headers,
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
          });
        } catch {
          throw new ApiClientError('NETWORK');
        }
        if (!response.ok) throw errorFromResponse(response.status, await response.text());
        return response.blob();
      },

      /** Takes the photo off; the expense stays. */
      remove: async (id: string, expectedVersion: number): Promise<ExpenseDto> => {
        if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
          throw new ApiClientError('REQUEST_INVALID');
        }
        return (
          await del({
            path: `${one(id)}/receipt`,
            query: { expectedVersion: String(expectedVersion) },
            schema: expenseDtoSchema,
            session: true,
            device: 'optional',
          })
        ).data;
      },
    },

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
