/**
 * Seed data: a placeholder Thai menu (Q6: the owner edits everything later) and
 * default settings. Idempotent: does nothing if a menu already exists.
 */
import {
  businessDaySettingsSchema,
  DEFAULT_CUTOFF_MINUTES,
  promptpaySettingsSchema,
  SHOP_TIME_ZONE,
  satang,
} from '@sds/shared';
import type { Db } from './client.ts';
import {
  govCopaySchemes,
  menuCategories,
  menuItemChannelPrices,
  menuItemModifierGroups,
  menuItems,
  modifierGroups,
  modifierOptions,
  settings,
} from './schema.ts';

const baht = (n: number) => satang(n * 100);

// Every seeded menu name says it is a sample, so nobody mistakes it for the shop's real menu. The
// owner edits or archives all of it through /v1/menu; names, prices and options are placeholders.
const SAMPLE_TH = ' (ตัวอย่าง)';
const SAMPLE_EN = ' (sample)';
const SAMPLE_NOTE = 'เมนูตัวอย่าง — ชื่อและราคายังไม่ใช่ของจริง แก้ไขหรือลบได้';

/** Initial PromptPay ID: the owner's personal TEST account (01-requirements P3, Q banks). */
const INITIAL_PROMPTPAY = promptpaySettingsSchema.parse({
  idType: 'phone',
  idValue: '0642230924',
});

