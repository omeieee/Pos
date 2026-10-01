import type { Db } from '@sds/db';
import type { FastifyInstance } from 'fastify';
import { deriveAuthKeys } from './auth/crypto.ts';
import { createGuard, type GuardFactory } from './auth/guards.ts';
import { type AuthPolicy, DEFAULT_AUTH_POLICY } from './auth/policy.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import type { AuthContext } from './auth/service.ts';
import type { EventBus } from './events.ts';
import { registerOrderRoutes } from './orders/routes.ts';

export interface V1Deps {
  db: Db;
  /** AUTH_SECRET_KEY, 32 bytes. */
  authSecretKey: Buffer;
  events: EventBus;
  /** Tests inject a clock and shorter limits. */
  now?: () => Date;
  policy?: AuthPolicy;
}

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

  await app.register(
    async (v1) => {
      v1.decorateRequest('auth', null);
      await v1.register((scope) => registerAuthRoutes(scope, context.auth, context.guard), {
        prefix: '/auth',
      });
      await v1.register((scope) => registerOrderRoutes(scope, context.auth, context.guard), {
        prefix: '/orders',
      });
    },
    { prefix: '/v1' },
  );
}
