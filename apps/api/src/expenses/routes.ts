import {
  createExpenseInputSchema,
  listExpensesQuerySchema,
  patchExpenseInputSchema,
  putExpenseCategoriesInputSchema,
  voidExpenseInputSchema,
} from '@sds/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type GuardFactory, principalOf } from '../auth/guards.ts';
import type { AuthContext } from '../auth/service.ts';
import { ApiError } from '../errors.ts';
import { parse } from '../validate.ts';
import {
  createExpense,
  listExpenses,
  patchExpense,
  putCategories,
  readCategories,
  voidExpense,
} from './service.ts';

const meta = (request: FastifyRequest) => ({ ip: request.ip ?? null });
const idOf = (request: FastifyRequest) => parse(z.object({ id: z.uuid() }), request.params).id;

/** The idempotency key is `clientRequestId` in the body. An Idempotency-Key header, if sent, must say the same. */
function checkIdempotencyHeader(request: FastifyRequest, clientRequestId: string | undefined) {
  const header = request.headers['idempotency-key'];
  if (
    header !== undefined &&
    (clientRequestId === undefined ||
      String(header).toLowerCase() !== clientRequestId.toLowerCase())
  ) {
    throw new ApiError(
      400,
      'IDEMPOTENCY_KEY_MISMATCH',
      'Idempotency-Key must equal clientRequestId',
    );
  }
}

/**
 * Mounted at /v1/expenses. Every route needs `expense.edit` (owner, manager); cashiers and the
 * kitchen cannot even read the ledger. There is no DELETE: a mistake is voided. A create takes an
 * optional `clientRequestId`: the same id and content returns the row with 200, other content is
 * 409 IDEMPOTENCY_KEY_REUSED.
 */
export async function registerExpenseRoutes(
  app: FastifyInstance,
  ctx: AuthContext,
  guard: GuardFactory,
): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  const edit = { onRequest: guard('expense.edit') };
  // One URL, with no trailing-slash twin, so the route inventory has a single entry.
  const root = { ...edit, prefixTrailingSlash: 'no-slash' as const };

  app.get('', root, async (request) =>
    listExpenses(ctx, parse(listExpensesQuerySchema, request.query)),
  );
  app.post('', root, async (request, reply) => {
    const input = parse(createExpenseInputSchema, request.body);
    checkIdempotencyHeader(request, input.clientRequestId);
    const { dto, replay } = await createExpense(ctx, principalOf(request), input, meta(request));
    return reply.status(replay ? 200 : 201).send(dto);
  });

  app.get('/categories', edit, async () => readCategories(ctx));
  app.put('/categories', edit, async (request) =>
    putCategories(
      ctx,
      principalOf(request),
      parse(putExpenseCategoriesInputSchema, request.body),
      meta(request),
    ),
  );

  app.patch('/:id', edit, async (request) =>
    patchExpense(
      ctx,
      principalOf(request),
      idOf(request),
      parse(patchExpenseInputSchema, request.body),
      meta(request),
    ),
  );
  app.post('/:id/void', edit, async (request) =>
    voidExpense(
      ctx,
      principalOf(request),
      idOf(request),
      parse(voidExpenseInputSchema, request.body),
      meta(request),
    ),
  );
}
