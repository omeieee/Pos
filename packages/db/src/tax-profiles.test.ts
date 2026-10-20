import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import * as repo from './tax-profiles.ts';

let db: PgliteDb;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
}, 60_000);
afterAll(async () => {
  await client.close();
});

describe('tax profiles', () => {
  test('a year never saved has no row', async () => {
    expect(await repo.getTaxProfile(db, 2569)).toBeUndefined();
  });

  test('put creates, then replaces the whole profile of that year only', async () => {
    const first = await repo.putTaxProfile(db, 2569, {
      allowances: { items: [{ label: 'a', annualSatang: 100 }] },
      methodPreference: 'actual',
    });
    expect(first).toMatchObject({
      year: 2569,
      filerType: 'individual',
      methodPreference: 'actual',
    });
    await repo.putTaxProfile(db, 2570, { allowances: { items: [] }, methodPreference: null });
    const second = await repo.putTaxProfile(db, 2569, {
      allowances: { items: [] },
      methodPreference: 'flat',
    });
    expect(second.allowances).toEqual({ items: [] });
    expect(second.methodPreference).toBe('flat');
    expect((await repo.getTaxProfile(db, 2570))?.methodPreference).toBeNull();
    expect((await repo.lockTaxProfile(db, 2569))?.methodPreference).toBe('flat');
  });
});
