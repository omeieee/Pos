import { createDb, schema } from '@sds/db';
import { describe, expect, test } from 'vitest';
import { buildApp } from './app.ts';
import {
  LOG_REDACT_PATHS,
  redactQueryParams,
  scrubLogArgs,
  scrubSentryEvent,
  sentryOptions,
  serializeErr,
} from './redact.ts';

// Made-up customer data (rule 10: no real personal data in tests).
const PHONE = '0812345678';
const NOTE = 'ไม่ใส่ผัก ห้อง 1204';

/** Built exactly like drizzle-orm's DrizzleQueryError (errors.js). */
function drizzleError(query: string, params: unknown[], cause?: Error) {
  const e = new Error(`Failed query: ${query}\nparams: ${params}`);
  return Object.assign(e, { query, params, cause });
}

describe('redactQueryParams', () => {
  test('keeps the SQL and cuts everything after "params:"', () => {
    const msg = `Failed query: insert into "customers" ("phone") values ($1)\nparams: ${PHONE}`;
    const out = redactQueryParams(msg);
    expect(out).toContain('Failed query: insert into "customers"');
    expect(out).not.toContain(PHONE);
  });

  test('handles params that span several lines or contain "params:"', () => {
    const out = redactQueryParams(
      `Failed query: update t set a = $1\nparams: x\nparams: ${NOTE}\n${PHONE}`,
    );
    expect(out).not.toContain(PHONE);
    expect(out).not.toContain('ห้อง');
  });

  test('leaves other messages alone', () => {
    expect(redactQueryParams('connect ECONNREFUSED')).toBe('connect ECONNREFUSED');
    expect(redactQueryParams('Failed query: select 1')).toBe('Failed query: select 1');
  });
});

