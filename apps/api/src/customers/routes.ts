import {
  type AnonymizeCustomerResponse,
  anonymizeCustomerInputSchema,
  anonymizeCustomerResponseSchema,
  idParamSchema,
  type SlipFlagResponse,
  slipFlagClearInputSchema,
} from '@sds/shared';
import type { FastifyInstance } from 'fastify';
import { type GuardFactory, principalOf } from '../auth/guards.ts';
import type { AuthContext } from '../auth/service.ts';
import { ApiError } from '../errors.ts';
import type { SlipStore } from '../slips/store.ts';
import { parse } from '../validate.ts';
import { anonymizeCustomer, clearSlipFlag, getSlipFlag } from './service.ts';

/**
 * Mounted at /v1/customers. `POST /v1/customers/{id}/anonymize` erases a customer's personal data
 * (PDPA). The owner only (`customer.anonymize`), and it is a step-up permission, so it needs a
 * fresh step-up too. The body is optional: `{ reason?: 'customer_request' | 'retention' | 'other' }`.
 * Asking again for an erased customer is a 200 that changes nothing. It takes no Idempotency-Key,
 * because repeating it is already harmless.
 */
export async function registerCustomerRoutes(
  app: FastifyInstance,
  ctx: AuthContext,
  guard: GuardFactory,
  slips: SlipStore,
): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  /**
   * Staff-only slip flag (the bank-check service once said "fake slip"): read with `customer.view`,
   * cleared by the owner with step-up (`customer.slip_flag_clear`). The request id is the
   * idempotency key; Idempotency-Key, if sent, must say the same.
   */
  app.get(
    '/:id/slip-flag',
    { onRequest: guard('customer.view') },
    async (request): Promise<SlipFlagResponse> =>
      getSlipFlag(ctx, parse(idParamSchema, request.params).id),
  );

  app.post(
    '/:id/slip-flag/clear',
    { onRequest: guard('customer.slip_flag_clear') },
    async (request): Promise<SlipFlagResponse> => {
      const input = parse(slipFlagClearInputSchema, request.body);
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
      return clearSlipFlag(
        ctx,
        principalOf(request),
        parse(idParamSchema, request.params).id,
        input,
        { ip: request.ip ?? null },
      );
    },
  );

  app.post(
    '/:id/anonymize',
    { onRequest: guard('customer.anonymize') },
    async (request): Promise<AnonymizeCustomerResponse> => {
      const { id } = parse(idParamSchema, request.params);
      const input = parse(anonymizeCustomerInputSchema, request.body ?? {});
      const result = await anonymizeCustomer(
        ctx,
        principalOf(request),
        id,
        input,
        {
          ip: request.ip ?? null,
        },
        slips,
      );
      return anonymizeCustomerResponseSchema.parse(result);
    },
  );
}
