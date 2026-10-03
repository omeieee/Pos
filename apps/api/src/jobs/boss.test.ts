import { describe, expect, test } from 'vitest';
import { pgBossConnection } from './boss.ts';

// Made-up connection strings: the password is not real.
const pooler = 'aws-0-region.pooler.example.com:5432/postgres';
const url = (query = '') => `postgresql://postgres.ref:s3cret-pass@${pooler}${query}`;

describe('pgBossConnection: TLS the same way as the rest of the API', () => {
  test('sslmode=require encrypts without checking the certificate, and leaves the URL without TLS parameters', () => {
    const c = pgBossConnection(url('?sslmode=require'));
    expect(c.ssl).toEqual({ rejectUnauthorized: false });
    expect(c.connectionString).not.toContain('sslmode');
    expect(c.connectionString).toContain(
      's3cret-pass@aws-0-region.pooler.example.com:5432/postgres',
    );
  });

  test('a URL with no TLS parameter still gets TLS (never plaintext to a remote host)', () => {
    expect(pgBossConnection(url()).ssl).toEqual({ rejectUnauthorized: false });
  });

  test('a verifying mode verifies the certificate', () => {
    expect(pgBossConnection(url('?sslmode=verify-full')).ssl).toEqual({ rejectUnauthorized: true });
    expect(pgBossConnection(url('?sslrootcert=system')).ssl).toEqual({ rejectUnauthorized: true });
  });

  test('a loopback host is left alone', () => {
    const c = pgBossConnection('postgresql://u:p@localhost:5432/db?sslmode=disable');
    expect(c.ssl).toBeUndefined();
    expect(c.connectionString).not.toContain('sslmode');
  });

  test('other parameters of the URL are kept', () => {
    expect(pgBossConnection(url('?sslmode=require&application_name=x')).connectionString).toContain(
      'application_name=x',
    );
  });
});