describe('scrubLogArgs (pino logMethod hook)', () => {
  const leaky = `Failed query: select 1 where phone = $1\nparams: ${PHONE}`;

  test('scrubs string messages', () => {
    expect(JSON.stringify(scrubLogArgs([{ a: 1 }, leaky]))).not.toContain(PHONE);
    expect(JSON.stringify(scrubLogArgs([leaky]))).not.toContain(PHONE);
  });

  test('gives pino a scrubbed msg where it would copy err.message into it', () => {
    const err = new Error(leaky);
    for (const args of [[err], [{ err }], [{ err, reqId: 'r1' }]]) {
      const out = scrubLogArgs(args);
      expect(out[1], JSON.stringify(args)).toBe(redactQueryParams(leaky));
      expect(String(out[1])).not.toContain(PHONE);
    }
  });

  test('keeps an explicit message, an explicit msg property, and non-error arguments', () => {
    const err = new Error(leaky);
    expect(scrubLogArgs([{ err }, 'request failed'])).toEqual([{ err }, 'request failed']);
    expect(scrubLogArgs([{ err, msg: 'mine' }])).toEqual([{ err, msg: 'mine' }]);
    expect(scrubLogArgs([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(scrubLogArgs(['plain %s', 'x'])).toEqual(['plain %s', 'x']);
  });
});

describe('serializeErr (pino err serializer)', () => {
  test('drops params from message, stack and own properties, and detail from the cause', () => {
    const cause = Object.assign(new Error('duplicate key value violates unique constraint "k"'), {
      code: '23505',
      detail: `Key (phone)=(${PHONE}) already exists.`,
    });
    const err = drizzleError(
      'insert into "customers" ("phone", "note") values ($1, $2)',
      [PHONE, NOTE],
      cause,
    );
    const out = serializeErr(err) as Record<string, unknown>;

    const json = JSON.stringify(out);
    expect(json).not.toContain(PHONE);
    expect(json).not.toContain('ห้อง');
    expect(out.message).toContain('Failed query: insert into "customers"');
    expect(String(out.stack)).toContain('Failed query: insert into "customers"');
    expect(out).not.toHaveProperty('params');
    expect(out.cause).toMatchObject({ code: '23505' });
  });

  test('passes non-objects through and survives a cause cycle', () => {
    expect(serializeErr('plain')).toBe('plain');
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.assign(a, { cause: b });
    expect(() => JSON.stringify(serializeErr(a))).not.toThrow();
  });

  test('a real DrizzleQueryError (drizzle-orm format canary)', async () => {
    const { db, close } = createDb('postgresql://u:p@127.0.0.1:1/x', { max: 1 });
    try {
      const error = await db
        .insert(schema.customers)
        .values({ phone: PHONE, note: NOTE })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect((error as Error).message, 'drizzle keeps params in the message').toContain(PHONE);
      const json = JSON.stringify(serializeErr(error));
      expect(json).toContain('Failed query');
      expect(json).not.toContain(PHONE);
      expect(json).not.toContain('ห้อง');
    } finally {
      await close();
    }
  });
});

describe('Sentry', () => {
  test('sendDefaultPii is off and the DSN, environment and release pass through', () => {
    const o = sentryOptions({
      dsn: 'https://k@example.ingest.sentry.io/1',
      environment: 'production',
      release: 'abc',
    });
    expect(o).toMatchObject({
      dsn: 'https://k@example.ingest.sentry.io/1',
      environment: 'production',
      release: 'abc',
      sendDefaultPii: false,
    });
    expect(o.beforeSend).toBe(scrubSentryEvent);
  });

  test('scrubSentryEvent cleans the exception values (linked causes included) and the message', () => {
    const leaky = `Failed query: insert into "customers" ("phone") values ($1)\nparams: ${PHONE}`;
    const event = scrubSentryEvent({
      message: leaky,
      exception: { values: [{ value: 'duplicate key' }, { value: leaky }, {}] },
    });
    expect(JSON.stringify(event)).not.toContain(PHONE);
    const sql = 'Failed query: insert into "customers" ("phone") values ($1)';
    expect(event.message).toContain(sql);
    expect(event.exception?.values?.[0]?.value).toBe('duplicate key');
    expect(event.exception?.values?.[1]?.value).toContain(sql);
  });

  test('scrubSentryEvent copes with events that have no exception', () => {
    expect(scrubSentryEvent({})).toEqual({});
  });
});

describe('Sentry requests', () => {
  test('scrubSentryEvent drops the body and cookies and hides credential headers', () => {
    const event = scrubSentryEvent({
      request: {
        url: 'https://api.example.test/v1/auth/pin',
        data: { staffId: 'x', pin: '4821' },
        cookies: { a: 'b' },
        headers: {
          authorization: 'Bearer sds_ses_secret',
          'x-device-token': 'sds_dev_secret',
          'user-agent': 'iPad',
        },
      },
    });
    const json = JSON.stringify(event);
    expect(json).not.toContain('4821');
    expect(json).not.toContain('sds_ses_secret');
    expect(json).not.toContain('sds_dev_secret');
    expect(event.request?.data).toBeUndefined();
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.headers).toMatchObject({ 'user-agent': 'iPad' });
    expect(event.request?.url).toBe('https://api.example.test/v1/auth/pin');
  });

  // A 5xx on GET /v1/payments/:id/qr.png would otherwise ship the 5-minute QR credential.
  const SIG = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE';

  test('scrubSentryEvent strips the query string (the QR sig) from the request URL', () => {
    for (const url of [
      `https://api.example.test/v1/payments/p1/qr.png?exp=1790000000&sig=${SIG}`,
      `https://api.example.test/v1/payments/p1/qr.png?sig=${SIG}#frag`,
      `/v1/payments/p1/qr.png?exp=1&sig=${SIG}`,
    ]) {
      const event = scrubSentryEvent({ request: { url } });
      expect(event.request?.url).not.toContain('?');
      expect(event.request?.url).not.toContain('sig');
      expect(event.request?.url).toContain('/v1/payments/p1/qr.png');
      expect(JSON.stringify(event)).not.toContain(SIG);
    }
  });

  test('scrubSentryEvent drops query_string whatever its shape', () => {
    for (const query_string of [
      `exp=1&sig=${SIG}`,
      { exp: '1', sig: SIG },
      [
        ['exp', '1'],
        ['sig', SIG],
      ],
    ]) {
      const event = scrubSentryEvent({
        request: { url: 'https://x.test/a', query_string },
      });
      expect(event.request?.query_string).toBeUndefined();
      expect(JSON.stringify(event)).not.toContain(SIG);
    }
  });

  test('scrubSentryEvent cleans the sig out of breadcrumbs and messages too', () => {
    const event = scrubSentryEvent({
      message: `Route GET:/v1/payments/p1/qr.png?exp=1&sig=${SIG} failed`,
      exception: { values: [{ value: `bad link /qr.png?exp=1&sig=${SIG}` }] },
      breadcrumbs: [
        { data: { url: `https://x.test/qr.png?exp=1&sig=${SIG}`, method: 'GET' } },
        { message: `GET /qr.png?sig=${SIG}` },
        {},
      ],
    });
    expect(JSON.stringify(event)).not.toContain(SIG);
    expect(event.breadcrumbs?.[0]?.data).toMatchObject({ method: 'GET' });
    expect(String(event.breadcrumbs?.[0]?.data?.url)).toBe('https://x.test/qr.png');
  });

  test('scrubSentryEvent drops the query a breadcrumb carries under http.query', () => {
    const event = scrubSentryEvent({
      breadcrumbs: [
        {
          data: {
            url: 'https://x.test/qr.png',
            'http.query': `exp=1&sig=${SIG}`,
            'http.method': 'GET',
          },
        },
      ],
    });
    expect(JSON.stringify(event)).not.toContain(SIG);
    expect(event.breadcrumbs?.[0]?.data).toEqual({
      url: 'https://x.test/qr.png',
      'http.method': 'GET',
    });
  });

  test('scrubSentryEvent leaves a URL without a query alone', () => {
    const event = scrubSentryEvent({ request: { url: 'https://x.test/v1/menu' } });
    expect(event.request?.url).toBe('https://x.test/v1/menu');
  });
});

describe('log redaction of credentials', () => {
  function capture() {
    const lines: string[] = [];
    const ready = buildApp({
      config: { corsOrigins: [], version: 't' },
      checkDb: async () => {},
      logger: { level: 'trace', stream: { write: (l: string) => void lines.push(l) } },
    });
    return { lines, ready };
  }

  test('hides credential fields wherever a handler might log them', async () => {
    const { lines, ready } = capture();
    const app = await ready;
    const secrets = {
      password: 'pw-secret-value',
      pin: '4821',
      totp: '123456',
      recoveryCode: 'ABCD-EFGH-JKLM-NPQR',
      sessionToken: 'sds_ses_secret-value',
      deviceToken: 'sds_dev_secret-value',
      authorization: 'Bearer sds_ses_secret-value',
      'x-device-token': 'sds_dev_secret-value',
      idValue: '0987654321',
      idToken: 'liff-id-token-secret',
      accessToken: 'liff-access-token-secret',
      token: 'sds_cst.customer-session-secret',
      lineUserId: 'Utest-line-user-secret',
    };
    app.log.info({ body: secrets }, 'top');
    app.log.info({ req: { headers: secrets } }, 'request');
    app.log.info({ res: { body: { nested: secrets } } }, 'nested');
    app.log.info({ ...secrets }, 'flat');
    await app.close();

    const out = lines.join('');
    for (const value of Object.values(secrets)) expect(out).not.toContain(value);
    expect(out).toContain('[redacted]');
    expect(LOG_REDACT_PATHS.length).toBeGreaterThan(0);
  });

  test('keeps non-secret fields', async () => {
    const { lines, ready } = capture();
    const app = await ready;
    app.log.info({ body: { staffId: 'abc', pin: '4821' } }, 'x');
    await app.close();
    expect(lines.join('')).toContain('"staffId":"abc"');
  });
});
