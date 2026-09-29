import { createDb, schema } from '@sds/db';
import { describe, expect, test } from 'vitest';
import {
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
