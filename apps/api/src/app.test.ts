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

describe('5xx errors', () => {
  test('return the generic error body and log no query parameters', async () => {
    const lines: string[] = [];
    const a = await make({
      logger: { level: 'error', stream: { write: (line: string) => void lines.push(line) } },
    });
    // Built exactly like drizzle-orm's DrizzleQueryError; the values are made up.
    a.get('/boom', async () => {
      const sqlText = 'insert into "customers" ("phone", "note") values ($1, $2)';
      throw Object.assign(new Error(`Failed query: ${sqlText}\nparams: 0812345678,ห้อง 1204`), {
        query: sqlText,
        params: ['0812345678', 'ห้อง 1204'],
        cause: Object.assign(new Error('duplicate key'), {
          code: '23505',
          detail: 'Key (phone)=(0812345678) already exists.',
        }),
      });
    });

    const res = await a.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      code: 'INTERNAL',
      message: 'Internal server error',
      details: {},
    });

    const log = lines.join('');
    expect(log).toContain('Failed query: insert into');
    expect(log).toContain('23505');
    expect(log).not.toContain('0812345678');
    expect(log).not.toContain('ห้อง');
  });

  test('pino copies err.message into msg when no message is given: that copy is scrubbed too', async () => {
    const lines: string[] = [];
    const a = await make({
      logger: { level: 'error', stream: { write: (line: string) => void lines.push(line) } },
    });
    const err = new Error('Failed query: select 1\nparams: 0812345678,ห้อง 1204');
    a.log.error(err);
    a.log.error({ err });
    a.log.error({ err }, err.message);
    a.log.error(err.message);

    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line).toContain('Failed query: select 1');
      expect(line).not.toContain('0812345678');
      expect(line).not.toContain('ห้อง');
    }
  });
});

describe('other routes and CORS', () => {
  test('unknown routes return 404 in the error shape', async () => {
    const res = await (await make()).inject({ method: 'GET', url: '/v1/orders' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND', details: {} });
  });

  test('preflight allows PATCH, PUT and DELETE (@fastify/cors defaults to GET, HEAD, POST)', async () => {
    const a = await make();
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const res = await a.inject({
        method: 'OPTIONS',
        url: '/v1/orders/1',
        headers: {
          origin: 'https://pos.example.pages.dev',
          'access-control-request-method': method,
          'access-control-request-headers': 'content-type,idempotency-key',
        },
      });
      expect(res.statusCode, method).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('https://pos.example.pages.dev');
      expect(String(res.headers['access-control-allow-methods']).split(/,\s*/), method).toContain(
        method,
      );
    }
  });

  test('preflight allows the credential headers the staff app sends', async () => {
    const res = await (await make()).inject({
      method: 'OPTIONS',
      url: '/v1/auth/pin',
      headers: {
        origin: 'https://pos.example.pages.dev',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,x-device-token,content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    const allowed = String(res.headers['access-control-allow-headers']).toLowerCase();
    for (const header of ['authorization', 'x-device-token', 'content-type']) {
      expect(allowed).toContain(header);
    }
  });

  test('preflight answers are cacheable for 10 minutes, so iPads do not preflight every request', async () => {
    const res = await (await make()).inject({
      method: 'OPTIONS',
      url: '/v1/orders',
      headers: {
        origin: 'https://pos.example.pages.dev',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-max-age']).toBe('600');
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
