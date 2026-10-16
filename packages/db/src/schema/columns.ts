/**
 * Schema: the column builders and the CHECK helper every table file shares (and the global rev sequence).
 */
import { type SQL, sql } from 'drizzle-orm';
import { bigint, customType, integer, pgSequence, timestamp, uuid } from 'drizzle-orm/pg-core';

export const revSeq = pgSequence('rev_seq');

export const id = () => uuid('id').primaryKey().default(sql`uuid_generate_v7()`);
/** A byte string. PGlite hands back a Uint8Array and postgres-js a Buffer; callers always get a Buffer. */
export const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => 'bytea',
  toDriver: (value) => value,
  fromDriver: (value) => Buffer.from(value),
});
export const money = (name: string) => bigint(name, { mode: 'number' });
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const sync = {
  version: integer('version').notNull().default(1),
  rev: bigint('rev', { mode: 'number' }).notNull().default(0),
  updatedAt: ts('updated_at').notNull().defaultNow(),
};

export function oneOf(column: string, values: readonly string[]): SQL {
  return sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(', ')})`);
}
