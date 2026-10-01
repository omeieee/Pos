/**
 * Route guard (02 §7): checks the bearer session, then the role's permission from
 * `@sds/shared`, then step-up for the sensitive ones. Every route in /v1 except the sign-in
 * routes uses it. UIs only hide what is not allowed; this is what enforces it.
 */
import { hasPermission, type Permission, requiresStepUp } from '@sds/shared';
import type { FastifyRequest } from 'fastify';
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

const BEARER = /^Bearer ([A-Za-z0-9_-]{20,200})$/i;

/**
 * `guard()` needs any valid session; `guard('x.y')` also needs the permission, and a fresh
 * step-up when the permission is a sensitive one.
 */
export function createGuard(ctx: AuthContext): GuardFactory {
  return function guard(permission) {
    return async (request) => {
      const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
      if (!token) throw unauthenticated();
      const principal = await authenticateSession(ctx, token);
      if (!principal) throw unauthenticated();
      request.auth = principal;

      if (permission === undefined) return;
      if (!hasPermission(principal.role, permission)) throw forbidden();
      if (requiresStepUp(permission) && !hasFreshStepUp(principal, ctx.now())) {
        throw stepUpRequired();
      }
    };
  };
}

/** The principal the guard set. A route without a guard has none, which is a bug: fail closed. */
export function principalOf(request: FastifyRequest): Principal {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}
