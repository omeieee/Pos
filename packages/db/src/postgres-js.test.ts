/**
 * The production path (postgres-js over TCP) against PGlite behind a Postgres wire-protocol
 * socket. Proves runMigrations, createDb and pingDb speak to a real server, with prepare: false.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDb, MIGRATIONS_DIR, pingDb, runMigrations, schema } from './index.ts';

let pg: PGlite;
let server: PGLiteSocketServer;
let url: string;

beforeAll(async () => {
  pg = new PGlite();
  const port = 40000 + Math.floor(Math.random() * 20000);
  server = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1', maxConnections: 4 });
  await server.start();
  url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
}, 60_000);

afterAll(async () => {
  await server.stop();
  await pg.close();
});

describe('postgres-js client', () => {
  test('runMigrations applies every migration once, and a second run is a no-op', async () => {
    await runMigrations(url);
    await runMigrations(url);
    const applied = await pg.query<{ n: number }>(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    expect(applied.rows[0]?.n).toBe(journal.entries.length);
  }, 60_000); // every migration, twice, through PGlite: the 5 s default fails on a loaded machine

  test('createDb queries through the schema and pingDb succeeds', async () => {
    const { db, close } = createDb(url, { max: 1 });
    try {
      await pingDb(db);
      const rows = await db.select().from(schema.menuCategories);
      expect(rows).toEqual([]);
    } finally {
      await close();
    }
  });

  test('pingDb rejects when the server is unreachable', async () => {
    const { db, close } = createDb('postgresql://u:p@127.0.0.1:1/x', { max: 1 });
    try {
      await expect(pingDb(db)).rejects.toThrow();
    } finally {
      await close();
    }
  });
});