export async function seed(db: Db): Promise<{ seeded: boolean }> {
  const existing = await db.select({ id: menuCategories.id }).from(menuCategories).limit(1);
  if (existing.length > 0) return { seeded: false };

  await db.transaction(async (tx) => {
    const [noodles, drinks] = await tx
      .insert(menuCategories)
      .values([
        { nameTh: `ก๋วยเตี๋ยว${SAMPLE_TH}`, nameEn: `Noodles${SAMPLE_EN}`, sort: 1 },
        { nameTh: `เครื่องดื่ม${SAMPLE_TH}`, nameEn: `Drinks${SAMPLE_EN}`, sort: 2 },
      ])
      .returning();
    if (!noodles || !drinks) throw new Error('seed: categories not created');

    const noodleItems = await tx
      .insert(menuItems)
      .values(
        [
          { nameTh: 'ก๋วยเตี๋ยวต้มยำ', nameEn: 'Tom yum noodles', price: 50, cost: 22 },
          { nameTh: 'ก๋วยเตี๋ยวน้ำใส', nameEn: 'Clear soup noodles', price: 45, cost: 20 },
          { nameTh: 'เย็นตาโฟ', nameEn: 'Yen ta fo', price: 50, cost: 22 },
          { nameTh: 'ก๋วยเตี๋ยวเรือ', nameEn: 'Boat noodles', price: 45, cost: 20 },
        ].map((i, n) => ({
          categoryId: noodles.id,
          nameTh: `${i.nameTh}${SAMPLE_TH}`,
          nameEn: `${i.nameEn}${SAMPLE_EN}`,
          descriptionTh: SAMPLE_NOTE,
          priceSatang: baht(i.price),
          estCostSatang: baht(i.cost),
          channels: ['storefront', 'line', 'grab', 'lineman'],
          sort: n + 1,
        })),
      )
      .returning();

    // A Grab price above the counter price (platform commission), as a worked example.
    const tomYum = noodleItems[0];
    if (!tomYum) throw new Error('seed: noodle items not created');
    await tx
      .insert(menuItemChannelPrices)
      .values({ itemId: tomYum.id, channel: 'grab', priceSatang: baht(65) });

    await tx.insert(menuItems).values(
      [
        { nameTh: 'น้ำเปล่า', nameEn: 'Water', price: 10, cost: 4 },
        { nameTh: 'ชาเย็น', nameEn: 'Thai iced tea', price: 25, cost: 9 },
      ].map((i, n) => ({
        categoryId: drinks.id,
        nameTh: `${i.nameTh}${SAMPLE_TH}`,
        nameEn: `${i.nameEn}${SAMPLE_EN}`,
        descriptionTh: SAMPLE_NOTE,
        priceSatang: baht(i.price),
        estCostSatang: baht(i.cost),
        sort: n + 1,
      })),
    );

    const [noodleType, spice, extras] = await tx
      .insert(modifierGroups)
      .values([
        { nameTh: 'เส้น', nameEn: 'Noodle', minSelect: 1, maxSelect: 1, sort: 1 },
        { nameTh: 'ความเผ็ด', nameEn: 'Spice', minSelect: 0, maxSelect: 1, sort: 2 },
        { nameTh: 'เพิ่มพิเศษ', nameEn: 'Extras', minSelect: 0, maxSelect: 3, sort: 3 },
      ])
      .returning();
    if (!noodleType || !spice || !extras) throw new Error('seed: modifier groups not created');

    const option = (groupId: string, nameTh: string, nameEn: string, price = 0, cost = 0) => ({
      groupId,
      nameTh,
      nameEn,
      priceDeltaSatang: baht(price),
      costDeltaSatang: baht(cost),
    });
    await tx
      .insert(modifierOptions)
      .values(
        [
          option(noodleType.id, 'เส้นเล็ก', 'Thin rice noodle'),
          option(noodleType.id, 'เส้นใหญ่', 'Wide rice noodle'),
          option(noodleType.id, 'เส้นหมี่', 'Vermicelli'),
          option(noodleType.id, 'บะหมี่', 'Egg noodle'),
          option(noodleType.id, 'วุ้นเส้น', 'Glass noodle'),
          option(spice.id, 'ไม่เผ็ด', 'Not spicy'),
          option(spice.id, 'เผ็ดน้อย', 'Mild'),
          option(spice.id, 'เผ็ดกลาง', 'Medium'),
          option(spice.id, 'เผ็ดมาก', 'Hot'),
          option(extras.id, 'พิเศษ', 'Large', 10, 5),
          option(extras.id, 'ไข่', 'Egg', 5, 3),
          option(extras.id, 'ลูกชิ้นเพิ่ม', 'Extra meatballs', 10, 5),
        ].map((o, n) => ({ ...o, sort: n + 1 })),
      );

    await tx.insert(menuItemModifierGroups).values(
      noodleItems.flatMap((item) =>
        [noodleType, spice, extras].map((g, n) => ({
          itemId: item.id,
          groupId: g.id,
          sort: n + 1,
        })),
      ),
    );

    await tx
      .insert(settings)
      .values([
        { key: 'shop', value: { nameTh: 'แซ่บโดนเส้น', nameEn: 'Saap Don Sen' } },
        { key: 'promptpay', value: INITIAL_PROMPTPAY },
        {
          key: 'business_day',
          value: businessDaySettingsSchema.parse({
            cutoffMinutes: DEFAULT_CUTOFF_MINUTES,
            timeZone: SHOP_TIME_ZONE,
          }),
        },
        {
          // A3: storefront 11:00–23:00, delivery 13:00–23:00 (minutes from midnight), adjustable.
          key: 'opening_hours',
          value: {
            storefront: { openMinute: 660, closeMinute: 1380 },
            delivery: { openMinute: 780, closeMinute: 1380 },
            overrides: [],
          },
        },
        { key: 'line_policy', value: { push: 'ready-only', warnAtPercent: 80 } },
      ])
      .onConflictDoNothing();

    // 04 §3.1: additional round. Disabled until the owner confirms ถุงเงิน participation (Q3).
    await tx
      .insert(govCopaySchemes)
      .values({
        code: 'thai_chuay_thai_plus_2026_r2',
        nameTh: 'ไทยช่วยไทย พลัส 60/40',
        nameEn: 'Thai Chuay Thai Plus 60/40',
        govShareBp: 6000,
        govDailyCapSatang: baht(200),
        govTotalCapSatang: baht(1000),
        activeFrom: '2026-10-01',
        activeTo: '2026-11-30',
        activeFromMinute: 360,
        activeToMinute: 1380,
        channels: ['storefront'],
        settlementNote: 'Customer 40% next day 02:00, government 60% next day 17:30 (Krungthai)',
        enabled: false,
      })
      .onConflictDoNothing();
  });

  return { seeded: true };
}
