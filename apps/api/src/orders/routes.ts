import {
  cancelOrderInputSchema,
  correctOrderInputSchema,
  createOrderInputSchema,
  issueReceiptInputSchema,
  listOrdersQuerySchema,
  orderIdParamSchema,
  patchOrderInputSchema,
  transitionOrderInputSchema,
  voidOrderInputSchema,
} from '@sds/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type GuardFactory, principalOf } from '../auth/guards.ts';
import { ApiError } from '../errors.ts';
import type { CoreContext } from '../tx.ts';
import { parse } from '../validate.ts';
import { correctOrder, voidOrder } from './correction.ts';
import { issueReceipt } from './receipt.ts';
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
  app.post('/', { onRequest: guard('order.create') }, async (request, reply) => {
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

  app.get('/', { onRequest: guard() }, async (request) =>
    listOrdersForDay(ctx, parse(listOrdersQuerySchema, request.query)),
  );

  app.get('/:id', { onRequest: guard() }, async (request) => getOrder(ctx, idOf(request)));

  app.patch('/:id', { onRequest: guard('order.create') }, async (request) =>
    patchOrder(ctx, idOf(request), parse(patchOrderInputSchema, request.body)),
  );

  app.post('/:id/transition', { onRequest: guard() }, async (request) =>
    transitionOrder(
      ctx,
      principalOf(request),
      idOf(request),
      parse(transitionOrderInputSchema, request.body),
    ),
  );

  // A receipt only for a confirmed payment; every issue is an audit row. Same permission as
  // listing an order's payments (cashier, manager, owner).
  app.post('/:id/receipt', { onRequest: guard('payment.record') }, async (request, reply) => {
    const input = parse(issueReceiptInputSchema, request.body);
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
    const { result, replay } = await issueReceipt(ctx, principalOf(request), idOf(request), input, {
      ip: request.ip ?? null,
    });
    return reply
      .header('cache-control', 'no-store')
      .status(replay ? 200 : 201)
      .send(result);
  });

  // The owner's correction and void of any order, paid or finished included (decision 2026-10-11).
  // `order.edit_past` is owner-only and asks for a fresh step-up in the guard.
  app.patch('/:id/correction', { onRequest: guard('order.edit_past') }, async (request) =>
    correctOrder(
      ctx,
      principalOf(request),
      idOf(request),
      parse(correctOrderInputSchema, request.body),
      { ip: request.ip ?? null },
    ),
  );

  app.post('/:id/void', { onRequest: guard('order.edit_past') }, async (request, reply) => {
    const input = parse(voidOrderInputSchema, request.body);
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
    const { order, replay } = await voidOrder(ctx, principalOf(request), idOf(request), input, {
      ip: request.ip ?? null,
    });
    return reply.status(replay ? 200 : 201).send(order);
  });

  app.post('/:id/cancel', { onRequest: guard() }, async (request) => {
    const input = parse(cancelOrderInputSchema, request.body);
    return transitionOrder(ctx, principalOf(request), idOf(request), { ...input, to: 'cancelled' });
  });
}
