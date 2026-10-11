import type { Db } from '@sds/db';
import type { FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './admin/routes.ts';
import { deriveAuthKeys } from './auth/crypto.ts';
import { createGuard, enforceGuardedRoutes, type GuardFactory } from './auth/guards.ts';
import { type AuthPolicy, DEFAULT_AUTH_POLICY } from './auth/policy.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import type { AuthContext } from './auth/service.ts';
import { registerCustomerAppRoutes } from './customer-app/routes.ts';
import { registerCustomerRoutes } from './customers/routes.ts';
import type { EventBus } from './events.ts';
import { registerCompletionPush } from './line/completion-push.ts';
import { notifyOrderChange } from './line/order-change-push.ts';
import { notifyPaymentRejected } from './line/payment-rejected-push.ts';
import { registerLineRoutes } from './line/routes.ts';
import { createLineRuntime, type LineRuntime } from './line/runtime.ts';
import { registerMenuRoutes } from './menu/routes.ts';
import { registerRecipientRoutes } from './orders/recipients.ts';
import { registerOrderRoutes } from './orders/routes.ts';
import { registerPaymentRoutes } from './payments/routes.ts';
import { type RealtimeOptions, registerRealtimeRoutes, setupRealtime } from './realtime/routes.ts';
import { registerSettingsRoutes } from './settings/routes.ts';
import { createMemorySlipStore, type SlipStore } from './slips/store.ts';

export interface V1Deps {
  db: Db;
  /** AUTH_SECRET_KEY, 32 bytes. */
  authSecretKey: Buffer;
  events: EventBus;
  /** Tests inject a clock and shorter limits. */
  now?: () => Date;
  policy?: AuthPolicy;
  /** Tests shorten the socket deadlines and lower the limits. */
  realtime?: RealtimeOptions;
  /** LINE secrets and client. Omitted: the webhook answers 503 and nothing is sent. */
  line?: LineRuntime;
  /** Where slip images live (D-24). Omitted: in memory, which only tests want. */
  slips?: SlipStore;
}

/**
 * The only /v1 routes that may run without `guard()`: the sign-ins (/auth/staff and /auth/pin
 * authenticate with the registered device's token; /auth/owner is the password + TOTP login; the
 * two /auth/invite routes take an invite token), the
 * customer app's token exchange, and the public menu. The other `/v1/app` routes are not here:
 * they run the customer guard (`markCustomerGuard`), which the start-up check accepts as its own
 * kind of guard.
 */
export const OPEN_ROUTES: ReadonlySet<string> = new Set([
  'GET /v1/auth/staff',
  'POST /v1/auth/pin',
  'POST /v1/auth/owner',
  // An invitee opens the owner's link before they have an account (D-23): the token is the credential.
  'POST /v1/auth/invite/preview',
  'POST /v1/auth/invite/accept',
  // The customer app trades a LIFF token that LINE confirms for a customer session. Rate limited.
  'POST /v1/app/session',
  // The menu a customer or a till reads before signing in: prices of what is on sale, no costs.
  'GET /v1/menu',
]);

/**
 * The one other exception: routes reached from an `<img>`, which cannot send an Authorization
 * header. Each must verify an HMAC signature in `onRequest` (`markSignedUrlCheck`); the start-up
 * check refuses one that does not. Today that is only the PromptPay QR picture.
 */
export const SIGNED_URL_ROUTES: ReadonlySet<string> = new Set(['GET /v1/payments/:id/qr.png']);

/**
 * The third exception: a browser WebSocket cannot send headers, so `WS /v1/ws` authenticates its
 * first message instead of a request header. The start-up check lets it through only as a
 * WebSocket route whose handler is marked `markFirstMessageAuth`.
 */
export const FIRST_MESSAGE_AUTH_ROUTES: ReadonlySet<string> = new Set(['GET /v1/ws']);

/**
 * The fourth exception: the photo of a menu item, shown in an `<img>` on the staff till and the
 * public LINE menu (no Authorization header, no signature). It must run a `markPublicMediaCheck`
 * hook, which serves only a photo of an item that is on the menu at the version in the URL.
 */
export const PUBLIC_MEDIA_ROUTES: ReadonlySet<string> = new Set(['GET /v1/menu/items/:id/photo']);

/**
 * The fifth exception: LINE's servers call the webhook with no session. It must run a
 * `markLineSignatureCheck` hook in `preHandler`, which verifies `X-Line-Signature` over the raw body.
 */
export const LINE_SIGNATURE_ROUTES: ReadonlySet<string> = new Set(['POST /v1/line/webhook']);

/** What every /v1 module receives: the database, the clock, the event bus and the guard. */
export interface ModuleContext {
  auth: AuthContext;
  guard: GuardFactory;
}

/** Mounts the REST API under /v1. Call it once, after `buildApp`. */
export async function registerV1(app: FastifyInstance, deps: V1Deps): Promise<void> {
  const auth: AuthContext = {
    db: deps.db,
    keys: deriveAuthKeys(deps.authSecretKey),
    policy: deps.policy ?? DEFAULT_AUTH_POLICY,
    now: deps.now ?? (() => new Date()),
    events: deps.events,
  };
  const context: ModuleContext = { auth, guard: createGuard(auth) };
  const lineRuntime =
    deps.line ?? createLineRuntime({ channelSecret: undefined, channelAccessToken: undefined });
  const slips = deps.slips ?? createMemorySlipStore();
  // One push per LINE order when staff complete it, through the quota-aware sender.
  registerCompletionPush({ db: deps.db, runtime: lineRuntime, events: deps.events, now: auth.now });
  // The WebSocket plugin lives on the root instance, ahead of the /v1 scope that declares /v1/ws.
  const realtime = await setupRealtime(app, auth, deps.realtime);

  await app.register(
    async (v1) => {
      enforceGuardedRoutes(
        v1,
        OPEN_ROUTES,
        SIGNED_URL_ROUTES,
        FIRST_MESSAGE_AUTH_ROUTES,
        PUBLIC_MEDIA_ROUTES,
        LINE_SIGNATURE_ROUTES,
      );
      v1.decorateRequest('auth', null);
      await v1.register((scope) => registerAuthRoutes(scope, context.auth, context.guard), {
        prefix: '/auth',
      });
      await v1.register(
        (scope) =>
          registerOrderRoutes(scope, context.auth, context.guard, (notice) =>
            notifyOrderChange(
              { db: deps.db, runtime: lineRuntime, events: deps.events, now: auth.now },
              notice,
            ),
          ),
        { prefix: '/orders' },
      );
      await v1.register((scope) => registerRecipientRoutes(scope, context.auth, context.guard), {
        prefix: '/recipients',
      });
      await v1.register(
        (scope) => registerCustomerRoutes(scope, context.auth, context.guard, slips),
        {
          prefix: '/customers',
        },
      );
      await v1.register((scope) => registerMenuRoutes(scope, context.auth, context.guard), {
        prefix: '/menu',
      });
      await v1.register((scope) => registerSettingsRoutes(scope, context.auth, context.guard), {
        prefix: '/settings',
      });
      await v1.register(
        (scope) => registerLineRoutes(scope, context.auth, context.guard, lineRuntime, slips),
        { prefix: '/line' },
      );
      // The customer app (LIFF): its own session and guard, never the staff ones.
      await v1.register(
        (scope) => registerCustomerAppRoutes(scope, context.auth, lineRuntime, slips),
        {
          prefix: '/app',
        },
      );
      // Payments: /v1/orders/:id/payments and /v1/payments/... (no prefix of its own).
      await v1.register((scope) =>
        registerPaymentRoutes(scope, context.auth, context.guard, slips, (paymentId) =>
          notifyPaymentRejected(
            { db: deps.db, runtime: lineRuntime, events: deps.events, now: auth.now },
            paymentId,
          ),
        ),
      );
      // Device and staff management: /v1/devices and /v1/staff (no prefix of its own).
      await v1.register((scope) => registerAdminRoutes(scope, context.auth, context.guard));
      // Catch-up sync and the WebSocket: /v1/sync and /v1/ws (no prefix of its own).
      await v1.register((scope) =>
        registerRealtimeRoutes(scope, context.auth, context.guard, realtime),
      );
    },
    { prefix: '/v1' },
  );
}
