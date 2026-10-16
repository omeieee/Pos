/** Typed API client: orders: create, read, transition, correct, void, receipt. */
import {
  cancelOrderInputSchema,
  correctOrderInputSchema,
  createOrderInputSchema,
  issueReceiptInputSchema,
  listOrdersQuerySchema,
  listOrdersResponseSchema,
  orderDtoSchema,
  ordersSummaryQuerySchema,
  ordersSummaryResponseSchema,
  patchOrderInputSchema,
  receiptResponseSchema,
  transitionOrderInputSchema,
  voidOrderInputSchema,
} from '@sds/shared';
import type { z } from 'zod';
import { checked, newClientRequestId, type Transport } from '../http.ts';

export type NewOrderInput = Omit<z.input<typeof createOrderInputSchema>, 'clientRequestId'>;

export function makeOrders({ get, post, patch, orderPath }: Transport) {
  const orders = {
    /**
     * Creates an order. Pass the same `clientRequestId` on every retry of the same order; the
     * server then returns the original (`replay: true`). Without one, a fresh id is used.
     */
    create: async (input: NewOrderInput, options?: { clientRequestId?: string }) => {
      const clientRequestId = options?.clientRequestId ?? newClientRequestId();
      const { data, status } = await post({
        path: '/v1/orders',
        body: checked(createOrderInputSchema, { ...input, clientRequestId }),
        schema: orderDtoSchema,
        session: true,
        device: 'optional',
        headers: { 'Idempotency-Key': clientRequestId },
      });
      return { order: data, replay: status === 200, clientRequestId };
    },

    list: async (query: z.input<typeof listOrdersQuerySchema> = {}) =>
      (
        await get({
          path: '/v1/orders',
          query: checked(listOrdersQuerySchema, query),
          schema: listOrdersResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** Per business date of a month (`YYYY-MM`): orders and paid revenue, for the month overview. */
    summary: async (query: z.input<typeof ordersSummaryQuerySchema>) =>
      (
        await get({
          path: '/v1/orders/summary',
          query: checked(ordersSummaryQuerySchema, query),
          schema: ordersSummaryResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    get: async (id: string) =>
      (
        await get({
          path: orderPath(id),
          schema: orderDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** Note and room only; `expectedVersion` is required (VERSION_CONFLICT on a stale one). */
    patch: async (id: string, input: z.input<typeof patchOrderInputSchema>) =>
      (
        await patch({
          path: orderPath(id),
          body: checked(patchOrderInputSchema, input),
          schema: orderDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    transition: async (id: string, input: z.input<typeof transitionOrderInputSchema>) =>
      (
        await post({
          path: `${orderPath(id)}/transition`,
          body: checked(transitionOrderInputSchema, input),
          schema: orderDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    cancel: async (id: string, input: z.input<typeof cancelOrderInputSchema>) =>
      (
        await post({
          path: `${orderPath(id)}/cancel`,
          body: checked(cancelOrderInputSchema, input),
          schema: orderDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /**
     * The owner's correction of any order (quantities, lines, note). Owner only and a fresh step-up
     * (`auth.runSensitive`). Saved lines keep their sold price; the server recomputes every total.
     */
    correct: async (id: string, input: z.input<typeof correctOrderInputSchema>) =>
      (
        await patch({
          path: `${orderPath(id)}/correction`,
          body: checked(correctOrderInputSchema, input),
          schema: orderDtoSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /**
     * The owner voids any order that is not already cancelled. Owner only and a fresh step-up. A retry
     * of the same press passes the same `clientRequestId` (it is also the Idempotency-Key).
     */
    void: async (id: string, input: z.input<typeof voidOrderInputSchema>) =>
      (
        await post({
          path: `${orderPath(id)}/void`,
          body: checked(voidOrderInputSchema, input),
          schema: orderDtoSchema,
          session: true,
          device: 'optional',
          headers: { 'Idempotency-Key': input.clientRequestId },
        })
      ).data,

    /**
     * Issues the receipt of a paid order (RECEIPT_NOT_AVAILABLE until a payment is confirmed). Every
     * new `clientRequestId` is one audited issue; a retry of the same press passes the same id.
     */
    receipt: async (id: string, options?: { clientRequestId?: string }) => {
      const clientRequestId = options?.clientRequestId ?? newClientRequestId();
      const { data } = await post({
        path: `${orderPath(id)}/receipt`,
        body: checked(issueReceiptInputSchema, { clientRequestId }),
        schema: receiptResponseSchema,
        session: true,
        device: 'optional',
        headers: { 'Idempotency-Key': clientRequestId },
      });
      return { receipt: data, clientRequestId };
    },
  };

  return orders;
}
