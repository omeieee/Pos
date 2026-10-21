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
import type { SlipStore } from '../slips/store.ts';
import { parse } from '../validate.ts';
import { attachReceipt, readReceipt, removeReceipt } from './receipt.ts';
import { MAX_RECEIPT_BYTES } from './receipt-image.ts';
import {
  createExpense,
  listExpenses,
  patchExpense,
  putCategories,
  readCategories,
  voidExpense,
} from './service.ts';

const meta = (request: FastifyRequest) => ({ ip: request.ip ?? null });
const versionQuery = z.object({ expectedVersion: z.coerce.number().int().positive() });
const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
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
 *
 * Receipt photos (D-36) live in `receipts`, a store of their own that no job sweeps:
 * `POST|GET|DELETE /:id/receipt`, same `expense.edit` permission.
 */
export async function registerExpenseRoutes(
  app: FastifyInstance,
  ctx: AuthContext,
  guard: GuardFactory,
  receiptStore: SlipStore | null,
): Promise<void> {
  // Without R2 there is nowhere safe to keep 5-year records (the slips volume has no off-site copy), so no photo is taken or read.
  const receipts = (): SlipStore => {
    if (!receiptStore) {
      throw new ApiError(503, 'RECEIPT_STORAGE_UNAVAILABLE', 'Receipt photo storage is not set up');
    }
    return receiptStore;
  };
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

  app.get('/:id/receipt', edit, async (request, reply) => {
    const { bytes, contentType } = await readReceipt(
      ctx,
      receipts(),
      principalOf(request),
      idOf(request),
      meta(request),
    );
    // A shop receipt can carry a name or a phone number: never sniffed, never framed or cached.
    return reply
      .header('content-type', contentType)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('referrer-policy', 'no-referrer')
      .send(bytes);
  });
  app.delete('/:id/receipt', edit, async (request) =>
    removeReceipt(
      ctx,
      receipts(),
      principalOf(request),
      idOf(request),
      parse(versionQuery, request.query).expectedVersion,
      meta(request),
    ),
  );

  // The photo is the request body (Content-Type image/jpeg or image/png; webp is read as bytes only
  // so that it gets our own 415). Only this scope reads those types, as raw bytes; the guard runs
  // in onRequest, before a byte of the body is read.
  await app.register(async (upload) => {
    for (const type of RECEIPT_TYPES) {
      upload.addContentTypeParser(
        type,
        { parseAs: 'buffer', bodyLimit: MAX_RECEIPT_BYTES + 1024 },
        (_request, body, done) => done(null, body),
      );
    }
    upload.post(
      '/:id/receipt',
      { ...edit, bodyLimit: MAX_RECEIPT_BYTES + 1024 },
      async (request, reply) => {
        if (!Buffer.isBuffer(request.body)) {
          throw new ApiError(415, 'RECEIPT_TYPE_UNSUPPORTED', 'Send a JPEG or PNG picture');
        }
        const requestId = parse(z.object({ 'idempotency-key': z.uuid() }), {
          'idempotency-key': request.headers['idempotency-key'],
        })['idempotency-key'];
        const { dto, replay } = await attachReceipt(
          ctx,
          receipts(),
          principalOf(request),
          idOf(request),
          {
            bytes: request.body,
            requestId,
            expectedVersion: parse(versionQuery, request.query).expectedVersion,
          },
          meta(request),
        );
        return reply.status(replay ? 200 : 201).send(dto);
      },
    );
  });
}
