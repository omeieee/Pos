import {
  changePaymentMethodInputSchema,
  claimPaymentInputSchema,
  confirmPaymentInputSchema,
  createPaymentInputSchema,
  orderIdParamSchema,
  paymentIdParamSchema,
  paymentReasonInputSchema,
} from '@sds/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type GuardFactory, markSignedUrlCheck, principalOf } from '../auth/guards.ts';
import type { AuthContext } from '../auth/service.ts';
import { ApiError } from '../errors.ts';
import { readSlip } from '../slips/service.ts';
import type { SlipStore } from '../slips/store.ts';
import { parse } from '../validate.ts';
import { checkQrLink } from './qr.ts';
import {
  changePaymentMethod,
  createPayment,
  listOrderPayments,
  movePayment,
  paymentQrUrl,
  renderPaymentQr,
} from './service.ts';

const meta = (request: FastifyRequest) => ({ ip: request.ip ?? null });
const orderIdOf = (request: FastifyRequest) => parse(orderIdParamSchema, request.params).id;
const paymentIdOf = (request: FastifyRequest) => parse(paymentIdParamSchema, request.params).id;
/** A move with no data may be sent with no body at all. */
const bodyOf = (request: FastifyRequest) => request.body ?? {};

const qrQuerySchema = z.object({
  exp: z.string().regex(/^\d{1,12}$/),
  sig: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

const invalidLink = () => new ApiError(403, 'QR_LINK_INVALID', 'This QR link is not valid');

/**
 * The idempotency key is the request id in the body. A header, if sent, must say the same
 * (same rule as POST /v1/orders).
 */
function checkIdempotencyHeader(request: FastifyRequest, clientRequestId: string) {
  const header = request.headers['idempotency-key'];
  if (header !== undefined && String(header).toLowerCase() !== clientRequestId.toLowerCase()) {
    throw new ApiError(
      400,
      'IDEMPOTENCY_KEY_MISMATCH',
      'Idempotency-Key must equal clientRequestId',
    );
  }
}

/**
 * Mounted under /v1 with full paths: `/orders/:id/payments` and `/payments/:id/...`. Who may do
 * what (the permission matrix lives in `@sds/shared`; the state machine decides per move):
 * - start a payment, claim, change method, see the QR link, list: `payment.record`
 *   (cash is recorded as confirmed in the same step, so the service also needs `payment.confirm`);
 * - confirm: `payment.confirm`; cancel a claim: `payment.cancel_claimed`;
 * - void and refund: `payment.void_refund` (managers, owner), which the guard pairs with a fresh
 *   step-up.
 * The slip picture (`GET /payments/:id/slip`) needs `payment.record` like the list.
 * The QR picture is the one route without a session: see `qr.png` below.
 */
export async function registerPaymentRoutes(
  app: FastifyInstance,
  ctx: AuthContext,
  guard: GuardFactory,
  slips: SlipStore,
): Promise<void> {
  // Payment answers are live money state: never cached by a browser or a proxy.
  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  app.post(
    '/orders/:id/payments',
    { onRequest: guard('payment.record') },
    async (request, reply) => {
      const input = parse(createPaymentInputSchema, request.body);
      checkIdempotencyHeader(request, input.clientRequestId);
      const { result, replay } = await createPayment(
        ctx,
        principalOf(request),
        orderIdOf(request),
        input,
        meta(request),
      );
      return reply.status(replay ? 200 : 201).send(result);
    },
  );

  app.get('/orders/:id/payments', { onRequest: guard('payment.record') }, async (request) =>
    listOrderPayments(ctx, orderIdOf(request)),
  );

  app.post('/payments/:id/claim', { onRequest: guard('payment.record') }, async (request) =>
    movePayment(
      ctx,
      principalOf(request),
      paymentIdOf(request),
      'claim',
      parse(claimPaymentInputSchema, bodyOf(request)),
      meta(request),
    ),
  );

  app.post('/payments/:id/confirm', { onRequest: guard('payment.confirm') }, async (request) =>
    movePayment(
      ctx,
      principalOf(request),
      paymentIdOf(request),
      'confirm',
      parse(confirmPaymentInputSchema, bodyOf(request)),
      meta(request),
    ),
  );

  app.post(
    '/payments/:id/cancel-claimed',
    { onRequest: guard('payment.cancel_claimed') },
    async (request) =>
      movePayment(
        ctx,
        principalOf(request),
        paymentIdOf(request),
        'cancel-claimed',
        parse(paymentReasonInputSchema, bodyOf(request)),
        meta(request),
      ),
  );

  app.post(
    '/payments/:id/change-method',
    { onRequest: guard('payment.record') },
    async (request, reply) => {
      const input = parse(changePaymentMethodInputSchema, request.body);
      checkIdempotencyHeader(request, input.clientRequestId);
      const { result, replay } = await changePaymentMethod(
        ctx,
        principalOf(request),
        paymentIdOf(request),
        input,
        meta(request),
      );
      return reply.status(replay ? 200 : 201).send(result);
    },
  );

  for (const action of ['void', 'refund'] as const) {
    app.post(
      `/payments/:id/${action}`,
      { onRequest: guard('payment.void_refund') },
      async (request) =>
        movePayment(
          ctx,
          principalOf(request),
          paymentIdOf(request),
          action,
          parse(paymentReasonInputSchema, bodyOf(request)),
          meta(request),
        ),
    );
  }

  /**
   * The customer's slip picture, for staff who can record payments. It holds a bank app screen
   * (account names, numbers): never cached, never sniffed, and every look is an audit row.
   */
  // Per staff member, after the guard: one signed-in account cannot page through every slip.
  const slipLimiter = app.createRateLimit({
    max: 30,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.auth?.staffId ?? request.ip,
  });
  const slipViewLimit = async (request: FastifyRequest): Promise<void> => {
    const result = await slipLimiter(request);
    if (!result.isAllowed && result.isExceeded) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests', { retryAfterMs: result.ttl });
    }
  };
  app.get(
    '/payments/:id/slip',
    { onRequest: [guard('payment.record'), slipViewLimit] },
    async (request, reply) => {
      const { bytes, contentType } = await readSlip(
        ctx,
        slips,
        principalOf(request),
        paymentIdOf(request),
        meta(request),
      );
      return reply
        .header('content-type', contentType)
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('referrer-policy', 'no-referrer')
        .send(bytes);
    },
  );

  app.get('/payments/:id/qr-url', { onRequest: guard('payment.record') }, async (request) =>
    paymentQrUrl(ctx, paymentIdOf(request)),
  );

  /**
   * The PromptPay QR picture. An `<img>` cannot send an Authorization header, so this route has
   * NO session: the signed link from `qr-url` (an HMAC over the payment id and an expiry) is the
   * only authentication, checked in `onRequest` before anything else runs. v1.ts lists it as a
   * signed-URL route, and the start-up check refuses it if this verifier is ever removed.
   */
  // The limiter runs BEFORE the signature check, so a flood of bad links is throttled too. It is a
  // decorator of @fastify/rate-limit (buildApp registers it); never run without it.
  if (typeof app.rateLimit !== 'function') {
    throw new Error('the payment routes need @fastify/rate-limit to be registered first');
  }
  const qrLimit = app.rateLimit({ max: 60, timeWindow: '1 minute' });

  app.get(
    '/payments/:id/qr.png',
    {
      // The query string holds the signature, a working credential for five minutes, and Fastify's
      // access log line prints the whole URL. Only warnings and errors are logged for this route.
      logLevel: 'warn',
      onRequest: [
        qrLimit,
        markSignedUrlCheck(async (request) => {
          const params = paymentIdParamSchema.safeParse(request.params);
          const query = qrQuerySchema.safeParse(request.query);
          if (!params.success || !query.success) throw invalidLink();
          const verdict = checkQrLink(
            ctx.keys.qrUrlKey,
            params.data.id,
            Number(query.data.exp),
            query.data.sig,
            Math.floor(ctx.now().getTime() / 1000),
          );
          if (verdict === 'invalid') throw invalidLink();
          if (verdict === 'expired') {
            throw new ApiError(
              410,
              'QR_LINK_EXPIRED',
              'This QR link has expired. Ask for a new one',
            );
          }
        }),
      ],
    },
    async (request, reply) => {
      const png = await renderPaymentQr(ctx, paymentIdOf(request));
      return reply
        .header('content-type', 'image/png')
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .send(png);
    },
  );
}
