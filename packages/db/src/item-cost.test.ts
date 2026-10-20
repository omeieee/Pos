/**
 * D-32: "no cost entered" is NULL, not 0. Migration 0038 makes the two columns nullable and turns
 * the zeros that used to mean "not entered" into NULL. The backfill statements are read from the
 * migration file itself and run here on rows made to look like pre-0038 data.
 */
import { readFileSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as ordersRepo from './orders.ts';
import { createPgliteDb, type PgliteDb } from './pglite.ts';
import { menuCategories, menuItems, orderItems } from './schema.ts';

let db: PgliteDb;
let client: PGlite;
beforeAll(async () => {
  ({ db, client } = await createPgliteDb());
}, 60_000);
afterAll(async () => {
  await client.close();
});

const migration = readFileSync(
  new URL('../migrations/0038_item_cost_not_entered.sql', import.meta.url),
  'utf8',
);
const backfill = migration
  .split('--> statement-breakpoint')
  .map((statement) => statement.replace(/^--.*$/gm, '').trim())
  .filter((statement) => statement.startsWith('UPDATE'));

async function newItem(estCostSatang: number | null) {
  const [category] = await db.insert(menuCategories).values({ nameTh: 'หมวด' }).returning();
  const [row] = await db
    .insert(menuItems)
    .values({
      categoryId: category?.id ?? '',
      nameTh: 'x',
      priceSatang: 5000,
      estCostSatang,
      channels: ['storefront'],
    })
    .returning();
  return row?.id ?? '';
}

describe('menu_items.est_cost_satang', () => {
  test('stores NULL (no cost entered), 0 (a real zero) and a cost as three different things', async () => {
    const none = await newItem(null);
    const zero = await newItem(0);
    const some = await newItem(2200);
    const read = async (id: string) =>
      (await db.select().from(menuItems).where(eq(menuItems.id, id)))[0]?.estCostSatang;
    expect(await read(none)).toBeNull();
    expect(await read(zero)).toBe(0);
    expect(await read(some)).toBe(2200);
  });

  test('the cost check still refuses a negative cost and accepts NULL', async () => {
    await expect(newItem(-1)).rejects.toThrow();
    await expect(newItem(null)).resolves.toBeTruthy();
  });

  test('the backfill turns stored zeros into NULL and leaves real costs alone', async () => {
    expect(backfill).toHaveLength(2);
    const zero = await newItem(0);
    const some = await newItem(2200);
    for (const statement of backfill) await client.exec(statement);
    const read = async (id: string) =>
      (await db.select().from(menuItems).where(eq(menuItems.id, id)))[0]?.estCostSatang;
    expect(await read(zero)).toBeNull();
    expect(await read(some)).toBe(2200);
  });

  test('the backfill also clears the zero cost snapshots on past order lines, not the others', async () => {
    const itemId = await newItem(null);
    const order = await ordersRepo.insertOrder(db, {
      orderNo: 'C-1',
      businessDate: '2031-08-01',
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      roomNo: null,
      deliveryBuilding: 'B1',
      recipientName: 'Test Recipient',
      deliveryNote: null,
      customerId: null,
      status: 'preparing',
      subtotalSatang: 10000,
      discountSatang: 0,
      totalSatang: 10000,
      note: null,
      createdByStaffId: null,
      createdOnDeviceId: null,
      clientRequestId: crypto.randomUUID(),
      requestHash: crypto.randomUUID(),
      placedAt: new Date('2031-08-01T03:00:00Z'),
      acceptedAt: null,
    });
    const base = {
      menuItemId: itemId,
      nameThSnapshot: 'x',
      nameEnSnapshot: null,
      unitPriceSatang: 5000,
      qty: 1,
      modifiers: [],
      note: null,
      lineTotalSatang: 5000,
    };
    const [zero, some] = await ordersRepo.insertOrderItems(db, order?.id ?? '', [
      { ...base, unitCostSatang: 0 },
      { ...base, unitCostSatang: 1200 },
    ]);
    for (const statement of backfill) await client.exec(statement);
    const read = async (id: string) =>
      (await db.select().from(orderItems).where(eq(orderItems.id, id)))[0]?.unitCostSatang;
    expect(await read(zero?.id ?? '')).toBeNull();
    expect(await read(some?.id ?? '')).toBe(1200);
  });
});
