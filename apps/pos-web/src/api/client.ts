/**
 * Typed client for the /v1 API. The one place that talks HTTP to it.
 *
 * - Every success response is parsed with the shared Zod schema; a body that does not match is a
 *   RESPONSE_INVALID error, never silently used. Every request body is parsed with the shared
 *   input schema first, so an invalid call fails before it reaches the network.
 * - Tokens go in headers only: `Authorization: Bearer <session>` and `X-Device-Token`. They are
 *   never put in a URL, a log line or an error. The client reads them through getters so it
 *   holds no copy.
 * - `POST /v1/orders` carries `clientRequestId` (the idempotency key) in the body and the same
 *   value in `Idempotency-Key`. The id belongs to the logical order, not to one HTTP attempt: a
 *   caller that may retry (the offline outbox) creates it once with `newClientRequestId()` and
 *   passes it on every attempt.
 * - Only requests with a body send `Content-Type: application/json`; Fastify answers 400 to an
 *   empty JSON body (for example on POST /v1/auth/logout).
 */
import { type ApiClientOptions, createTransport } from './http.ts';
import { makeAdmin } from './resources/admin.ts';
import { makeAuth } from './resources/auth.ts';
import { makeDevices } from './resources/devices.ts';
import { makeMenu } from './resources/menu.ts';
import { makeOrders } from './resources/orders.ts';
import { makePayments } from './resources/payments.ts';
import { makeRecipients } from './resources/recipients.ts';
import { makeSettings } from './resources/settings.ts';
import { makeSync } from './resources/sync.ts';

export type { ApiClientOptions, Schema } from './http.ts';
export { newClientRequestId } from './http.ts';
export type { OwnerLoginRequest, OwnerStepUpRequest } from './resources/auth.ts';
export type {
  NewCategoryInput,
  NewGroupInput,
  NewItemInput,
  NewOptionInput,
} from './resources/menu.ts';
export type { NewOrderInput } from './resources/orders.ts';
export type { ChangePaymentInput, NewPaymentInput } from './resources/payments.ts';

export function createApiClient(options: ApiClientOptions) {
  const transport = createTransport(options);
  return {
    auth: makeAuth(transport),
    orders: makeOrders(transport),
    menu: makeMenu(transport),
    sync: makeSync(transport),
    payments: makePayments(transport),
    recipients: makeRecipients(transport),
    settings: makeSettings(transport),
    admin: makeAdmin(transport),
    devices: makeDevices(transport),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
