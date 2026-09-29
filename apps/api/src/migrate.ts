/**
 * One-shot migration runner for the image:
 *   docker run --rm --env-file .env <image> node dist/migrate.js
 * Applies pending migrations from dist/migrations and exits non-zero on failure.
 */
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@sds/db';
import { databaseUrlSchema } from './config.ts';
import { redactQueryParams } from './redact.ts';

const parsed = databaseUrlSchema.safeParse(process.env.DATABASE_URL);
if (!parsed.success) {
  console.error(`DATABASE_URL: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  process.exit(1);
}

const migrationsFolder = fileURLToPath(new URL('./migrations', import.meta.url));

try {
  await runMigrations(parsed.data, migrationsFolder);
  console.log('migrations applied');
} catch (error) {
  // Messages only (no connection string is part of them); the cause holds the Postgres error.
  const e = error as Error & { cause?: { message?: string; code?: string } };
  console.error(`migration failed: ${redactQueryParams(e.message)}`);
  if (e.cause?.message) console.error(`cause: ${e.cause.code ?? ''} ${e.cause.message}`);
  process.exit(1);
}
