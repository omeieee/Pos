/**
 * The phone-alert routes of the dev shop (`VITE_MOCK_API=1`) and of tests, answering the way
 * apps/api/src/push/routes.ts does: `GET /v1/push/config` (200 even when not set up),
 * `GET|PUT|DELETE /v1/push/subscription` (503 PUSH_NOT_CONFIGURED while not set up, 403
 * DEVICE_REQUIRED for a session with no registered device, 400 for a subscription the shared
 * schema refuses). The subscription is remembered per device in memory only. The public key is a
 * made-up P-256 point shape, not a real VAPID key. Nothing here ever sends a push.
 */
import { pushSubscriptionInputSchema } from '@sds/shared';
import type { MockAnswer } from './mock-payments.ts';

/** 65 bytes, starts with 0x04 (`B` in base64url): the right shape for `applicationServerKey`, not a real key. */
export const MOCK_VAPID_PUBLIC_KEY = `B${'A'.repeat(86)}`;

const error = (status: number, code: string): MockAnswer => ({
  status,
  body: { code, message: 'mock server error', details: {} },
});

export function createMockPush(options: { configured?: boolean } = {}) {
  let configured = options.configured ?? true;
  const subscribed = new Set<string>();

  return {
    /** Dev and tests: the server has (or has not) got its VAPID keys. */
    setConfigured(on: boolean) {
      configured = on;
    },
    /** Dev and tests: does the server hold a subscription for this device? */
    isSubscribed: (deviceId: string) => subscribed.has(deviceId),
    /** `deviceId` is the session's registered device, or null for a session opened without one. */
    handle(
      method: string,
      path: string,
      body: unknown,
      deviceId: string | null,
    ): MockAnswer | null {
      if (method === 'GET' && path === '/v1/push/config') {
        return {
          status: 200,
          body: { enabled: configured, publicKey: configured ? MOCK_VAPID_PUBLIC_KEY : null },
        };
      }
      if (path !== '/v1/push/subscription') return null;
      if (method !== 'GET' && method !== 'PUT' && method !== 'DELETE') return null;
      if (!configured) return error(503, 'PUSH_NOT_CONFIGURED');
      if (deviceId === null) return error(403, 'DEVICE_REQUIRED');
      if (method === 'PUT') {
        if (!pushSubscriptionInputSchema.safeParse(body).success) {
          return error(400, 'VALIDATION_ERROR');
        }
        subscribed.add(deviceId);
      } else if (method === 'DELETE') {
        subscribed.delete(deviceId);
      }
      return { status: 200, body: { subscribed: subscribed.has(deviceId) } };
    },
  };
}
