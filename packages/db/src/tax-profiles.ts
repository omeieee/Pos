/** The owner's tax inputs, one row per Buddhist Era tax year (P7, D-34). The caller parses `allowances`. */
import { eq } from 'drizzle-orm';
import type { Db } from './client.ts';
import { taxProfiles } from './schema.ts';

export type TaxProfileRow = typeof taxProfiles.$inferSelect;

export async function getTaxProfile(db: Db, year: number): Promise<TaxProfileRow | undefined> {
  const [row] = await db.select().from(taxProfiles).where(eq(taxProfiles.year, year)).limit(1);
  return row;
}

/** Locks the year's row (if any) until the transaction ends. */
export async function lockTaxProfile(db: Db, year: number): Promise<TaxProfileRow | undefined> {
  const [row] = await db
    .select()
    .from(taxProfiles)
    .where(eq(taxProfiles.year, year))
    .for('update')
    .limit(1);
  return row;
}

/** Replaces the whole profile of the year (creates it if new). */
export async function putTaxProfile(
  db: Db,
  year: number,
  value: { allowances: unknown; methodPreference: string | null },
): Promise<TaxProfileRow> {
  const [row] = await db
    .insert(taxProfiles)
    .values({ year, allowances: value.allowances, methodPreference: value.methodPreference })
    .onConflictDoUpdate({
      target: taxProfiles.year,
      set: { allowances: value.allowances, methodPreference: value.methodPreference },
    })
    .returning();
  if (!row) throw new Error('tax profile upsert returned no row');
  return row;
}
