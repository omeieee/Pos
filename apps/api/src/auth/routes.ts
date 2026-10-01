import { ownerLoginInputSchema, pinLoginInputSchema, registerDeviceInputSchema } from '@sds/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createGlobalLimiter, globalRateLimitHook } from '../rate-limit.ts';
import { parse } from '../validate.ts';
import { type GuardFactory, principalOf } from './guards.ts';
import {
  type AuthContext,
  authenticateDevice,
  describeSession,
  listLoginStaff,
  logout,
  ownerLogin,
  pinLogin,
  registerDevice,
  requireStaffDevice,
  stepUp,
} from './service.ts';

const meta = (request: FastifyRequest) => ({ ip: request.ip ?? null });

/** Registered-device token, sent in the `X-Device-Token` header. */
const deviceToken = (request: FastifyRequest) => {
  const value = request.headers['x-device-token'];
  return typeof value === 'string' ? value : undefined;
};

/** Per-IP limits (the shop shares one IP, so these are generous for PINs and tight for the owner). */
const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

/** Mounted at /v1/auth. */
export async function registerAuthRoutes(
  app: FastifyInstance,
  ctx: AuthContext,
  guard: GuardFactory,
): Promise<void> {
  const ownerBucket = globalRateLimitHook(
    createGlobalLimiter({
      max: ctx.policy.ownerGlobalRatePerMinute,
      windowMs: 60_000,
      now: ctx.now,
    }),
  );
  const stepUpBucket = globalRateLimitHook(
    createGlobalLimiter({
      max: ctx.policy.stepUpGlobalRatePerMinute,
      windowMs: 60_000,
      now: ctx.now,
    }),
  );

  // Tokens and session data must never be cached by a browser or proxy.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  // The owner registers a device: step-up + audit + owner alert (rule 9).
  app.post(
    '/device',
    { preHandler: guard('device.manage'), ...limit(10) },
    async (request, reply) => {
      const input = parse(registerDeviceInputSchema, request.body);
      const result = await registerDevice(ctx, principalOf(request), input, meta(request));
      return reply.status(201).send(result);
    },
  );

  // The PIN screen's tiles. Needs a registered device, so strangers learn no names.
  app.get('/staff', limit(60), async (request) => {
    requireStaffDevice(await authenticateDevice(ctx, deviceToken(request)));
    return listLoginStaff(ctx);
  });

  app.post('/pin', limit(30), async (request) => {
    // The device is checked before any staff counter is touched, so only registered
    // devices can lock someone out.
    const device = await authenticateDevice(ctx, deviceToken(request));
    requireStaffDevice(device);
    const input = parse(pinLoginInputSchema, request.body);
    return pinLogin(ctx, device, input, meta(request));
  });

  app.post('/owner', { onRequest: ownerBucket, ...limit(10) }, async (request) => {
    const token = deviceToken(request);
    const device = token === undefined ? null : await authenticateDevice(ctx, token);
    const input = parse(ownerLoginInputSchema, request.body);
    return ownerLogin(ctx, device, input, meta(request));
  });

  app.post(
    '/step-up',
    { onRequest: stepUpBucket, preHandler: guard(), ...limit(10) },
    async (request) => stepUp(ctx, principalOf(request), request.body, meta(request)),
  );

  app.get('/me', { preHandler: guard() }, async (request) => describeSession(principalOf(request)));

  app.post('/logout', { preHandler: guard() }, async (request, reply) => {
    await logout(ctx, principalOf(request));
    return reply.status(204).send();
  });
}
