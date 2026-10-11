import {
  appOrderInputSchema,
  customerSessionRequestSchema,
  memberInputSchema,
  orderIdParamSchema,
  selectPaymentInputSchema,
} from '@sds/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/service.ts';
import { ApiError } from '../errors.ts';
import { LiffUnavailableError } from '../line/liff-verify.ts';
import type { LineRuntime } from '../line/runtime.ts';
import { MAX_SLIP_BYTES, SLIP_CONTENT_TYPES } from '../slips/image.ts';
import { attachSlip } from '../slips/service.ts';
import type { SlipStore } from '../slips/store.ts';
import { parse } from '../validate.ts';
import {
  acknowledgePrivacy,
  checkoutInfo,
  claimPayment,
  getMember,
  getMyOrder,
  listMyOrders,
  myQr,
  openSession,
  placeOrder,
  saveMember,
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
 * - `POST /orders/:id/slip` takes the slip picture as the body and claims the payment with it.
 * - Answers are personal data (names, buildings) and money state: never cached.
 */
export async function registerCustomerAppRoutes(
  app: FastifyInstance,
  ctx: AuthContext,
  runtime: LineRuntime,
  slips: SlipStore,
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
  // `app.rateLimit` hooks run only the FIRST limiter of a request (they share one "ran" flag), so
  // a per-customer hook after `byAddress` would never count. `createRateLimit` has no such flag:
  // it only counts, and this hook answers the standard 429 itself.
  const byCustomer = (max: number) => {
    const limiter = app.createRateLimit({
      max,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.customer?.customerId ?? request.ip,
    });
    return async (request: FastifyRequest): Promise<void> => {
      const result = await limiter(request);
      if (!result.isAllowed && result.isExceeded) {
        throw new ApiError(429, 'RATE_LIMITED', 'Too many requests', { retryAfterMs: result.ttl });
      }
    };
  };
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

  app.get('/member', reads, async (request) => getMember(ctx, customerOf(request)));

  app.put('/member', writes, async (request) =>
    saveMember(ctx, customerOf(request), parse(memberInputSchema, request.body)),
  );

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

  // A slip is the picture itself as the request body (Content-Type image/jpeg, image/png or
  // image/webp). Only this scope reads those types, as raw bytes; the guard and the limits run in
  // `onRequest`, before a byte of the body is read. The bytes are checked again for their magic
  // numbers and the 5 MB cap in `attachSlip`. The room over the cap is only for that check's 413.
  await app.register(async (upload) => {
    for (const type of SLIP_CONTENT_TYPES) {
      upload.addContentTypeParser(
        type,
        { parseAs: 'buffer', bodyLimit: MAX_SLIP_BYTES + 1024 },
        (_request, body, done) => done(null, body),
      );
    }
    upload.post(
      '/orders/:id/slip',
      {
        bodyLimit: MAX_SLIP_BYTES + 1024,
        // The per-customer limit only: the guard rejects a bad token before any body is read, and
        // this one counts the customers that are signed in.
        onRequest: [guard, byCustomer(6)],
      },
      async (request) => {
        // Any other content type (JSON, text) arrives parsed, not as bytes: refused the same way.
        if (!Buffer.isBuffer(request.body)) {
          throw new ApiError(415, 'SLIP_TYPE_UNSUPPORTED', 'Send a JPEG, PNG or WebP picture');
        }
        return attachSlip(
          ctx,
          slips,
          customerOf(request).customerId,
          orderIdOf(request),
          request.body,
          meta(request),
        );
      },
    );
  });

  app.get('/orders/:id/qr', reads, async (request) =>
    myQr(ctx, customerOf(request).customerId, orderIdOf(request), meta(request)),
  );
}
