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
      line: {
        channelId: undefined,
        channelSecret: undefined,
        channelAccessToken: undefined,
        liffId: undefined,
      },
      privacy: { controller: 'omeie', contactEmail: 'omeza25482548@gmail.com' },
      slipDir: '/data/slips',
      r2: null,
      slipOcr: null,
      slipQr: true,
      slipVerifier: null,
      slipAutoconfirm: null,
    });
  });

  test('the slip reading is on in production, off elsewhere, and SLIP_OCR decides', () => {
    const prod = { ...base, NODE_ENV: 'production' };
    expect(loadConfig(prod).slipOcr).toEqual({ lang: 'tha+eng', timeoutMs: 60_000 });
    expect(loadConfig({ ...prod, SLIP_OCR: 'off' }).slipOcr).toBeNull();
    expect(loadConfig({ ...base, SLIP_OCR: 'tesseract', SLIP_OCR_LANG: 'eng' }).slipOcr).toEqual({
      lang: 'eng',
      timeoutMs: 60_000,
    });
    expect(
      loadConfig({ ...base, SLIP_OCR: 'tesseract', SLIP_OCR_TIMEOUT_MS: '90000' }).slipOcr,
    ).toEqual({ lang: 'tha+eng', timeoutMs: 90_000 });
    expect(loadConfig({ ...base, SLIP_QR: 'off' }).slipQr).toBe(false);
    expect(loadConfig({ ...base, SLIP_QR: 'on' }).slipQr).toBe(true);
    expect(() => loadConfig({ ...base, SLIP_OCR_LANG: 'eng; rm -rf /' })).toThrow(ConfigError);
  });

  test('the bank check by Slip2Go is off by default and needs its key when on (D-27)', () => {
    expect(loadConfig(base).slipVerifier).toBeNull();
    expect(loadConfig({ ...base, SLIP_VERIFIER: 'off' }).slipVerifier).toBeNull();
    const on = { ...base, SLIP_VERIFIER: 'slip2go', SLIP2GO_SECRET_KEY: 'k-not-a-real-key' };
    expect(loadConfig(on).slipVerifier).toEqual({
      baseUrl: 'https://connect.slip2go.com',
      secretKey: 'k-not-a-real-key',
      timeoutMs: 15_000,
      dailyCap: 100,
    });
    expect(
      loadConfig({
        ...on,
        SLIP2GO_BASE_URL: 'https://slip2go.example.test',
        SLIP2GO_TIMEOUT_MS: '5000',
        SLIP2GO_DAILY_CAP: '20',
      }).slipVerifier,
    ).toEqual({
      baseUrl: 'https://slip2go.example.test',
      secretKey: 'k-not-a-real-key',
      timeoutMs: 5000,
      dailyCap: 20,
    });
    expect(
      loadConfig({ ...on, SLIP2GO_SECRET_KEY: '', SLIP_VERIFIER: 'off' }).slipVerifier,
    ).toBeNull();
  });

  test('the Slip2Go settings are checked, and the error never shows the key', () => {
    const on = { ...base, SLIP_VERIFIER: 'slip2go' };
    expect(() => loadConfig(on)).toThrow(/SLIP2GO_SECRET_KEY/);
    expect(() =>
      loadConfig({ ...on, SLIP2GO_SECRET_KEY: 'k', SLIP2GO_BASE_URL: 'http://insecure.test' }),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ ...on, SLIP2GO_SECRET_KEY: 'k', SLIP2GO_DAILY_CAP: '0' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...base, SLIP_VERIFIER: 'other' })).toThrow(ConfigError);
    try {
      loadConfig({ ...on, SLIP2GO_SECRET_KEY: 'SECRET-KEY-VALUE', SLIP2GO_TIMEOUT_MS: 'abc' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('SECRET-KEY-VALUE');
    }
  });

  test('R2 storage is off by default, all four variables or none (D-36)', () => {
    const r2 = {
      R2_ACCOUNT_ID: 'a'.repeat(32),
      R2_ACCESS_KEY_ID: 'id-not-real',
      R2_SECRET_ACCESS_KEY: 'SECRET-VALUE-NOT-REAL',
      R2_BUCKET: 'sds-files',
    };
    expect(loadConfig(base).r2).toBeNull();
    expect(loadConfig({ ...base, ...r2 }).r2).toEqual({
      accountId: 'a'.repeat(32),
      accessKeyId: 'id-not-real',
      secretAccessKey: 'SECRET-VALUE-NOT-REAL',
      bucket: 'sds-files',
    });
    expect(loadConfig({ ...base, R2_ACCOUNT_ID: '', R2_BUCKET: '' }).r2).toBeNull();
    expect(() => loadConfig({ ...base, ...r2, R2_BUCKET: '' })).toThrow(/go together/);
    expect(() => loadConfig({ ...base, R2_BUCKET: 'sds-files' })).toThrow(/go together/);
    // The account id becomes part of a host name: only 32 hex characters.
    expect(() => loadConfig({ ...base, ...r2, R2_ACCOUNT_ID: 'evil.example/x' })).toThrow(
      ConfigError,
    );
    try {
      loadConfig({ ...base, ...r2, R2_BUCKET: 'Bad Bucket' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('SECRET-VALUE-NOT-REAL');
    }
  });

  test('auto-confirm is off by default, has a ceiling, and needs the bank check (D-27)', () => {
    const on = { ...base, SLIP_VERIFIER: 'slip2go', SLIP2GO_SECRET_KEY: 'k' };
    expect(loadConfig(on).slipAutoconfirm).toBeNull();
    expect(loadConfig({ ...on, SLIP_AUTOCONFIRM: 'off' }).slipAutoconfirm).toBeNull();
    expect(loadConfig({ ...on, SLIP_AUTOCONFIRM: 'on' }).slipAutoconfirm).toEqual({
      maxSatang: 100_000,
    });
    expect(
      loadConfig({ ...on, SLIP_AUTOCONFIRM: 'on', SLIP_AUTOCONFIRM_MAX_SATANG: '50000' })
        .slipAutoconfirm,
    ).toEqual({ maxSatang: 50_000 });
    expect(() => loadConfig({ ...base, SLIP_AUTOCONFIRM: 'on' })).toThrow(/SLIP_VERIFIER/);
    expect(() =>
      loadConfig({ ...on, SLIP_AUTOCONFIRM: 'on', SLIP_AUTOCONFIRM_MAX_SATANG: '0' }),
    ).toThrow(ConfigError);
  });

  test('the slip directory comes from SLIP_DIR, empty means the default', () => {
    expect(loadConfig({ ...base, SLIP_DIR: '/var/slips' }).slipDir).toBe('/var/slips');
    expect(loadConfig({ ...base, SLIP_DIR: '' }).slipDir).toBe('/data/slips');
  });

  test('the privacy notice controller and contact come from the environment, empty means the default', () => {
    expect(
      loadConfig({
        ...base,
        PRIVACY_CONTROLLER_NAME: 'Test Controller',
        PRIVACY_CONTACT_EMAIL: 'privacy@example.test',
      }).privacy,
    ).toEqual({ controller: 'Test Controller', contactEmail: 'privacy@example.test' });
    expect(
      loadConfig({ ...base, PRIVACY_CONTROLLER_NAME: '', PRIVACY_CONTACT_EMAIL: '' }).privacy,
    ).toEqual({ controller: 'omeie', contactEmail: 'omeza25482548@gmail.com' });
    expect(() => loadConfig({ ...base, PRIVACY_CONTACT_EMAIL: 'not-an-email' })).toThrow(
      ConfigError,
    );
  });

  test('reads the optional LINE variables, treats empty as unset and never echoes them', () => {
    const c = loadConfig({
      ...base,
      LINE_CHANNEL_ID: '1234567890',
      LINE_CHANNEL_SECRET: 'fake-secret-for-test',
      LINE_CHANNEL_ACCESS_TOKEN: '',
      LINE_LIFF_ID: '1234567890-AbCdEfGh',
    });
    expect(c.line).toEqual({
      channelId: '1234567890',
      channelSecret: 'fake-secret-for-test',
      channelAccessToken: undefined,
      liffId: '1234567890-AbCdEfGh',
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
