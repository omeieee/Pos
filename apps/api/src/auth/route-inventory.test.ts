/**
 * Route inventory (QA Medium): a new /v1 route must not be reachable without the guard just
 * because someone forgot it. registerV1 refuses to start such a route, and this test lists what
 * is registered today.
 */
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createEventBus } from '../events.ts';
import { createHarness, type Harness } from '../test-support/harness.ts';
import {
  FIRST_MESSAGE_AUTH_ROUTES,
  LINE_SIGNATURE_ROUTES,
  OPEN_ROUTES,
  PUBLIC_MEDIA_ROUTES,
  registerV1,
  SIGNED_URL_ROUTES,
} from '../v1.ts';
import {
  enforceGuardedRoutes,
  hasFirstMessageAuth,
  hasPublicMediaCheck,
  hasSignedUrlCheck,
  isGuarded,
  markFirstMessageAuth,
  markPublicMediaCheck,
  markSignedUrlCheck,
} from './guards.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

// The real list, not a copy: if someone adds an open route to v1.ts this test has to be looked at.
const OPEN = [...OPEN_ROUTES];
const SIGNED = [...SIGNED_URL_ROUTES];
const WS = [...FIRST_MESSAGE_AUTH_ROUTES];
const MEDIA = [...PUBLIC_MEDIA_ROUTES];
const LINE_WEBHOOK = [...LINE_SIGNATURE_ROUTES];

