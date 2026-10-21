import {
  listPrintJobsQuerySchema,
  orderIdParamSchema,
  printAckInputSchema,
  printJobIdParamSchema,
  reprintOrderInputSchema,
} from '@sds/shared';
import type { FastifyInstance } from 'fastify';
import { type Guard, type GuardFactory, principalOf, printAgentOf } from '../auth/guards.ts';
import { ApiError } from '../errors.ts';
import type { CoreContext } from '../tx.ts';
import { parse } from '../validate.ts';
import { ackPrintJob, claimPrintJob, listPrintJobs, reprintOrder } from './service.ts';

/**
 * Mounted at /v1 with no prefix of its own (like payments): `/v1/print/...` and
 * `/v1/orders/:id/reprint`.
 *
 * - The print program: `POST /print/claim` and `POST /print/jobs/:id/ack`, signed in by the
 *   `x-device-token` of a `print_agent` device (`printAgentGuard`). It polls: the answer is
 *   `{ job: null }` when nothing waits. It sends `{}` as the claim body (or no body at all).
 * - Staff: the list of recent jobs (any signed-in staff, like the order list) and the reprint
 *   (`order.create`: cashier, manager, owner; not the kitchen).
 */
export async function registerPrintRoutes(
  app: FastifyInstance,
  ctx: CoreContext,
  guard: GuardFactory,
  printAgentGuard: Guard,
): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.post('/print/claim', { onRequest: printAgentGuard }, async (request) =>
    claimPrintJob(ctx, printAgentOf(request).deviceId),
  );

  app.post('/print/jobs/:id/ack', { onRequest: printAgentGuard }, async (request) =>
    ackPrintJob(
      ctx,
      printAgentOf(request).deviceId,
      parse(printJobIdParamSchema, request.params).id,
      parse(printAckInputSchema, request.body),
    ),
  );

  app.get('/print/jobs', { onRequest: guard() }, async (request) => ({
    jobs: await listPrintJobs(ctx, parse(listPrintJobsQuerySchema, request.query).limit),
  }));

  app.post('/orders/:id/reprint', { onRequest: guard('order.create') }, async (request, reply) => {
    const input = parse(reprintOrderInputSchema, request.body);
    // The idempotency key is the request id in the body. A header, if sent, must say the same.
    const header = request.headers['idempotency-key'];
    if (
      header !== undefined &&
      String(header).toLowerCase() !== input.clientRequestId.toLowerCase()
    ) {
      throw new ApiError(
        400,
        'IDEMPOTENCY_KEY_MISMATCH',
        'Idempotency-Key must equal clientRequestId',
      );
    }
    const { job, replay } = await reprintOrder(
      ctx,
      principalOf(request),
      parse(orderIdParamSchema, request.params).id,
      input,
      { ip: request.ip ?? null },
    );
    return reply.status(replay ? 200 : 201).send(job);
  });
}
