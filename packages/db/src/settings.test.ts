import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as auth from './auth.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import * as repo from './settings.ts';

let db: PgliteDb;
let client: PGlite;
let staffId: string;
beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
  staffId = (
    await auth.insertOwner(db, {
      email: 'o@example.test',
      displayName: 'o',
      passwordHash: 'x',
      pinHash: null,
      encryptTotpSecret: () => 'e',
      recoveryCodeHashes: [],
    })
  ).staffId;
}, 60_000);
afterAll(async () => {
  await client.close();
});

describe('setting rows', () => {
  test('absent until inserted; the insert starts at version 1', async () => {
    expect(await repo.getSettingRow(db, 'shop')).toBeUndefined();
    expect(await repo.lockSettingRow(db, 'shop')).toBeUndefined();
    const row = await repo.insertSettingRow(db, 'shop', { nameTh: 'ร้าน' }, staffId);
    expect(row).toMatchObject({ key: 'shop', value: { nameTh: 'ร้าน' }, version: 1 });
    expect(row?.rev).toBeGreaterThan(0);
    expect(await repo.getSettingValue(db, 'shop')).toEqual({ nameTh: 'ร้าน' });
  });

  test('a second insert of the same key returns nothing and changes nothing', async () => {
    expect(await repo.insertSettingRow(db, 'shop', { nameTh: 'อื่น' }, staffId)).toBeUndefined();
    expect((await repo.getSettingRow(db, 'shop'))?.value).toEqual({ nameTh: 'ร้าน' });
  });

  test('an update needs the version the caller saw and bumps version and rev', async () => {
    const before = await repo.getSettingRow(db, 'shop');
    const updated = await repo.updateSettingRowIfVersion(db, 'shop', 1, { nameTh: 'ใหม่' }, staffId);
    expect(updated).toMatchObject({ version: 2, value: { nameTh: 'ใหม่' } });
    expect(updated?.rev).toBeGreaterThan(before?.rev ?? 0);
    expect(
      await repo.updateSettingRowIfVersion(db, 'shop', 1, { nameTh: 'เก่า' }, staffId),
    ).toBeUndefined();
    expect((await repo.getSettingRow(db, 'shop'))?.value).toEqual({ nameTh: 'ใหม่' });
  });
});

describe('gov co-pay scheme row', () => {
  const scheme = {
    code: 'test_round',
    nameTh: 'ทดสอบ',
    nameEn: null,
    settlementNote: null,
    govShareBp: 6000,
    govDailyCapSatang: 20000,
    govTotalCapSatang: null,
    activeFrom: '2026-10-01',
    activeTo: '2026-11-30',
    activeFromMinute: 360,
    activeToMinute: 1380,
    channels: ['storefront'],
    enabled: false,
  };

  test('none at first; insert, read and guarded update', async () => {
    expect(await repo.getGovCopayRow(db)).toBeUndefined();
    const row = await repo.insertGovCopayRow(db, scheme);
    expect(row).toMatchObject({ code: 'test_round', enabled: false, version: 1 });
    expect((await repo.getGovCopayRow(db))?.id).toBe(row.id);
    expect((await repo.lockGovCopayRow(db))?.id).toBe(row.id);

    const on = await repo.updateGovCopayRowIfVersion(db, row.id, 1, { enabled: true });
    expect(on).toMatchObject({ enabled: true, version: 2 });
    expect(
      await repo.updateGovCopayRowIfVersion(db, row.id, 1, { enabled: false }),
    ).toBeUndefined();
  });

  test('with several rows, the round that ends last is the one used', async () => {
    const later = await repo.insertGovCopayRow(db, {
      ...scheme,
      code: 'later_round',
      activeFrom: '2027-01-01',
      activeTo: '2027-02-28',
    });
    expect((await repo.getGovCopayRow(db))?.id).toBe(later.id);
  });

  test('the database itself refuses inconsistent dates or hours', async () => {
    await expect(
      repo.insertGovCopayRow(db, {
        ...scheme,
        code: 'bad_dates',
        activeFrom: '2030-02-01',
        activeTo: '2030-01-01',
      }),
    ).rejects.toThrow();
    await expect(
      repo.insertGovCopayRow(db, {
        ...scheme,
        code: 'bad_hours',
        activeFromMinute: 900,
        activeToMinute: 600,
      }),
    ).rejects.toThrow();
  });
});
