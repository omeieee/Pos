/**
 * Route guard (02 §7): checks the bearer session, then the role's permission from
 * `@sds/shared`, then step-up for the sensitive ones. Every route in /v1 except the sign-in
 * routes uses it. UIs only hide what is not allowed; this is what enforces it.
 *
 * Routes run it as an `onRequest` hook, so it decides before Fastify reads the body: a caller who
 * is not signed in costs no JSON parsing and cannot tell a bad body from a missing session.
 */
import { hasPermission, type Permission, requiresStepUp } from '@sds/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, stepUpRequired, unauthenticated } from '../errors.ts';
import {
  type AuthContext,
  authenticateSession,
  hasFreshStepUp,
  type Principal,
} from './service.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the guard on every authenticated route. */
    auth: Principal | null;
  }
}

export type Guard = (request: FastifyRequest) => Promise<void>;
export type GuardFactory = (permission?: Permission) => Guard;

/** Marks the functions `guard()` makes, so the route inventory can tell a guard from any hook. */
const GUARDED = Symbol.for('sds.guarded');

function markGuard(fn: Guard): Guard {
  return Object.assign(fn, { [GUARDED]: true });
}

type RouteHooks = {
  onRequest?: unknown;
  preHandler?: unknown;
  handler?: unknown;
  wsHandler?: unknown;
  websocket?: boolean | undefined;
};

/**
 * True when the route runs a `guard()` in its own `onRequest` hooks. A guard in `preHandler`
 * does not count: by then Fastify has already parsed the body of someone who is not signed in.
 */
export function isGuarded(route: RouteHooks): boolean {
  return [route.onRequest]
    .flat(2)
    .some(
      (hook) =>
        typeof hook === 'function' &&
        (hook as unknown as Record<symbol, unknown>)[GUARDED] === true,
    );
}

/**
 * Marks a hook that verifies a signed URL (an HMAC over what the URL names plus an expiry). It is
 * for the few routes an `<img>` or a download link must reach: the browser cannot send an
 * Authorization header there, so the signature in the query string is the only authentication.
 */
const SIGNED_URL = Symbol.for('sds.signed-url');

export function markSignedUrlCheck(fn: Guard): Guard {
  return Object.assign(fn, { [SIGNED_URL]: true });
}

/** True when the route runs a signed-URL verifier in its own `onRequest` hooks. */
export function hasSignedUrlCheck(route: RouteHooks): boolean {
  return [route.onRequest]
    .flat(2)
    .some(
      (hook) =>
        typeof hook === 'function' &&
        (hook as unknown as Record<symbol, unknown>)[SIGNED_URL] === true,
    );
}

/**
 * Marks a hook that decides, from what the URL names, whether a public media route may answer at
 * all (`GET /v1/menu/items/:id/photo`). It is the fourth exception: the picture of a menu item is
 * shown in an `<img>` (no Authorization header) on the public LINE menu, and it is not signed, so
 * the check has to be strict about WHAT it serves: nothing but the photo of an item that is on the
 * menu. A request it cannot match must get the same answer as any other, so it reveals nothing.
 */
const PUBLIC_MEDIA = Symbol.for('sds.public-media');

export type PublicMediaCheck = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function markPublicMediaCheck(fn: PublicMediaCheck): PublicMediaCheck {
  return Object.assign(fn, { [PUBLIC_MEDIA]: true });
}

/** True when the route runs a public-media check in its own `onRequest` hooks. */
export function hasPublicMediaCheck(route: RouteHooks): boolean {
  return [route.onRequest]
    .flat(2)
    .some(
      (hook) =>
        typeof hook === 'function' &&
        (hook as unknown as Record<symbol, unknown>)[PUBLIC_MEDIA] === true,
    );
}

/**
 * Marks a hook that verifies a LINE webhook signature (`X-Line-Signature`, an HMAC over the raw
 * body). The fifth exception: LINE's servers send no bearer token, so the signature is the only
 * authentication. The check needs the raw body, so it runs in `preHandler` (after the body was
 * read, before any handler code); a route may not be listed without it.
 */
const LINE_SIGNATURE = Symbol.for('sds.line-signature');

export function markLineSignatureCheck<T extends (...args: never[]) => unknown>(fn: T): T {
  return Object.assign(fn, { [LINE_SIGNATURE]: true });
}

/** True when the route runs a LINE signature check in its own `preHandler` hooks. */
export function hasLineSignatureCheck(route: RouteHooks): boolean {
  return [route.preHandler]
    .flat(2)
    .some(
      (hook) =>
        typeof hook === 'function' &&
        (hook as unknown as Record<symbol, unknown>)[LINE_SIGNATURE] === true,
    );
}

