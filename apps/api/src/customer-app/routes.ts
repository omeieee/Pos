import {
  appOrderInputSchema,
  customerSessionRequestSchema,
  orderIdParamSchema,
  selectPaymentInputSchema,
} from '@sds/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/service.ts';
import { ApiError } from '../errors.ts';
import { LiffUnavailableError } from '../line/liff-verify.ts';
import type { LineRuntime } from '../line/runtime.ts';
import { parse } from '../validate.ts';
import {
  acknowledgePrivacy,
  checkoutInfo,
  claimPayment,
  getMyOrder,
  listMyOrders,
  myQr,
  openSession,
  placeOrder,
  selectPayment,
} from './service.ts';
import { createCustomerGuard, customerOf } from './session.ts';

const meta = (request: FastifyRequest) => ({ ip: request.ip ?? null });
const orderIdOf = (request: FastifyRequest) => parse(orderIdParamSchema, request.params).id;

/**
 * Mounted at /v1/app: the customer app (`apps/liff-web`) and nothing else.
 *
 * - `POST /session` is open to the internet by nature: it trades a LIFF token that LINE confirms
 *   for a customer session (`session.ts`). It is rate limited per address, and the answer for a
 *   bad token is always the same 401.
 * - Every other route runs the customer guard in `onRequest` and answers only about the customer
 *   in the session. A staff session does not work here and a customer session does not work on
 *   the staff routes. Limits: per address, and per customer on top (a per-customer ceiling that a
 *   shared mobile address cannot use up for everyone).
 * - Answers are personal data (names, buildings) and money state: never cached.
 */
export async function registerCustomerAppRoutes(
  app: FastifyInstance,
  ctx: AuthContext,
  runtime: LineRuntime,
): Promise<void> {
  if (typeof app.rateLimit !== 'function') {
    throw new Error('the customer routes need @fastify/rate-limit to be registered first');
  }
  app.decorateRequest('customer', null);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  const guard = createCustomerGuard(ctx);
  // Mobile networks put many customers behind one address, so the address limit is generous; the
  // per-customer limits are what stop one person from hammering the shop.
  const byAddress = app.rateLimit({ max: 300, timeWindow: '1 minute' });
  const byCustomer = (max: number) =>
    app.rateLimit({
      max,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.customer?.customerId ?? request.ip,
    });
  const reads = { onRequest: [byAddress, guard, byCustomer(120)] };
  const writes = { onRequest: [byAddress, guard, byCustomer(30)] };

  app.post(
    '/session',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const credential = parse(customerSessionRequestSchema, request.body);
      if (!runtime.liffVerifier) {
        throw new ApiError(
          503,
          'LIFF_NOT_CONFIGURED',
          'The customer app is not set up on this server',
        );
      }
      let who: { userId: string } | null;
      try {
        who = await runtime.liffVerifier.verify(credential);
      } catch (error) {
        if (error instanceof LiffUnavailableError) {
          throw new ApiError(503, 'LINE_UNAVAILABLE', 'LINE could not be reached. Try again');
        }
        throw error;
      }
      if (!who) {
        const refused = runtime.liffHealth.rejected(ctx.now());
        if (refused.overThreshold) {
          // A count only: never the token, a user id or an address.
          request.log.warn({ refusals: refused.count }, 'LIFF verification refused repeatedly');
        }
        if (refused.alert) {
          ctx.events.publish({
            type: 'alert.security',
            kind: 'liff.verify_failing',
            severity: 'warn',
            at: ctx.now().toISOString(),
            staffId: null,
            deviceId: null,
          });
        }
        throw new ApiError(401, 'LIFF_TOKEN_INVALID', 'Sign in with LINE again');
      }
      runtime.liffHealth.accepted();
      return openSession(ctx, who.userId);
    },
  );

  app.get('/checkout', reads, async (request) => checkoutInfo(ctx, customerOf(request)));

  app.post('/privacy-ack', writes, async (request) => acknowledgePrivacy(ctx, customerOf(request)));

  app.post('/orders', { onRequest: [byAddress, guard, byCustomer(10)] }, async (request, reply) => {
    const input = parse(appOrderInputSchema, request.body);
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
    const result = await placeOrder(ctx, customerOf(request), input, meta(request));
    return reply.status(result.replay ? 200 : 201).send(result);
  });

  app.get('/orders', reads, async (request) => listMyOrders(ctx, customerOf(request)));

  app.get('/orders/:id', reads, async (request) =>
    getMyOrder(ctx, customerOf(request), orderIdOf(request)),
  );

  app.post('/orders/:id/payment', writes, async (request) =>
    selectPayment(
      ctx,
      customerOf(request).customerId,
      orderIdOf(request),
      parse(selectPaymentInputSchema, request.body),
      meta(request),
    ),
  );

  app.post('/orders/:id/claim', writes, async (request) =>
    claimPayment(ctx, customerOf(request).customerId, orderIdOf(request), meta(request)),
  );

  app.get('/orders/:id/qr', reads, async (request) =>
    myQr(ctx, customerOf(request).customerId, orderIdOf(request)),
  );
}
