/** Typed API client: kitchen printing (P8): the recent print jobs and the reprint of an order. */
import {
  listPrintJobsQuerySchema,
  listPrintJobsResponseSchema,
  printJobDtoSchema,
  reprintOrderInputSchema,
} from '@sds/shared';
import type { z } from 'zod';
import { checked, type Transport } from '../http.ts';

export function makePrint({ get, post, orderPath }: Transport) {
  return {
    /** The newest print jobs (any signed-in staff). No ticket and no personal data in them. */
    jobs: async (query: z.input<typeof listPrintJobsQuerySchema> = {}) => {
      const { limit } = checked(listPrintJobsQuerySchema, query);
      return (
        await get({
          path: '/v1/print/jobs',
          query: { limit: String(limit) },
          schema: listPrintJobsResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data;
    },

    /**
     * Prints an order again (cashier, manager, owner). One reprint per `clientRequestId`: a retry
     * with the same id answers the same job (status 200) and never makes a second one.
     */
    reprint: async (orderId: string, clientRequestId: string) => {
      const { data, status } = await post({
        path: `${orderPath(orderId)}/reprint`,
        body: checked(reprintOrderInputSchema, { clientRequestId }),
        schema: printJobDtoSchema,
        session: true,
        device: 'optional',
        headers: { 'Idempotency-Key': clientRequestId },
      });
      return { job: data, replay: status === 200 };
    },
  };
}
