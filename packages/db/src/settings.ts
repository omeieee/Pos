import { eq } from 'drizzle-orm';
import type { Db } from './client.ts';
import { settings } from './schema.ts';

/** The raw JSON value of a setting, or undefined when it has never been saved. Callers parse it. */
export async function getSettingValue(db: Db, key: string): Promise<unknown> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return row?.value;
}
