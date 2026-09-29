import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

const SECRET_URL = 'postgresql://postgres.ref:s3cret-pass@pooler.example.com:5432/postgres';

describe('loadConfig', () => {
  test('applies defaults', () => {
    expect(loadConfig({ DATABASE_URL: SECRET_URL })).toEqual({
      nodeEnv: 'development',
      databaseUrl: SECRET_URL,
      port: 3000,
      corsOrigins: [],
      sentryDsn: undefined,
      version: 'dev',
    });
  });

  test('parses the CORS list, port, empty Sentry DSN and git sha', () => {
    const c = loadConfig({
      DATABASE_URL: SECRET_URL,
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
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });

  describe('TLS to the database', () => {
    const production = (url: string) => ({ NODE_ENV: 'production', DATABASE_URL: url });

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
      expect(loadConfig({ NODE_ENV: 'development', DATABASE_URL: url }).databaseUrl).toBe(url);
      expect(loadConfig({ DATABASE_URL: url }).databaseUrl).toBe(url);
    });
  });

  test('errors never echo values', () => {
    let message = '';
    try {
      loadConfig({ DATABASE_URL: SECRET_URL, PORT: 'not-a-port', CORS_ORIGINS: 'ftp://s3cret' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/PORT/);
    expect(message).toMatch(/CORS_ORIGINS/);
    expect(message).not.toContain('s3cret');
  });
});
