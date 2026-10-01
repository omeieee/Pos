/**
 * Route inventory (QA Medium): a new /v1 route must not be reachable without the guard just
 * because someone forgot it. registerV1 refuses to start such a route, and this test lists what
 * is registered today.
 */
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createEventBus } from '../events.ts';
import { createHarness, type Harness } from '../test-support/harness.ts';
import { OPEN_ROUTES, registerV1 } from '../v1.ts';
import { enforceGuardedRoutes, isGuarded } from './guards.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

// The real list, not a copy: if someone adds an open route to v1.ts this test has to be looked at.
const OPEN = [...OPEN_ROUTES];

describe('the real /v1 routes', () => {
  test('every one has the guard, except the three sign-in routes', () => {
    const v1 = h.routes.filter((r) => r.url.startsWith('/v1'));
    expect(v1.length).toBeGreaterThan(8);
    // Fastify adds a HEAD route next to every GET; it counts as the GET.
    const key = (r: { method: string; url: string }) =>
      `${r.method === 'HEAD' ? 'GET' : r.method} ${r.url}`;
    const open = [...new Set(v1.filter((r) => !r.guarded).map(key))];
    expect(open.sort()).toEqual([...OPEN].sort());
    // ...and the list itself is exactly the three sign-in routes, so it cannot grow unnoticed.
    expect(OPEN.sort()).toEqual(['GET /v1/auth/staff', 'POST /v1/auth/owner', 'POST /v1/auth/pin']);
  });

  test('the inventory includes the routes we know about', () => {
    const all = new Set(h.routes.map((r) => `${r.method} ${r.url}`));
    for (const route of [
      'POST /v1/auth/device',
      'POST /v1/auth/step-up',
      'GET /v1/auth/me',
      'POST /v1/auth/logout',
      'POST /v1/orders',
      'GET /v1/orders',
      'GET /v1/orders/:id',
      'PATCH /v1/orders/:id',
      'POST /v1/orders/:id/transition',
      'POST /v1/orders/:id/cancel',
    ]) {
      expect(all.has(route), route).toBe(true);
    }
  });

  test('routes outside /v1 are not covered by the rule (the test probes here)', () => {
    const outside = h.routes.filter((r) => !r.url.startsWith('/v1')).map((r) => r.url);
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.every((url) => !url.startsWith('/v1'))).toBe(true);
  });
});

describe('enforceGuardedRoutes', () => {
  const guarded = Object.assign(async () => {}, { [Symbol.for('sds.guarded')]: true });
  const allow = new Set(['GET /v1/open']);

  async function appWith(register: (app: ReturnType<typeof Fastify>) => void): Promise<void> {
    const app = Fastify();
    enforceGuardedRoutes(app, allow);
    register(app);
    try {
      await app.ready();
    } finally {
      await app.close();
    }
  }

  test('lets a route through that runs the guard in onRequest', async () => {
    await expect(
      appWith((app) => {
        app.get('/v1/a', { onRequest: guarded }, async () => ({}));
        app.post('/v1/c', { onRequest: [async () => {}, guarded] }, async () => ({}));
      }),
    ).resolves.toBeUndefined();
  });

  test('refuses a route whose guard is only in preHandler: the body would be parsed first', async () => {
    await expect(
      appWith((app) => app.get('/v1/b', { preHandler: guarded }, async () => ({}))),
    ).rejects.toThrow(/GET \/v1\/b/);
    await expect(
      appWith((app) => app.get('/v1/b', { preHandler: [guarded] }, async () => ({}))),
    ).rejects.toThrow(/GET \/v1\/b/);
  });

  test('refuses a /v1 route without the guard, naming it', async () => {
    await expect(appWith((app) => app.get('/v1/oops', async () => ({})))).rejects.toThrow(
      /GET \/v1\/oops.*guard/,
    );
    await expect(
      appWith((app) => app.post('/v1/oops', { onRequest: async () => {} }, async () => ({}))),
    ).rejects.toThrow(/POST \/v1\/oops/);
  });

  test('lets an allow-listed route through, but only by its exact method and path', async () => {
    await expect(appWith((app) => app.get('/v1/open', async () => ({})))).resolves.toBeUndefined();
    await expect(appWith((app) => app.post('/v1/open', async () => ({})))).rejects.toThrow(
      /POST \/v1\/open/,
    );
    await expect(appWith((app) => app.get('/v1/open/more', async () => ({})))).rejects.toThrow();
  });

  test('does not look at routes outside /v1', async () => {
    await expect(appWith((app) => app.get('/healthz', async () => ({})))).resolves.toBeUndefined();
  });

  test('isGuarded sees nothing in an empty route', () => {
    expect(isGuarded({})).toBe(false);
    expect(isGuarded({ onRequest: guarded })).toBe(true);
    expect(isGuarded({ onRequest: [async () => {}, guarded] })).toBe(true);
    expect(isGuarded({ preHandler: guarded })).toBe(false);
  });
});

describe('registerV1 itself', () => {
  test('refuses to start when an unguarded route appears under /v1 through its own scopes', async () => {
    const app = Fastify();
    // Slip an unguarded route into the real /orders scope as soon as it is created, i.e. the way a
    // careless new module would. If registerV1 did not install the check, this would start fine.
    app.addHook('onRegister', (instance, opts) => {
      if ((opts as { prefix?: string }).prefix === '/orders') {
        instance.get('/sneaky', async () => ({}));
      }
    });
    try {
      await expect(
        registerV1(app, {
          db: h.db,
          authSecretKey: Buffer.alloc(32, 1),
          events: createEventBus(),
        }).then(() => app.ready()),
      ).rejects.toThrow(/GET \/v1\/orders\/sneaky has no auth guard/);
    } finally {
      await app.close().catch(() => {});
    }
  });
});
