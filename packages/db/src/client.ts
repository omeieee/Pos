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

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * The TLS mode to force, or undefined to leave it to the URL (loopback only).
 * postgres-js gives an explicit option priority over the URL and defaults to plaintext,
 * so a URL without `sslmode` would otherwise send the password and every row unencrypted.
 * A verifying mode in the URL is kept, not downgraded to `require` (which encrypts
 * but does not check the certificate).
 */
function tlsFor(url: string): 'require' | 'verify-full' | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'require';
  }
  const params = parsed.searchParams;
  const mode = (params.get('sslmode') ?? params.get('ssl'))?.toLowerCase();
  if (mode === 'verify-full' || mode === 'verify-ca' || params.get('sslrootcert') === 'system') {
    return 'verify-full';
  }
  return LOOPBACK_HOST.test(parsed.hostname) ? undefined : 'require';
}

/** postgres-js options for a connection URL: the pooler-safe settings plus enforced TLS. */
export function postgresOptions(url: string, max: number) {
  const ssl = tlsFor(url);
  return { ...CLIENT_OPTIONS, max, ...(ssl ? { ssl } : {}) };
}

/**
 * Production client (D-03 Path B: Supabase over the session pooler). Connects lazily,
 * so creating it never touches the network. Call `close()` on shutdown.
 */
export function createDb(url: string, options: { max?: number } = {}) {
  const client = postgres(url, postgresOptions(url, options.max ?? 5));
  const db = drizzle({ client, schema });
  return { db: db as Db, close: () => client.end({ timeout: 5 }) };
}

/** Readiness probe: a trivial round trip. Throws if the database is unreachable. */
export async function pingDb(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}

/** Like `pingDb`, but on a brand-new connection that bypasses the long-lived pool. */
export async function pingFreshDb(url: string): Promise<void> {
  const client = postgres(url, postgresOptions(url, 1));
  try {
    await client`select 1`;
  } finally {
    await client.end({ timeout: 2 });
  }
}

/** Applies every pending migration with one connection, then closes it. */
export async function runMigrations(
  url: string,
  migrationsFolder: string = MIGRATIONS_DIR,
): Promise<void> {
  const client = postgres(url, postgresOptions(url, 1));
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
  } finally {
    await client.end({ timeout: 5 });
  }
}
