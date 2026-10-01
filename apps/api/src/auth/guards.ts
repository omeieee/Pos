/**
 * Route guard (02 §7): checks the bearer session, then the role's permission from
 * `@sds/shared`, then step-up for the sensitive ones. Every route in /v1 except the sign-in
 * routes uses it. UIs only hide what is not allowed; this is what enforces it.
 *
 * Routes run it as an `onRequest` hook, so it decides before Fastify reads the body: a caller who
 * is not signed in costs no JSON parsing and cannot tell a bad body from a missing session.
 */
import { hasPermission, type Permission, requiresStepUp } from '@sds/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
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

type RouteHooks = { onRequest?: unknown; preHandler?: unknown };

/** True when the route runs a `guard()` in its own `onRequest` or `preHandler` hooks. */
export function isGuarded(route: RouteHooks): boolean {
  return [route.onRequest, route.preHandler]
    .flat(2)
    .some(
      (hook) =>
        typeof hook === 'function' &&
        (hook as unknown as Record<symbol, unknown>)[GUARDED] === true,
    );
}

/**
 * Makes "forgot the guard" a start-up failure (QA): every route declared under this scope whose
 * path starts with /v1 must be guarded, unless it is in `open` as "METHOD /path" (HEAD counts as
 * GET). Add the hook before declaring any route.
 */
export function enforceGuardedRoutes(scope: FastifyInstance, open: ReadonlySet<string>): void {
  scope.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/v1')) return;
    if (isGuarded(route)) return;
    for (const method of [route.method].flat()) {
      const key = `${method === 'HEAD' ? 'GET' : method} ${route.url}`;
      if (!open.has(key)) {
        throw new Error(
          `${key} has no auth guard: add guard() to the route, or list it as an open route in v1.ts`,
        );
      }
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