/**
 * Marks the handler of a WebSocket route that authenticates its sockets itself: a browser
 * WebSocket cannot send an Authorization header, so the socket proves who it is with its first
 * message. The marked handler is what enforces that (`realtime/hub.ts`).
 */
const FIRST_MESSAGE_AUTH = Symbol.for('sds.first-message-auth');

export function markFirstMessageAuth<T extends (...args: never[]) => unknown>(fn: T): T {
  return Object.assign(fn, { [FIRST_MESSAGE_AUTH]: true });
}

const isMarked = (h: unknown): boolean =>
  typeof h === 'function' && (h as unknown as Record<symbol, unknown>)[FIRST_MESSAGE_AUTH] === true;

/**
 * True when the route upgrades to a WebSocket through a marked handler: `wsHandler` (what
 * @fastify/websocket calls with the socket), or the handler of a `websocket: true` route.
 */
export function hasFirstMessageAuth(route: RouteHooks): boolean {
  return isMarked(route.wsHandler) || (route.websocket === true && isMarked(route.handler));
}

/**
 * Makes "forgot the guard" a start-up failure (QA): every route declared under this scope whose
 * path starts with /v1 must be guarded, unless it is in `open` as "METHOD /path" (HEAD counts as
 * GET). A route in `signedUrl` is the other exception: it needs no session, but it must run a
 * signed-URL verifier (`markSignedUrlCheck`) in `onRequest`; listing it without the verifier
 * fails the start too, so an exception cannot be public by accident. The third exception is a
 * WebSocket route in `firstMessageAuth`: it must be a `websocket` route with a handler marked
 * `markFirstMessageAuth`. The fourth is a route in `publicMedia`: it needs no session but must run
 * a check marked `markPublicMediaCheck` that limits what it serves. Add the hook before declaring
 * any route.
 */
export function enforceGuardedRoutes(
  scope: FastifyInstance,
  open: ReadonlySet<string>,
  signedUrl: ReadonlySet<string> = new Set(),
  firstMessageAuth: ReadonlySet<string> = new Set(),
  publicMedia: ReadonlySet<string> = new Set(),
  lineSignature: ReadonlySet<string> = new Set(),
): void {
  scope.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/v1')) return;
    if (isGuarded(route)) return;
    for (const method of [route.method].flat()) {
      const key = `${method === 'HEAD' ? 'GET' : method} ${route.url}`;
      if (open.has(key)) continue;
      if (firstMessageAuth.has(key)) {
        if (hasFirstMessageAuth(route)) continue;
        throw new Error(
          `${key} is listed as a first-message-auth route but is not a WebSocket route with a handler that authenticates: use markFirstMessageAuth()`,
        );
      }
      if (lineSignature.has(key)) {
        if (hasLineSignatureCheck(route)) continue;
        throw new Error(
          `${key} is listed as a LINE webhook route but does not verify the signature: add markLineSignatureCheck() to its preHandler hooks`,
        );
      }
      if (publicMedia.has(key)) {
        if (hasPublicMediaCheck(route)) continue;
        throw new Error(
          `${key} is listed as a public media route but does not limit what it serves: add markPublicMediaCheck() to its onRequest hooks`,
        );
      }
      if (signedUrl.has(key)) {
        if (hasSignedUrlCheck(route)) continue;
        throw new Error(
          `${key} is listed as a signed-URL route but does not verify the signature: add markSignedUrlCheck() to its onRequest hooks`,
        );
      }
      throw new Error(
        `${key} has no auth guard: add guard() to the route, or list it as an open or signed-URL route in v1.ts`,
      );
    }
  });
}

const BEARER = /^Bearer ([A-Za-z0-9_-]{20,200})$/i;

/**
 * `guard()` needs any valid session; `guard('x.y')` also needs the permission, and a fresh
 * step-up when the permission is a sensitive one.
 */
export function createGuard(ctx: AuthContext): GuardFactory {
  return function guard(permission) {
    return markGuard(async (request) => {
      const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
      if (!token) throw unauthenticated();
      const deviceToken = request.headers['x-device-token'];
      const principal = await authenticateSession(
        ctx,
        token,
        typeof deviceToken === 'string' ? deviceToken : undefined,
      );
      if (!principal) throw unauthenticated();
      request.auth = principal;

      if (permission === undefined) return;
      if (!hasPermission(principal.role, permission)) throw forbidden();
      if (requiresStepUp(permission) && !hasFreshStepUp(principal, ctx.now())) {
        throw stepUpRequired();
      }
    });
  };
}

/** The principal the guard set. A route without a guard has none, which is a bug: fail closed. */
export function principalOf(request: FastifyRequest): Principal {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}
