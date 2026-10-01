import { and, desc, eq } from 'drizzle-orm';
import type { Db } from './client.ts';
import { govCopaySchemes, settings } from './schema.ts';

/** The raw JSON value of a setting, or undefined when it has never been saved. Callers parse it. */
export async function getSettingValue(db: Db, key: string): Promise<unknown> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return row?.value;
}

export interface SettingRow {
  key: string;
  value: unknown;
  version: number;
  rev: number;
  updatedAt: Date;
}

const settingColumns = {
  key: settings.key,
  value: settings.value,
  version: settings.version,
  rev: settings.rev,
  updatedAt: settings.updatedAt,
};

export async function getSettingRow(db: Db, key: string): Promise<SettingRow | undefined> {
  const [row] = await db
    .select(settingColumns)
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return row;
}

/** Locks the row (if there is one) until the transaction ends. */
export async function lockSettingRow(db: Db, key: string): Promise<SettingRow | undefined> {
  const [row] = await db
    .select(settingColumns)
    .from(settings)
    .where(eq(settings.key, key))
    .for('update')
    .limit(1);
  return row;
}

/** Inserts a setting that was never saved; undefined if another request created it first. */
export async function insertSettingRow(
  db: Db,
  key: string,
  value: unknown,
  updatedBy: string,
): Promise<SettingRow | undefined> {
  const [row] = await db
    .insert(settings)
    .values({ key, value, updatedBy })
    .onConflictDoNothing({ target: settings.key })
    .returning(settingColumns);
  return row;
}

/** One UPDATE guarded by the version the caller saw; the sync trigger bumps version and rev. */
export async function updateSettingRowIfVersion(
  db: Db,
  key: string,
  expectedVersion: number,
  value: unknown,
  updatedBy: string,
): Promise<SettingRow | undefined> {
  const [row] = await db
    .update(settings)
    .set({ value, updatedBy })
    .where(and(eq(settings.key, key), eq(settings.version, expectedVersion)))
    .returning(settingColumns);
  return row;
}

// ---------- Government co-pay scheme (gov_copay_schemes) ----------

export type GovCopayRow = typeof govCopaySchemes.$inferSelect;

export interface NewGovCopayRow {
  code: string;
  nameTh: string;
  nameEn: string | null;
  settlementNote: string | null;
  govShareBp: number;
  govDailyCapSatang: number | null;
  govTotalCapSatang: number | null;
  activeFrom: string;
  activeTo: string;
  activeFromMinute: number;
  activeToMinute: number;
  channels: string[];
  enabled: boolean;
}

/** The scheme the shop uses: the one whose round ends last. Locks it for the transaction. */
export async function lockGovCopayRow(db: Db): Promise<GovCopayRow | undefined> {
  const [row] = await db
    .select()
    .from(govCopaySchemes)
    .orderBy(desc(govCopaySchemes.activeTo), desc(govCopaySchemes.id))
    .for('update')
    .limit(1);
  return row;
}

export async function getGovCopayRow(db: Db): Promise<GovCopayRow | undefined> {
  const [row] = await db
    .select()
    .from(govCopaySchemes)
    .orderBy(desc(govCopaySchemes.activeTo), desc(govCopaySchemes.id))
    .limit(1);
  return row;
}

export async function insertGovCopayRow(db: Db, row: NewGovCopayRow): Promise<GovCopayRow> {
  const [created] = await db.insert(govCopaySchemes).values(row).returning();
  if (!created) throw new Error('scheme insert returned no row');
  return created;
}

export async function updateGovCopayRowIfVersion(
  db: Db,
  id: string,
  expectedVersion: number,
  patch: Partial<NewGovCopayRow>,
): Promise<GovCopayRow | undefined> {
  const [row] = await db
    .update(govCopaySchemes)
    .set(patch)
    .where(and(eq(govCopaySchemes.id, id), eq(govCopaySchemes.version, expectedVersion)))
    .returning();
  return row;
}
