import { describe, expect, test } from 'vitest';
import { pgBossConnection, startJobs } from './boss.ts';

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

describe('startJobs cleans up after a partial failure', () => {
  const deps = {} as never;
  const log = { info: () => {}, error: () => {} };
  const databaseUrl = 'postgresql://u:p@localhost/db';
  function fakeBoss(failAt: 'start' | 'createQueue' | 'work' | 'schedule' | null) {
    const calls: string[] = [];
    const step = (name: string) => async () => {
      calls.push(name);
      if (failAt === name) throw new Error('boom');
    };
    return {
      calls,
      boss: {
        on: () => {},
        start: step('start'),
        createQueue: step('createQueue'),
        work: step('work'),
        schedule: step('schedule'),
        stop: step('stop'),
      },
    };
  }

  for (const failAt of ['start', 'createQueue', 'work', 'schedule'] as const) {
    test(`a failure in ${failAt} stops pg-boss and rethrows`, async () => {
      const { boss, calls } = fakeBoss(failAt);
      await expect(
        startJobs({ databaseUrl, deps, log, createBoss: () => boss as never }),
      ).rejects.toThrow('boom');
      expect(calls).toContain('stop');
    });
  }

  test('on success it keeps running until stop() is called', async () => {
    const { boss, calls } = fakeBoss(null);
    const jobs = await startJobs({ databaseUrl, deps, log, createBoss: () => boss as never });
    expect(calls).not.toContain('stop');
    await jobs.stop();
    expect(calls).toContain('stop');
  });
});
