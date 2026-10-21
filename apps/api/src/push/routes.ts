import { pushRepo } from '@sds/db';
import {
  type PushConfigResponse,
  type PushSubscribedResponse,
  pushSubscriptionInputSchema,
} from '@sds/shared';
import type { FastifyInstance } from 'fastify';
import { type GuardFactory, principalOf } from '../auth/guards.ts';
import type { AuthContext } from '../auth/service.ts';
import { ApiError } from '../errors.ts';
import { withTransaction } from '../tx.ts';
import { parse } from '../validate.ts';
import type { PushRuntime } from './notifier.ts';
import { isValidSubscriberKey } from './webpush.ts';

/**
 * Mounted at /v1/push. Phone alerts are opt-in per device: a device subscribes and unsubscribes
 * itself, whoever is signed in on it (any role). The device comes from the device token behind the
 * session, never from the body.
 *
 * - `GET /config`: `{enabled, publicKey}`; 200 even when VAPID is not set up (`enabled: false`).
 * - `GET|PUT|DELETE /subscription`: 503 `PUSH_NOT_CONFIGURED` when VAPID is not set up.
 * No answer ever contains the endpoint or the keys.
 */
export async function registerPushRoutes(
  app: FastifyInstance,
  ctx: AuthContext,
  guard: GuardFactory,
  push: PushRuntime | null,
): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  const configured = (): PushRuntime => {
    if (!push) throw new ApiError(503, 'PUSH_NOT_CONFIGURED', 'Phone alerts are not set up');
    return push;
  };
  /** A session opened without a registered device (an owner signed in on a browser) has nothing to subscribe. */
  const deviceOf = (request: Parameters<typeof principalOf>[0]) => {
    const principal = principalOf(request);
    if (!principal.deviceId) {
      throw new ApiError(403, 'DEVICE_REQUIRED', 'Register this device to get phone alerts');
    }
    return { deviceId: principal.deviceId, staffId: principal.staffId };
  };

  app.get(
    '/config',
    { onRequest: guard() },
    async (): Promise<PushConfigResponse> => ({
      enabled: push !== null,
      publicKey: push?.vapid.publicKey ?? null,
    }),
  );

  app.get(
    '/subscription',
    { onRequest: guard() },
    async (request): Promise<PushSubscribedResponse> => {
      configured();
      return { subscribed: await pushRepo.existsForDevice(ctx.db, deviceOf(request).deviceId) };
    },
  );

  app.put(
    '/subscription',
    { onRequest: guard() },
    async (request): Promise<PushSubscribedResponse> => {
      configured();
      const { deviceId, staffId } = deviceOf(request);
      const input = parse(pushSubscriptionInputSchema, request.body);
      // A point that is not on the curve would only fail when the first alert is sent.
      if (!isValidSubscriberKey(input.keys.p256dh)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'The subscription key is not valid');
      }
      // Moving an endpoint off another device and saving it are one write.
      await withTransaction(ctx, (tx) =>
        pushRepo.upsertForDevice(tx, {
          deviceId,
          staffId,
          endpoint: input.endpoint,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          now: ctx.now(),
        }),
      );
      return { subscribed: true };
    },
  );

  app.delete(
    '/subscription',
    { onRequest: guard() },
    async (request): Promise<PushSubscribedResponse> => {
      configured();
      await pushRepo.deleteForDevice(ctx.db, deviceOf(request).deviceId);
      return { subscribed: false };
    },
  );
}
