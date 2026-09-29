import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { type AppOptions, buildApp } from './app.ts';

const config = { corsOrigins: ['https://pos.example.pages.dev'], version: 'abc1234' };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function make(overrides: Partial<AppOptions> = {}) {
  app = await buildApp({ config, checkDb: async () => {}, logger: false, ...overrides });
  return app;
}

describe('GET /healthz', () => {
  test('returns ok and the build version without touching the database', async () => {
    let dbCalls = 0;
    const res = await (
      await make({
        checkDb: async () => {
          dbCalls++;
        },
      })
    ).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', version: 'abc1234' });
    expect(dbCalls).toBe(0);
  });
});

describe('GET /readyz', () => {
  test('returns 200 when the database answers', async () => {
    const res = await (await make()).inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  test('returns 503 with the error shape when the database fails', async () => {
    const res = await (
      await make({
        checkDb: async () => {
          throw Object.assign(new Error('connect ECONNREFUSED db.internal:5432'), {
            code: 'ECONNREFUSED',
          });
        },
      })
    ).inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      code: 'DB_UNAVAILABLE',
      message: 'Database is not reachable',
      details: {},
    });
    expect(res.body).not.toContain('db.internal');
  });

  test('returns 503 when the database hangs past the timeout', async () => {
    const res = await (
      await make({ checkDb: () => new Promise(() => {}), readyTimeoutMs: 50 })
    ).inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
  });

  test('is rate limited to 30 requests a minute per client', async () => {
    const a = await make();
    for (let i = 0; i < 30; i++) {
      expect((await a.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    }
    const limited = await a.inject({ method: 'GET', url: '/readyz' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMITED', details: {} });
    // /healthz is not limited.
    expect((await a.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
});

describe('other routes and CORS', () => {
  test('unknown routes return 404 in the error shape', async () => {
    const res = await (await make()).inject({ method: 'GET', url: '/v1/orders' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND', details: {} });
  });

  test('allows only configured origins', async () => {
    const a = await make();
    const allowed = await a.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://pos.example.pages.dev' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://pos.example.pages.dev');
    const denied = await a.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
