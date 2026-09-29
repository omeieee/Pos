import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './schema.ts';

/** The committed migrations, when running from source. A bundled app passes its own copy. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** Driver-agnostic Drizzle database: postgres-js in production, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Settings that work through Supabase's Supavisor pooler (session mode today, and
 * transaction mode if we ever switch): no named prepared statements, no notice spam.
 */
const CLIENT_OPTIONS = {
  prepare: false,
  connect_timeout: 5,
  onnotice: () => {},
} as const;

/**
 * Production client (D-03 Path B: Supabase over the session pooler). Connects lazily,
 * so creating it never touches the network. Call `close()` on shutdown.
 */
export function createDb(url: string, options: { max?: number } = {}) {
  const client = postgres(url, { ...CLIENT_OPTIONS, max: options.max ?? 5 });
  const db = drizzle({ client, schema });
  return { db: db as Db, close: () => client.end({ timeout: 5 }) };
}

/** Readiness probe: a trivial round trip. Throws if the database is unreachable. */
export async function pingDb(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}

/** Applies every pending migration with one connection, then closes it. */
export async function runMigrations(
  url: string,
  migrationsFolder: string = MIGRATIONS_DIR,
): Promise<void> {
  const client = postgres(url, { ...CLIENT_OPTIONS, max: 1 });
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
  } finally {
    await client.end({ timeout: 5 });
  }
}
