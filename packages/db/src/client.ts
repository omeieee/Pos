import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export type Db = PgliteDatabase<typeof schema>;

/**
 * Local development and tests (D-03): embedded PGlite, in memory unless a data
 * directory is given, with all migrations applied.
 */
export async function createPgliteDb(dataDir?: string): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite(dataDir);
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, client };
}
