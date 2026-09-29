import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { MIGRATIONS_DIR } from './client.ts';
import * as schema from './schema.ts';

export type PgliteDb = PgliteDatabase<typeof schema>;

/**
 * Local development and tests only (`@sds/db/pglite`, D-03): embedded PGlite, in memory
 * unless a data directory is given, with all migrations applied. Production never loads it.
 */
export async function createPgliteDb(dataDir?: string): Promise<{ db: PgliteDb; client: PGlite }> {
  const client = new PGlite(dataDir);
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, client };
}
