/** Typed API client: phone alerts (P8, Web Push): the server's key and this device's subscription. */
import {
  type PushSubscriptionInput,
  pushConfigResponseSchema,
  pushSubscribedResponseSchema,
  pushSubscriptionInputSchema,
} from '@sds/shared';
import { checked, type Transport } from '../http.ts';

export function makePush({ get, put, del }: Transport) {
  const read = { session: true, device: 'optional', schema: pushSubscribedResponseSchema } as const;
  return {
    /** `{enabled, publicKey}`: 200 even when the server has no VAPID keys (`enabled: false`). Any signed-in staff. */
    config: async () =>
      (
        await get({
          path: '/v1/push/config',
          schema: pushConfigResponseSchema,
          session: true,
          device: 'optional',
        })
      ).data,

    /** Does the server hold a subscription for this device? 503 PUSH_NOT_CONFIGURED, 403 DEVICE_REQUIRED. */
    subscribed: async () => (await get({ path: '/v1/push/subscription', ...read })).data,

    /** Saves this device's subscription (the same device overwrites its row). Never logged or echoed back. */
    subscribe: async (input: PushSubscriptionInput) =>
      (
        await put({
          path: '/v1/push/subscription',
          body: checked(pushSubscriptionInputSchema, input),
          ...read,
        })
      ).data,

    /** Removes this device's subscription. */
    unsubscribe: async () => (await del({ path: '/v1/push/subscription', ...read })).data,
  };
}
