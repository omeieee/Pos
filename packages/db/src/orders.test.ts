import type { PGlite } from '@electric-sql/pglite';
import { satang } from '@sds/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import * as repo from './orders.ts';
import * as paymentsRepo from './payments.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import {
  menuCategories,
  menuItemChannelPrices,
  menuItemModifierGroups,
  menuItems,
  modifierGroups,
  modifierOptions,
  orders,
  settings,
  staff,
} from './schema.ts';
import { getSettingValue } from './settings.ts';

let db: PgliteDb;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
}, 60_000);
afterAll(async () => {
  await client.close();
});

const unique = () => crypto.randomUUID();
const placedAt = new Date('2026-10-01T03:00:00Z');

function newOrder(over: Partial<repo.NewOrder> = {}): repo.NewOrder {
  return {
    orderNo: `S-${unique().slice(0, 6)}`,
    businessDate: '2026-10-01',
    channel: 'storefront',
    fulfillment: 'entrance_delivery',
    roomNo: null,
    deliveryBuilding: 'B1',
    recipientName: 'Test Recipient',
    deliveryNote: null,
    customerId: null,
    status: 'preparing',
    subtotalSatang: 5000,
    discountSatang: 0,
    totalSatang: 5000,
    note: null,
    createdByStaffId: null,
    createdOnDeviceId: null,
    clientRequestId: unique(),
    requestHash: unique(),
    placedAt,
    acceptedAt: placedAt,
    ...over,
  };
}

