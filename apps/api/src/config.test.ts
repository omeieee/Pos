import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

const SECRET_URL = 'postgresql://postgres.ref:s3cret-pass@pooler.example.com:5432/postgres';
// Test-only key: 32 bytes of 9s, not a secret.
const KEY_BYTES = Buffer.alloc(32, 9);
const KEY = KEY_BYTES.toString('base64');
const base = { DATABASE_URL: SECRET_URL, AUTH_SECRET_KEY: KEY };

describe('loadConfig', () => {
  test('applies defaults', () => {
    expect(loadConfig(base)).toEqual({
      nodeEnv: 'development',
      databaseUrl: SECRET_URL,
      authSecretKey: KEY_BYTES,
      port: 3000,
      corsOrigins: [],
      sentryDsn: undefined,
      version: 'dev',
    });
  });

  test('parses the CORS list, port, empty Sentry DSN and git sha', () => {
    const c = loadConfig({
      ...base,
      PORT: '8080',
      CORS_ORIGINS: 'https://a.pages.dev, https://b.pages.dev ,',
      SENTRY_DSN: '',
      GIT_SHA: 'deadbeef',
      NODE_ENV: 'production',
    });
    expect(c.port).toBe(8080);
    expect(c.corsOrigins).toEqual(['https://a.pages.dev', 'https://b.pages.dev']);
    expect(c.sentryDsn).toBeUndefined();
    expect(c.version).toBe('deadbeef');
    expect(c.nodeEnv).toBe('production');
  });

  test('rejects a missing or non-postgres DATABASE_URL', () => {
    expect(() => loadConfig({ AUTH_SECRET_KEY: KEY })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });

  describe('AUTH_SECRET_KEY', () => {
    test('is required', () => {
      expect(() => loadConfig({ DATABASE_URL: SECRET_URL })).toThrow(/AUTH_SECRET_KEY/);
    });

    test.each([
      ['too short', Buffer.alloc(16, 1).toString('base64')],
      ['too long', Buffer.alloc(33, 1).toString('base64')],
      ['not base64', `${'!'.repeat(43)}=`],
      ['empty', ''],
    ])('rejects a key that is %s, without echoing it', (_label, value) => {
      let message = '';
      try {
        loadConfig({ ...base, AUTH_SECRET_KEY: value });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/AUTH_SECRET_KEY/);
      if (value) expect(message).not.toContain(value);
    });
  });

  describe('TLS to the database', () => {
    const production = (url: string) => ({ ...base, NODE_ENV: 'production', DATABASE_URL: url });

    test.each(['?sslmode=disable', '?sslmode=DISABLE', '?ssl=false', '?ssl=disable'])(
      'production rejects %s, without echoing the URL',
      (query) => {
        let message = '';
        try {
          loadConfig(production(SECRET_URL + query));
        } catch (e) {
          expect(e).toBeInstanceOf(ConfigError);
          message = (e as Error).message;
        }
        expect(message).toMatch(/DATABASE_URL/);
        expect(message).toMatch(/TLS/);
        expect(message).not.toContain('s3cret');
      },
    );

    test.each(['', '?sslmode=require', '?sslmode=verify-full'])(
      'production accepts a URL with sslmode "%s"',
      (query) => {
        expect(loadConfig(production(SECRET_URL + query)).databaseUrl).toBe(SECRET_URL + query);
      },
    );

    test('outside production, sslmode=disable is allowed (local Postgres)', () => {
      const url = `${SECRET_URL}?sslmode=disable`;
      expect(loadConfig({ ...base, NODE_ENV: 'development', DATABASE_URL: url }).databaseUrl).toBe(
        url,
      );
      expect(loadConfig({ ...base, DATABASE_URL: url }).databaseUrl).toBe(url);
    });
  });

  test('errors never echo values', () => {
    let message = '';
    try {
      loadConfig({ ...base, PORT: 'not-a-port', CORS_ORIGINS: 'ftp://s3cret' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/PORT/);
    expect(message).toMatch(/CORS_ORIGINS/);
    expect(message).not.toContain('s3cret');
  });
});
