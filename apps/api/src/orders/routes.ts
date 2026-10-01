import {
  cancelOrderInputSchema,
  createOrderInputSchema,
  listOrdersQuerySchema,
  orderIdParamSchema,
  patchOrderInputSchema,
  transitionOrderInputSchema,
} from '@sds/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type GuardFactory, principalOf } from '../auth/guards.ts';
import { ApiError } from '../errors.ts';
import type { CoreContext } from '../tx.ts';
import { parse } from '../validate.ts';
import { createOrder, getOrder, listOrdersForDay, patchOrder, transitionOrder } from './service.ts';

const idOf = (request: FastifyRequest) => parse(orderIdParamSchema, request.params).id;

/**
 * Mounted at /v1/orders. Who may do what:
 * - create and PATCH: `order.create`;
 * - read: any signed-in staff (the kitchen needs the queue);
 * - transition and cancel: any signed-in staff, then the state machine decides per move.
 */
export async function registerOrderRoutes(
  app: FastifyInstance,
  ctx: CoreContext,
  guard: GuardFactory,
): Promise<void> {
  app.post('/', { preHandler: guard('order.create') }, async (request, reply) => {
    const input = parse(createOrderInputSchema, request.body);
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
    const { order, replay } = await createOrder(ctx, principalOf(request), input);
    return reply.status(replay ? 200 : 201).send(order);
  });

  app.get('/', { preHandler: guard() }, async (request) =>
    listOrdersForDay(ctx, parse(listOrdersQuerySchema, request.query)),
  );

  app.get('/:id', { preHandler: guard() }, async (request) => getOrder(ctx, idOf(request)));

  app.patch('/:id', { preHandler: guard('order.create') }, async (request) =>
    patchOrder(ctx, idOf(request), parse(patchOrderInputSchema, request.body)),
  );

  app.post('/:id/transition', { preHandler: guard() }, async (request) =>
    transitionOrder(
      ctx,
      principalOf(request),
      idOf(request),
      parse(transitionOrderInputSchema, request.body),
    ),
  );

  app.post('/:id/cancel', { preHandler: guard() }, async (request) => {
    const input = parse(cancelOrderInputSchema, request.body);
    return transitionOrder(ctx, principalOf(request), idOf(request), { ...input, to: 'cancelled' });
  });
}
