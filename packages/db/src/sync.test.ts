import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { getTableColumns, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import * as schema from './schema.ts';
import * as sync from './sync.ts';

let db: PgliteDb;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
}, 60_000);
afterAll(async () => {
  await client.close();
});

const tables = Object.values(schema).filter((x) => is(x, PgTable)) as unknown as PgTable[];
const nameOf = (t: PgTable) => getTableConfig(t).name;

// ---------- The allow-lists themselves ----------

/** Column names that must never be in a feed row, on any table (the brief's list, in TS names). */
const FORBIDDEN_COLUMNS = [
  'pinHash',
  'failedPinCount',
  'lockedUntil',
  'stepUpFailedCount',
  'stepUpLockedUntil',
  'pinLockLevel',
  'stepUpLockLevel',
  'tokenHash',
  'passwordHash',
  'totpSecretEnc',
  'totpLastStep',
  'recoveryCodeHashes',
  'failedLoginCount',
  'requestHash',
  'clientRequestId',
  'qrPayload',
  'slipImageKey',
  'slipRef',
  'unitCostSatang',
  'estCostSatang',
  'costDeltaSatang',
  'platformCommissionSatang',
  'lineUserId',
  'phone',
  'pictureUrl',
  'updatedBy',
] as const;
/** ...and any name that looks like one, so a new column called `somethingSecret` is caught too. */
const SUSPICIOUS = /hash|token|secret|password|pin(?![a-z])|totp|recovery|cost|payload|credential/i;