describe('the real /v1 routes', () => {
  test('every one has the guard, except the sign-in routes, the public menu, the signed-URL routes and the socket', () => {
    const v1 = h.routes.filter((r) => r.url.startsWith('/v1'));
    expect(v1.length).toBeGreaterThan(8);
    // Fastify adds a HEAD route next to every GET; it counts as the GET.
    const key = (r: { method: string; url: string }) =>
      `${r.method === 'HEAD' ? 'GET' : r.method} ${r.url}`;
    const open = [...new Set(v1.filter((r) => !r.guarded).map(key))];
    expect(open.sort()).toEqual([...OPEN, ...SIGNED, ...WS, ...MEDIA, ...LINE_WEBHOOK].sort());
    // ...and the list itself is exactly the sign-in routes and the public menu, so it cannot grow unnoticed.
    expect(OPEN.sort()).toEqual([
      'GET /v1/auth/staff',
      'GET /v1/menu',
      'POST /v1/auth/owner',
      'POST /v1/auth/pin',
    ]);
    // The signed-URL routes are the other exception: an <img> cannot send a header, so the
    // signature in the URL is the authentication. Adding to this list needs a decision, not a habit.
    expect(SIGNED.sort()).toEqual(['GET /v1/payments/:id/qr.png']);
    // The third exception: a browser WebSocket cannot send headers, so the socket authenticates
    // its first message (hub.ts). Only that one route, and only as a marked WebSocket handler.
    expect(WS.sort()).toEqual(['GET /v1/ws']);
    // The fourth: a menu item's photo, read by an <img> with no header and no signature (D-21).
    // Its hook serves only the photo of an item that is on the menu, at the version in the URL.
    expect(MEDIA.sort()).toEqual(['GET /v1/menu/items/:id/photo']);
    // The fifth: LINE's servers call the webhook with no session; the X-Line-Signature HMAC over
    // the raw body is the authentication (line/routes.ts, markLineSignatureCheck in preHandler).
    expect(LINE_WEBHOOK.sort()).toEqual(['POST /v1/line/webhook']);
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
      'POST /v1/orders/:id/payments',
      'GET /v1/orders/:id/payments',
      'POST /v1/payments/:id/claim',
      'POST /v1/payments/:id/confirm',
      'POST /v1/payments/:id/cancel-claimed',
      'POST /v1/payments/:id/change-method',
      'POST /v1/payments/:id/void',
      'POST /v1/payments/:id/refund',
      'GET /v1/payments/:id/qr-url',
      'GET /v1/payments/:id/qr.png',
      'GET /v1/sync',
      'GET /v1/ws',
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
  const signedAllow = new Set(['GET /v1/signed/:id']);
  const verifier = markSignedUrlCheck(async () => {});

  async function appWith(register: (app: ReturnType<typeof Fastify>) => void): Promise<void> {
    const app = Fastify();
    enforceGuardedRoutes(app, allow, signedAllow);
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

  test('lets a listed signed-URL route through only when it runs the signature verifier', async () => {
    await expect(
      appWith((app) => app.get('/v1/signed/:id', { onRequest: verifier }, async () => ({}))),
    ).resolves.toBeUndefined();
    await expect(
      appWith((app) =>
        app.get('/v1/signed/:id', { onRequest: [async () => {}, verifier] }, async () => ({})),
      ),
    ).resolves.toBeUndefined();
    // Listed, but nothing checks the signature: it would be a public route by accident.
    await expect(appWith((app) => app.get('/v1/signed/:id', async () => ({})))).rejects.toThrow(
      /GET \/v1\/signed\/:id.*does not verify the signature/,
    );
    await expect(
      appWith((app) => app.get('/v1/signed/:id', { onRequest: async () => {} }, async () => ({}))),
    ).rejects.toThrow(/does not verify the signature/);
    // A verifier in preHandler is too late: the query and body are parsed before it runs.
    await expect(
      appWith((app) => app.get('/v1/signed/:id', { preHandler: verifier }, async () => ({}))),
    ).rejects.toThrow(/does not verify the signature/);
  });

  test('a verifier alone does not open a route that is not on the signed-URL list', async () => {
    await expect(
      appWith((app) => app.get('/v1/other/:id', { onRequest: verifier }, async () => ({}))),
    ).rejects.toThrow(/GET \/v1\/other\/:id has no auth guard/);
    // ...and only the listed method counts.
    await expect(
      appWith((app) => app.post('/v1/signed/:id', { onRequest: verifier }, async () => ({}))),
    ).rejects.toThrow(/POST \/v1\/signed\/:id has no auth guard/);
    expect(isGuarded({ onRequest: verifier })).toBe(false);
    expect(hasSignedUrlCheck({ onRequest: verifier })).toBe(true);
    expect(hasSignedUrlCheck({ onRequest: guarded })).toBe(false);
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

describe('the public-media exception', () => {
  const mediaAllow = new Set(['GET /v1/media/:id']);
  const check = markPublicMediaCheck(async () => {});
  const guarded = Object.assign(async () => {}, { [Symbol.for('sds.guarded')]: true });

  async function appWith(register: (app: ReturnType<typeof Fastify>) => void): Promise<void> {
    const app = Fastify();
    enforceGuardedRoutes(app, new Set(), new Set(), new Set(), mediaAllow);
    register(app);
    try {
      await app.ready();
    } finally {
      await app.close();
    }
  }

  test('lets the listed route through only when it runs the marked check in onRequest', async () => {
    await expect(
      appWith((app) => app.get('/v1/media/:id', { onRequest: check }, async () => ({}))),
    ).resolves.toBeUndefined();
    await expect(
      appWith((app) =>
        app.get('/v1/media/:id', { onRequest: [async () => {}, check] }, async () => ({})),
      ),
    ).resolves.toBeUndefined();
    // Listed, but nothing limits it: it would be a public route by accident.
    await expect(appWith((app) => app.get('/v1/media/:id', async () => ({})))).rejects.toThrow(
      /GET \/v1\/media\/:id.*does not limit what it serves/,
    );
    await expect(
      appWith((app) => app.get('/v1/media/:id', { preHandler: check }, async () => ({}))),
    ).rejects.toThrow(/does not limit what it serves/);
  });

  test('a check alone does not open a route that is not on the list, or another method', async () => {
    await expect(
      appWith((app) => app.get('/v1/elsewhere/:id', { onRequest: check }, async () => ({}))),
    ).rejects.toThrow(/GET \/v1\/elsewhere\/:id has no auth guard/);
    await expect(
      appWith((app) => app.delete('/v1/media/:id', { onRequest: check }, async () => ({}))),
    ).rejects.toThrow(/DELETE \/v1\/media\/:id has no auth guard/);
    expect(hasPublicMediaCheck({ onRequest: check })).toBe(true);
    expect(hasPublicMediaCheck({ onRequest: guarded })).toBe(false);
    expect(isGuarded({ onRequest: check })).toBe(false);
  });
});

describe('the first-message-auth exception', () => {
  const wsAllow = new Set(['GET /v1/socket']);
  const marked = markFirstMessageAuth(() => {});

  test('hasFirstMessageAuth needs both the WebSocket flag and a marked handler', () => {
    expect(hasFirstMessageAuth({ websocket: true, handler: marked })).toBe(true);
    expect(hasFirstMessageAuth({ wsHandler: marked })).toBe(true);
    expect(hasFirstMessageAuth({ wsHandler: () => {} })).toBe(false);
    expect(hasFirstMessageAuth({ websocket: true, handler: () => {} })).toBe(false);
    expect(hasFirstMessageAuth({ handler: marked })).toBe(false);
    expect(hasFirstMessageAuth({})).toBe(false);
  });

  async function appWith(register: (app: ReturnType<typeof Fastify>) => void): Promise<void> {
    const app = Fastify();
    enforceGuardedRoutes(app, new Set(), new Set(), wsAllow);
    register(app);
    try {
      await app.ready();
    } finally {
      await app.close();
    }
  }

  test('lets the listed route through only when it is a WebSocket route with a marked handler', async () => {
    await expect(
      appWith((app) => app.get('/v1/socket', { websocket: true }, marked)),
    ).resolves.toBeUndefined();
    // Listed, but a plain HTTP handler: it would be a public route by accident.
    await expect(appWith((app) => app.get('/v1/socket', marked))).rejects.toThrow(
      /GET \/v1\/socket.*first-message-auth/,
    );
    // A WebSocket route whose handler does not authenticate.
    await expect(
      appWith((app) => app.get('/v1/socket', { websocket: true }, () => {})),
    ).rejects.toThrow(/first-message-auth/);
  });

  test('a marked WebSocket route that is not listed is refused', async () => {
    await expect(
      appWith((app) => app.get('/v1/other', { websocket: true }, marked)),
    ).rejects.toThrow(/GET \/v1\/other has no auth guard/);
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