describe('nextDailySeq', () => {
  test('counts up from 1 within a business day, and each day has its own count', async () => {
    expect(await repo.nextDailySeq(db, '2030-01-01')).toBe(1);
    expect(await repo.nextDailySeq(db, '2030-01-01')).toBe(2);
    expect(await repo.nextDailySeq(db, '2030-01-02')).toBe(1);
    expect(await repo.nextDailySeq(db, '2030-01-01')).toBe(3);
  });

  test('simultaneous callers in separate transactions all get different numbers', async () => {
    // PGlite runs transactions one after another, so this checks the contract (one atomic
    // statement, no gaps, no repeats) but cannot prove isolation; that rests on the upsert.
    const numbers = await Promise.all(
      Array.from({ length: 10 }, () => db.transaction((tx) => repo.nextDailySeq(tx, '2030-02-01'))),
    );
    expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('a rolled-back transaction gives its number back', async () => {
    await repo.nextDailySeq(db, '2030-03-01');
    await expect(
      db.transaction(async (tx) => {
        await repo.nextDailySeq(tx, '2030-03-01');
        throw new Error('order failed');
      }),
    ).rejects.toThrow('order failed');
    expect(await repo.nextDailySeq(db, '2030-03-01')).toBe(2);
  });
});

describe('orders', () => {
  test('an order number is unique within its business day, not across days', async () => {
    const a = newOrder({ orderNo: 'S-001', businessDate: '2031-01-01' });
    await repo.insertOrder(db, a);
    await expect(
      repo.insertOrder(db, newOrder({ orderNo: 'S-001', businessDate: '2031-01-01' })),
    ).rejects.toThrow();
    expect(
      await repo.insertOrder(db, newOrder({ orderNo: 'S-001', businessDate: '2031-01-02' })),
    ).toBeDefined();
  });

  test('a second insert with the same client request id returns nothing and adds no row', async () => {
    const first = newOrder();
    const created = await repo.insertOrder(db, first);
    expect(created).toMatchObject({ orderNo: first.orderNo, version: 1 });
    const again = await repo.insertOrder(db, {
      ...newOrder(),
      clientRequestId: first.clientRequestId,
    });
    expect(again).toBeUndefined();
    expect((await repo.findOrderByClientRequestId(db, first.clientRequestId))?.id).toBe(
      created?.id,
    );
  });

  test('the request fingerprint is saved with the order', async () => {
    const hash = 'a'.repeat(64);
    const row = await repo.insertOrder(db, newOrder({ requestHash: hash }));
    expect(row?.requestHash).toBe(hash);
    expect((await repo.findOrderById(db, row?.id ?? ''))?.requestHash).toBe(hash);
  });

  test('money columns come back as plain integers and times as dates', async () => {
    const row = await repo.insertOrder(db, newOrder({ subtotalSatang: 12345, totalSatang: 12345 }));
    expect(row?.totalSatang).toBe(12345);
    expect(row?.placedAt).toEqual(placedAt);
    expect(row?.businessDate).toBe('2026-10-01');
  });

  test('items are saved with their snapshots and read back grouped by order', async () => {
    const a = await repo.insertOrder(db, newOrder());
    const b = await repo.insertOrder(db, newOrder());
    const menuItemId = await anyMenuItem();
    const item = {
      menuItemId,
      nameThSnapshot: 'ก๋วยเตี๋ยว',
      nameEnSnapshot: null,
      unitPriceSatang: 5000,
      unitCostSatang: 2200,
      qty: 2,
      modifiers: [],
      note: null,
      lineTotalSatang: 10000,
    };
    await repo.insertOrderItems(db, a?.id ?? '', [item, item]);
    await repo.insertOrderItems(db, b?.id ?? '', [item]);
    const byOrder = await repo.loadOrderItems(db, [a?.id ?? '', b?.id ?? '']);
    expect(byOrder.get(a?.id ?? '')).toHaveLength(2);
    expect(byOrder.get(b?.id ?? '')).toHaveLength(1);
    expect((await repo.loadOrderItems(db, [])).size).toBe(0);
  });

  test('items inserted in the same millisecond read back in cart order, 100 times in a row', async () => {
    const menuItemId = await anyMenuItem();
    const cart = Array.from({ length: 12 }, (_, i) => ({
      menuItemId,
      nameThSnapshot: `จานที่ ${i + 1}`,
      nameEnSnapshot: null,
      unitPriceSatang: 5000,
      unitCostSatang: null,
      qty: 1,
      modifiers: [],
      note: null,
      lineTotalSatang: 5000,
    }));
    const frozen = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 25, 4, 0, 0));
    try {
      for (let run = 0; run < 100; run += 1) {
        const order = await repo.insertOrder(db, newOrder());
        const inserted = await repo.insertOrderItems(db, order?.id ?? '', cart);
        // Every id carries the same millisecond, so only the order within it is being tested.
        expect(new Set(inserted.map((item) => item.id.slice(0, 13))).size).toBe(1);
        const read = (await repo.loadOrderItems(db, [order?.id ?? ''])).get(order?.id ?? '') ?? [];
        expect(read.map((item) => item.nameThSnapshot)).toEqual(cart.map((c) => c.nameThSnapshot));
      }
    } finally {
      frozen.mockRestore();
    }
  });

  test('lock, find and list', async () => {
    const day = '2032-05-05';
    const kitchen = await repo.insertOrder(
      db,
      newOrder({
        businessDate: day,
        channel: 'line',
        status: 'new',
        acceptedAt: null,
        placedAt: new Date('2026-10-01T03:05:00Z'),
      }),
    );
    const counter = await repo.insertOrder(
      db,
      newOrder({ businessDate: day, placedAt: new Date('2026-10-01T03:01:00Z') }),
    );
    await repo.insertOrder(db, newOrder({ businessDate: '2032-05-06' }));

    expect((await repo.findOrderById(db, kitchen?.id ?? ''))?.channel).toBe('line');
    expect((await repo.lockOrderById(db, counter?.id ?? ''))?.id).toBe(counter?.id);
    expect(await repo.findOrderById(db, unique())).toBeUndefined();

    const all = await repo.listOrders(db, { businessDate: day });
    expect(all.map((o) => o.id)).toEqual([counter?.id, kitchen?.id]); // oldest first
    expect(
      (await repo.listOrders(db, { businessDate: day, status: 'new' })).map((o) => o.id),
    ).toEqual([kitchen?.id]);
    expect(
      (await repo.listOrders(db, { businessDate: day, channel: 'storefront' })).map((o) => o.id),
    ).toEqual([counter?.id]);
    expect(await repo.listOrders(db, { businessDate: '2099-01-01' })).toEqual([]);
  });
});

describe('updateOrderIfVersion', () => {
  test('updates when the version matches and bumps version and rev', async () => {
    const created = await repo.insertOrder(db, newOrder());
    const updated = await repo.updateOrderIfVersion(db, created?.id ?? '', 1, {
      status: 'ready',
      readyAt: placedAt,
    });
    expect(updated).toMatchObject({ status: 'ready', version: 2, readyAt: placedAt });
    expect(updated?.rev).toBeGreaterThan(created?.rev ?? 0);
  });

  test('a stale version matches nothing and changes nothing', async () => {
    const created = await repo.insertOrder(db, newOrder());
    await repo.updateOrderIfVersion(db, created?.id ?? '', 1, { note: 'a' });
    expect(
      await repo.updateOrderIfVersion(db, created?.id ?? '', 1, { note: 'b' }),
    ).toBeUndefined();
    expect((await repo.findOrderById(db, created?.id ?? ''))?.note).toBe('a');
  });
});