describe('column allow-lists (a new column cannot leak by default)', () => {
  const policies = Object.entries(sync.SYNC_POLICY);

  test.each(policies)(
    '%s: every column is classified as allowed or denied, never both',
    (name, p) => {
      const all = Object.keys(getTableColumns(p.table)).sort();
      const classified = [...p.allow, ...p.deny].sort();
      // A column added to the table without a decision here fails this line.
      expect(classified).toEqual(all);
      expect(p.allow.filter((c) => (p.deny as readonly string[]).includes(c))).toEqual([]);
      expect(nameOf(p.table), name).toBe(name);
    },
  );

  test.each(policies)('%s: no forbidden or suspicious column is allowed', (_name, p) => {
    for (const column of p.allow) {
      expect(FORBIDDEN_COLUMNS as readonly string[], column).not.toContain(column);
      expect(SUSPICIOUS.test(column), column).toBe(false);
    }
  });

  test('every forbidden column that exists is denied wherever its table is in the feed', () => {
    for (const [, p] of policies) {
      for (const column of Object.keys(getTableColumns(p.table))) {
        if ((FORBIDDEN_COLUMNS as readonly string[]).includes(column)) {
          expect(p.deny as readonly string[], column).toContain(column);
        }
      }
    }
  });

  test('every synced table is in the feed or excluded on purpose, with a reason', () => {
    const inFeed = new Set(policies.map(([name]) => name));
    for (const name of schema.SYNCED_TABLES) {
      const excluded = name in sync.SYNC_EXCLUDED;
      expect(inFeed.has(name) || excluded, name).toBe(true);
      expect(inFeed.has(name) && excluded, name).toBe(false);
    }
    for (const reason of Object.values(sync.SYNC_EXCLUDED))
      expect(reason.length).toBeGreaterThan(20);
  });

  test('staff, devices, sessions, owner credentials and the audit log are not in the feed', () => {
    const inFeed = new Set(policies.map(([name]) => name));
    for (const t of [
      'staff',
      'devices',
      'sessions',
      'owner_credentials',
      'audit_log',
      'expenses',
      'line_events',
      'line_message_log',
      'daily_counters',
      'tax_profiles',
    ]) {
      expect(inFeed.has(t), t).toBe(false);
    }
  });

  test('the schema has no table the policy has never heard of among the ones with a rev', () => {
    for (const t of tables) {
      if (!('rev' in getTableColumns(t))) continue;
      const name = nameOf(t);
      expect(
        name in sync.SYNC_POLICY || name in sync.SYNC_EXCLUDED,
        `${name} has a rev column: choose feed or exclusion in sync.ts`,
      ).toBe(true);
    }
  });

  test('the reader never selects a whole row', () => {
    const source = readFileSync(new URL('./sync.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\.select\(\s*\)/);
    expect(source).not.toMatch(/\.returning\(\s*\)/);
  });
});

// ---------- Reading ----------

const SENTINELS = {
  unitCost: 7_777_701,
  estCost: 7_777_702,
  costDelta: 7_777_703,
  qr: 'QR-SENTINEL-0002010101',
  hash: 'HASH-SENTINEL-abc',
  slip: 'SLIP-SENTINEL-key',
  promptpayId: '0899990001',
  lineUser: 'U-SENTINEL-line-user',
  phone: '0811110002',
  pin: 'PIN-SENTINEL-scrypt',
  token: 'TOKEN-SENTINEL-hash',
  commission: 7_777_704,
  discount: 'DISCOUNT-SENTINEL',
  slipRef: 'SLIPREF-SENTINEL',
};

const all = { orders: true, payments: true, menu: true, settings: true, customers: true };
const none = { orders: false, payments: false, menu: false, settings: false, customers: false };

async function seedWorld() {
  const [staffRow] = await db
    .insert(schema.staff)
    .values({ displayName: 'cashier', role: 'cashier', pinHash: SENTINELS.pin })
    .returning();
  await db.insert(schema.devices).values({
    name: 'ipad',
    kind: 'ipad',
    tokenHash: SENTINELS.token,
  });
  const [category] = await db.insert(schema.menuCategories).values({ nameTh: 'หมวด' }).returning();
  const [item] = await db
    .insert(schema.menuItems)
    .values({
      categoryId: category?.id ?? '',
      nameTh: 'ก๋วยเตี๋ยว',
      priceSatang: 5000,
      estCostSatang: SENTINELS.estCost,
      channels: ['storefront', 'grab'],
    })
    .returning();
  await db
    .insert(schema.menuItemChannelPrices)
    .values({ itemId: item?.id ?? '', channel: 'grab', priceSatang: 6500 });
  const [group] = await db
    .insert(schema.modifierGroups)
    .values({ nameTh: 'เส้น', minSelect: 1, maxSelect: 1 })
    .returning();
  const [live, retired] = await db
    .insert(schema.modifierOptions)
    .values([
      { groupId: group?.id ?? '', nameTh: 'เล็ก', costDeltaSatang: SENTINELS.costDelta },
      { groupId: group?.id ?? '', nameTh: 'เลิกขาย', archivedAt: new Date() },
    ])
    .returning();
  await db
    .insert(schema.menuItemModifierGroups)
    .values({ itemId: item?.id ?? '', groupId: group?.id ?? '', sort: 1 });
  const [customer] = await db
    .insert(schema.customers)
    .values({
      lineUserId: SENTINELS.lineUser,
      displayName: 'คุณสมชาย',
      nickname: 'ชาย',
      phone: SENTINELS.phone,
      roomNo: '1204',
      pictureUrl: 'https://img.example.test/p.jpg',
      note: 'NOTE-SENTINEL',
      orderCount: 3,
      totalSpentSatang: 15000,
    })
    .returning();
  const [order] = await db
    .insert(schema.orders)
    .values({
      orderNo: 'S-001',
      businessDate: '2026-10-02',
      channel: 'storefront',
      fulfillment: 'takeaway',
      customerId: customer?.id ?? null,
      status: 'new',
      subtotalSatang: 5500,
      totalSatang: 5500,
      platformCommissionSatang: SENTINELS.commission,
      discountReason: SENTINELS.discount,
      createdByStaffId: staffRow?.id ?? null,
      clientRequestId: crypto.randomUUID(),
      requestHash: SENTINELS.hash,
    })
    .returning();
  await db.insert(schema.orderItems).values({
    orderId: order?.id ?? '',
    menuItemId: item?.id ?? '',
    nameThSnapshot: 'ก๋วยเตี๋ยว',
    unitPriceSatang: 5000,
    unitCostSatang: SENTINELS.unitCost,
    qty: 1,
    modifiers: [
      {
        groupId: group?.id,
        optionId: live?.id,
        nameTh: 'เล็ก',
        nameEn: null,
        priceDeltaSatang: 500,
        costDeltaSatang: SENTINELS.costDelta,
        surprise: 'MODIFIER-SENTINEL',
      },
    ],
    lineTotalSatang: 5500,
  });
  const [payment] = await db
    .insert(schema.payments)
    .values({
      orderId: order?.id ?? '',
      method: 'promptpay',
      amountSatang: 5500,
      promptpayTargetMasked: '******0001',
      qrPayload: SENTINELS.qr,
      slipImageKey: SENTINELS.slip,
      slipRef: SENTINELS.slipRef,
      clientRequestId: crypto.randomUUID(),
      requestHash: SENTINELS.hash,
    })
    .returning();
  await db.insert(schema.settings).values([
    { key: 'shop', value: { nameTh: 'แซ่บโดนเส้น', nameEn: null, phone: null, address: null } },
    { key: 'promptpay', value: { idType: 'phone', idValue: SENTINELS.promptpayId } },
    { key: 'line_channel_secret', value: { secret: 'LINE-SECRET-SENTINEL' } },
  ]);
  return { staffRow, category, item, group, live, retired, customer, order, payment };
}

describe('readChanges', () => {
  let world: Awaited<ReturnType<typeof seedWorld>>;
  beforeAll(async () => {
    world = await seedWorld();
  });

  test('returns every kind of row, oldest rev first, and nothing from the forbidden columns', async () => {
    const batch = await sync.readChanges(db, { since: 0, limit: 500, include: all });
    expect(batch.hasMore).toBe(false);
    const kinds = new Set(batch.entries.map((e) => e.kind));
    for (const kind of [
      'order',
      'payment',
      'category',
      'item',
      'group',
      'option',
      'customer',
      'setting',
    ]) {
      expect(kinds.has(kind as never), kind).toBe(true);
    }
    const revs = batch.entries.map((e) => e.rev);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
    expect(new Set(revs).size).toBe(revs.length);

    const json = JSON.stringify(batch);
    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(json, name).not.toContain(String(value));
    }
    expect(json).not.toContain('NOTE-SENTINEL');
    expect(json).not.toContain('MODIFIER-SENTINEL');
    expect(json).not.toContain('LINE-SECRET-SENTINEL');
    expect(json).not.toMatch(/cost|hash|token|payload|slip/i);
  });

  test('order lines come with their modifiers cut down to the known keys', async () => {
    const batch = await sync.readChanges(db, { since: 0, limit: 500, include: all });
    const entry = batch.entries.find((e) => e.kind === 'order');
    if (entry?.kind !== 'order') throw new Error('no order entry');
    expect(entry.order.id).toBe(world.order?.id);
    expect(entry.items).toHaveLength(1);
    expect(entry.items[0]?.modifiers).toEqual([
      {
        groupId: world.group?.id,
        optionId: world.live?.id,
        nameTh: 'เล็ก',
        nameEn: null,
        priceDeltaSatang: 500,
      },
    ]);
  });

  test('items bring channel prices and attached group ids; groups bring live options only', async () => {
    const batch = await sync.readChanges(db, { since: 0, limit: 500, include: all });
    const item = batch.entries.find((e) => e.kind === 'item');
    if (item?.kind !== 'item') throw new Error('no item entry');
    expect(item.channelPrices).toEqual({ grab: 6500 });
    expect(item.groupIds).toEqual([world.group?.id]);
    const group = batch.entries.find((e) => e.kind === 'group');
    if (group?.kind !== 'group') throw new Error('no group entry');
    expect(group.options.map((o) => o.id)).toEqual([world.live?.id]);
    // The retired option is still its own entry, flagged archived, so devices can drop it.
    const options = batch.entries.filter((e) => e.kind === 'option');
    expect(options).toHaveLength(2);
  });

  test('settings: only the listed keys, and the PromptPay ID is masked before it leaves this layer', async () => {
    const batch = await sync.readChanges(db, { since: 0, limit: 500, include: all });
    const settings = batch.entries.flatMap((e) => (e.kind === 'setting' ? [e.setting] : []));
    expect(settings.map((s) => s.key).sort()).toEqual(['promptpay', 'shop']);
    const pp = settings.find((s) => s.key === 'promptpay');
    expect(pp?.value).toEqual({ idType: 'phone', idMasked: '******0001' });
  });

  test('a PromptPay row that does not parse is skipped, not passed through raw', async () => {
    await client.query(
      'insert into settings (key, value) values (\'promptpay\', \'{"idValue":"RAW-OOPS"}\') on conflict (key) do update set value = excluded.value',
    );
    const batch = await sync.readChanges(db, { since: 0, limit: 500, include: all });
    expect(JSON.stringify(batch)).not.toContain('RAW-OOPS');
    expect(batch.entries.some((e) => e.kind === 'setting' && e.setting.key === 'promptpay')).toBe(
      false,
    );
    await client.query(
      `update settings set value = '{"idType":"phone","idValue":"${SENTINELS.promptpayId}"}' where key = 'promptpay'`,
    );
  });

  test('customers carry a small allow-list: no LINE id, phone, picture or note', async () => {
    const batch = await sync.readChanges(db, { since: 0, limit: 500, include: all });
    const c = batch.entries.find((e) => e.kind === 'customer');
    if (c?.kind !== 'customer') throw new Error('no customer');
    expect(Object.keys(c.customer).sort()).toEqual(
      [
        'anonymizedAt',
        'displayName',
        'firstSeenAt',
        'id',
        'lastOrderAt',
        'nickname',
        'orderCount',
        'rev',
        'roomNo',
        'totalSpentSatang',
        'version',
      ].sort(),
    );
  });

  test('staff and devices never appear, even when their rows change (failed PINs bump staff.version)', async () => {
    const before = (await sync.readChanges(db, { since: 0, limit: 500, include: all })).entries
      .length;
    const start = await sync.currentRev(db);
    await client.query('update staff set failed_pin_count = failed_pin_count + 1');
    await client.query('update devices set last_seen_at = now()');
    expect(await sync.currentRev(db)).toBeGreaterThan(start); // the revs were used...
    const after = await sync.readChanges(db, { since: start, limit: 500, include: all });
    expect(after.entries).toEqual([]); // ...but nothing is in the feed
    expect(
      (await sync.readChanges(db, { since: 0, limit: 500, include: all })).entries.length,
    ).toBe(before);
  });

  test('include switches whole families off', async () => {
    const only = async (family: keyof typeof all) =>
      (
        await sync.readChanges(db, {
          since: 0,
          limit: 500,
          include: { ...none, [family]: true },
        })
      ).entries.map((e) => e.kind);
    expect(new Set(await only('orders'))).toEqual(new Set(['order']));
    expect(new Set(await only('payments'))).toEqual(new Set(['payment']));
    expect(new Set(await only('menu'))).toEqual(new Set(['category', 'item', 'group', 'option']));
    expect(new Set(await only('settings'))).toEqual(new Set(['setting']));
    expect(new Set(await only('customers'))).toEqual(new Set(['customer']));
    expect((await sync.readChanges(db, { since: 0, limit: 500, include: none })).entries).toEqual(
      [],
    );
  });

  test('pages by rev: exclusive since, no gaps, no repeats, hasMore until the end', async () => {
    const full = (await sync.readChanges(db, { since: 0, limit: 500, include: all })).entries;
    expect(full.length).toBeGreaterThan(5);
    const seen: number[] = [];
    let since = 0;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await sync.readChanges(db, { since, limit: 3, include: all });
      expect(page.entries.length).toBeLessThanOrEqual(3);
      for (const e of page.entries) {
        expect(e.rev).toBeGreaterThan(since);
        seen.push(e.rev);
      }
      if (!page.hasMore) break;
      expect(page.entries).toHaveLength(3);
      since = page.entries[page.entries.length - 1]?.rev ?? since;
    }
    expect(seen).toEqual(full.map((e) => e.rev));
  });

  test('an exact page boundary is not "more"', async () => {
    const full = (await sync.readChanges(db, { since: 0, limit: 500, include: all })).entries;
    const exact = await sync.readChanges(db, { since: 0, limit: full.length, include: all });
    expect(exact.entries).toHaveLength(full.length);
    expect(exact.hasMore).toBe(false);
    const short = await sync.readChanges(db, { since: 0, limit: full.length - 1, include: all });
    expect(short.hasMore).toBe(true);
  });

  test('a row changed again moves to the head of the feed under its new rev', async () => {
    const first = (await sync.readChanges(db, { since: 0, limit: 500, include: all })).entries;
    const start = await sync.currentRev(db);
    await client.query("update orders set note = 'เพิ่มไข่' where id = $1", [world.order?.id]);
    const delta = await sync.readChanges(db, { since: start, limit: 500, include: all });
    expect(delta.entries).toHaveLength(1);
    const [only] = delta.entries;
    expect(only?.kind).toBe('order');
    expect(only?.rev).toBeGreaterThan(first[first.length - 1]?.rev ?? 0);
  });

  test('only the current co-pay scheme travels, and only when it changed after `since`', async () => {
    await db.insert(schema.govCopaySchemes).values([
      {
        code: 'old',
        nameTh: 'เก่า',
        govShareBp: 5000,
        activeFrom: '2026-01-01',
        activeTo: '2026-03-31',
      },
      {
        code: 'now',
        nameTh: 'ปัจจุบัน',
        govShareBp: 6000,
        activeFrom: '2026-10-01',
        activeTo: '2026-11-30',
      },
    ]);
    const batch = await sync.readChanges(db, { since: 0, limit: 500, include: all });
    const schemes = batch.entries.flatMap((e) => (e.kind === 'gov_copay' ? [e.scheme] : []));
    expect(schemes.map((s) => s.code)).toEqual(['now']);
    const later = await sync.readChanges(db, {
      since: schemes[0]?.rev ?? 0,
      limit: 500,
      include: all,
    });
    expect(later.entries.some((e) => e.kind === 'gov_copay')).toBe(false);
  });
});

describe('currentRev', () => {
  test('is the newest rev handed out, and moves with every synced write', async () => {
    const a = await sync.currentRev(db);
    const [c] = await db.insert(schema.menuCategories).values({ nameTh: 'ใหม่' }).returning();
    const b = await sync.currentRev(db);
    expect(b).toBe(c?.rev);
    expect(b).toBeGreaterThan(a);
  });
});

describe('sanitizeModifiers', () => {
  test('keeps the five known keys and drops everything else', () => {
    expect(
      sync.sanitizeModifiers([
        {
          groupId: 'g',
          optionId: 'o',
          nameTh: 'ไข่',
          nameEn: null,
          priceDeltaSatang: 500,
          costDeltaSatang: 300,
          other: 1,
        },
      ]),
    ).toEqual([{ groupId: 'g', optionId: 'o', nameTh: 'ไข่', nameEn: null, priceDeltaSatang: 500 }]);
  });

  test('anything that is not a list of objects becomes an empty list', () => {
    for (const bad of [null, undefined, 'x', 5, {}, [1, 'a', null]]) {
      expect(sync.sanitizeModifiers(bad)).toEqual([]);
    }
  });
});
