/** Unit tests for the connection options (no database needed). */
import postgres from 'postgres';
import { describe, expect, test } from 'vitest';
import { postgresOptions } from './client.ts';

const SUPABASE =
  'postgresql://postgres.ref:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres';

describe('postgresOptions: TLS', () => {
  test('a remote host (the Supabase pooler) requires TLS, with prepare off and the pool size set', () => {
    expect(postgresOptions(SUPABASE, 3)).toMatchObject({ ssl: 'require', prepare: false, max: 3 });
  });

  test.each([
    '?sslmode=disable',
    '?sslmode=allow',
    '?sslmode=prefer',
    '?ssl=false',
    '?sslmode=require',
  ])('a remote host with %s still ends up on require', (query) => {
    expect(postgresOptions(SUPABASE + query, 1).ssl).toBe('require');
  });

  test.each(['?sslmode=verify-full', '?sslmode=verify-ca', '?sslrootcert=system'])(
    'a verifying mode (%s) is kept, never downgraded to require',
    (query) => {
      expect(postgresOptions(SUPABASE + query, 1).ssl).toBe('verify-full');
    },
  );

  test.each([
    'postgresql://u:p@localhost:5432/x',
    'postgresql://u:p@127.0.0.1:5432/x',
    'postgresql://u:p@127.0.0.5:5432/x?sslmode=disable',
    'postgresql://u:p@[::1]:5432/x',
  ])('loopback (%s) leaves ssl unset so the URL decides', (url) => {
    expect('ssl' in postgresOptions(url, 1)).toBe(false);
  });

  test.each([
    'postgresql://u:p@localhost.evil.example:5432/x',
    'postgresql://u:p@127.0.0.1.evil.example:5432/x',
  ])('a look-alike host (%s) is not loopback', (url) => {
    expect(postgresOptions(url, 1).ssl).toBe('require');
  });

  test('an unparsable URL fails closed to require', () => {
    expect(postgresOptions('not a url', 1).ssl).toBe('require');
  });

  test('postgres-js takes our option over the URL: sslmode=disable cannot switch TLS off', async () => {
    const remote = `${SUPABASE}?sslmode=disable`;
    const sql = postgres(remote, postgresOptions(remote, 1));
    const local = 'postgresql://u:p@127.0.0.1:5432/x';
    const sqlLocal = postgres(local, postgresOptions(local, 1));
    try {
      expect(sql.options.ssl).toBe('require');
      expect(sqlLocal.options.ssl).toBe(false);
    } finally {
      await Promise.all([sql.end(), sqlLocal.end()]); // never connected: resolves at once
    }
  });
});