describe('loadCatalog', () => {
  test('reads the item, channel prices, attached groups and options, with archived flags', async () => {
    const [category] = await db.insert(menuCategories).values({ nameTh: 'หมวด' }).returning();
    const [item] = await db
      .insert(menuItems)
      .values({
        categoryId: category?.id ?? '',
        nameTh: 'ก๋วยเตี๋ยว',
        nameEn: 'Noodles',
        priceSatang: 5000,
        estCostSatang: 2200,
        channels: ['storefront', 'grab'],
      })
      .returning();
    const [soldOut] = await db
      .insert(menuItems)
      .values({
        categoryId: category?.id ?? '',
        nameTh: 'หมด',
        priceSatang: 100,
        isAvailable: false,
      })
      .returning();
    await db
      .insert(menuItemChannelPrices)
      .values({ itemId: item?.id ?? '', channel: 'grab', priceSatang: 6500 });
    const [type, retired] = await db
      .insert(modifierGroups)
      .values([
        { nameTh: 'เส้น', minSelect: 1, maxSelect: 1 },
        { nameTh: 'เก่า', archivedAt: new Date() },
      ])
      .returning();
    const [thin, gone] = await db
      .insert(modifierOptions)
      .values([
        { groupId: type?.id ?? '', nameTh: 'เส้นเล็ก', priceDeltaSatang: 500, costDeltaSatang: 300 },
        { groupId: type?.id ?? '', nameTh: 'เลิกขาย', archivedAt: new Date() },
      ])
      .returning();
    await db.insert(menuItemModifierGroups).values([
      { itemId: item?.id ?? '', groupId: type?.id ?? '' },
      { itemId: item?.id ?? '', groupId: retired?.id ?? '' },
    ]);

    const catalog = await repo.loadCatalog(db, [item?.id ?? '', soldOut?.id ?? '', unique()]);
    expect(catalog.size).toBe(2);

    const noodles = catalog.get(item?.id ?? '');
    expect(noodles).toMatchObject({
      nameTh: 'ก๋วยเตี๋ยว',
      nameEn: 'Noodles',
      priceSatang: 5000,
      estCostSatang: 2200,
      isAvailable: true,
      archived: false,
      categoryActive: true,
      channels: ['storefront', 'grab'],
      channelPrices: { grab: satang(6500) },
    });
    const groups = noodles?.groups ?? [];
    expect(groups.map((g) => [g.nameTh, g.minSelect, g.maxSelect, g.archived])).toEqual(
      expect.arrayContaining([
        ['เส้น', 1, 1, false],
        ['เก่า', 0, 1, true],
      ]),
    );
    const typeGroup = groups.find((g) => g.id === type?.id);
    expect(typeGroup?.options.find((o) => o.id === thin?.id)).toMatchObject({
      priceDeltaSatang: 500,
      costDeltaSatang: 300,
      isAvailable: true,
      archived: false,
    });
    expect(typeGroup?.options.find((o) => o.id === gone?.id)?.archived).toBe(true);

    expect(catalog.get(soldOut?.id ?? '')).toMatchObject({
      isAvailable: false,
      groups: [],
      channelPrices: {},
    });
    expect((await repo.loadCatalog(db, [])).size).toBe(0);
  });

  test('says whether the item category is active, so a deactivated category cannot be sold from', async () => {
    const [live, dead] = await db
      .insert(menuCategories)
      .values([{ nameTh: 'เปิด' }, { nameTh: 'ปิด', active: false }])
      .returning();
    const [a, b] = await db
      .insert(menuItems)
      .values([
        { categoryId: live?.id ?? '', nameTh: 'a', priceSatang: 100 },
        { categoryId: dead?.id ?? '', nameTh: 'b', priceSatang: 100 },
      ])
      .returning();
    const catalog = await repo.loadCatalog(db, [a?.id ?? '', b?.id ?? '']);
    expect(catalog.get(a?.id ?? '')?.categoryActive).toBe(true);
    expect(catalog.get(b?.id ?? '')?.categoryActive).toBe(false);
  });
});

describe('settings reader', () => {
  test('returns the saved JSON, or undefined when nothing was saved', async () => {
    expect(await getSettingValue(db, 'business_day')).toBeUndefined();
    await db
      .insert(settings)
      .values({ key: 'business_day', value: { cutoffMinutes: 360, timeZone: 'Asia/Bangkok' } });
    expect(await getSettingValue(db, 'business_day')).toEqual({
      cutoffMinutes: 360,
      timeZone: 'Asia/Bangkok',
    });
  });
});

async function anyMenuItem(): Promise<string> {
  const [category] = await db.insert(menuCategories).values({ nameTh: 'x' }).returning();
  const [item] = await db
    .insert(menuItems)
    .values({ categoryId: category?.id ?? '', nameTh: 'x', priceSatang: 100 })
    .returning();
  return item?.id ?? '';
}

describe('summarizeMonth', () => {
  let staffId = '';
  /** A confirmed payment (and optional partial refunds) on an order, as the till writes them. */
  async function pay(
    orderId: string,
    amount: number,
    over: { status?: 'confirmed' | 'voided'; refunds?: number[] } = {},
  ) {
    if (!staffId) {
      const [row] = await db
        .insert(staff)
        .values({ displayName: 'cashier', role: 'cashier', pinHash: 'x' })
        .returning({ id: staff.id });
      staffId = row?.id ?? '';
    }
    const row = await paymentsRepo.insertPayment(db, {
      orderId,
      method: 'cash',
      status: over.status ?? 'confirmed',
      amountSatang: amount,
      confirmedByStaffId: staffId,
      confirmedAt: placedAt,
      clientRequestId: unique(),
      requestHash: unique(),
    });
    for (const back of over.refunds ?? []) {
      await paymentsRepo.insertRefund(db, {
        orderId,
        paymentId: row?.id ?? '',
        amountSatang: back,
        method: 'cash',
        reason: 'test',
        refundedByStaffId: staffId,
      });
    }
  }

  test('per business date: orders that are not cancelled, and paid revenue only', async () => {
    const at = (businessDate: string, over: Partial<repo.NewOrder> = {}) =>
      repo.insertOrder(db, newOrder({ businessDate, ...over }));
    // 2031-02 is its own month: nothing else in this file uses it.
    const paid = async (businessDate: string, totalSatang: number) => {
      const row = await at(businessDate, { totalSatang, subtotalSatang: totalSatang });
      await db
        .update(orders)
        .set({ paymentStatus: 'paid' })
        .where(eq(orders.id, row?.id ?? ''));
      await pay(row?.id ?? '', totalSatang);
    };
    await paid('2031-02-01', 5000);
    await paid('2031-02-01', 7000);
    await at('2031-02-01'); // unpaid: counted, no revenue
    await at('2031-02-01', { status: 'cancelled' }); // not counted at all
    await at('2031-02-28', { status: 'cancelled' }); // a day with only a cancelled order
    await paid('2031-02-27', 100);
    await at('2031-01-31'); // neighbouring months stay out
    await at('2031-03-01');

    expect(await repo.summarizeMonth(db, '2031-02')).toEqual([
      { date: '2031-02-01', orderCount: 3, paidCount: 2, paidSatang: 12000 },
      { date: '2031-02-27', orderCount: 1, paidCount: 1, paidSatang: 100 },
    ]);
    expect(await repo.summarizeMonth(db, '2031-12')).toEqual([]);
  });

  test('paid revenue follows 03-data-model §6: confirmed payments minus partial refunds', async () => {
    // 2031-04: one order paid 10,000 with 2,500 + 500 handed back, one with a voided payment
    // beside the confirmed one, and a paid order that has no confirmed payment (counts 0).
    const make = async (total: number) => {
      const row = await repo.insertOrder(
        db,
        newOrder({ businessDate: '2031-04-10', totalSatang: total, subtotalSatang: total }),
      );
      await db
        .update(orders)
        .set({ paymentStatus: 'paid' })
        .where(eq(orders.id, row?.id ?? ''));
      return row?.id ?? '';
    };
    await pay(await make(10000), 10000, { refunds: [2500, 500] });
    const second = await make(6000);
    await pay(second, 6000, { status: 'voided' });
    await pay(second, 6000);
    await make(4000);
    expect(await repo.summarizeMonth(db, '2031-04')).toEqual([
      { date: '2031-04-10', orderCount: 3, paidCount: 3, paidSatang: 7000 + 6000 },
    ]);
  });

  test('December ends at the year boundary', async () => {
    await repo.insertOrder(db, newOrder({ businessDate: '2032-12-31' }));
    await repo.insertOrder(db, newOrder({ businessDate: '2033-01-01' }));
    const days = await repo.summarizeMonth(db, '2032-12');
    expect(days.map((d) => d.date)).toEqual(['2032-12-31']);
  });
});
