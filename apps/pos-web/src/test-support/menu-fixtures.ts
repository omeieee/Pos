/** A small made-up menu loaded through the same frames the server sends. */

import { satang } from '@sds/shared';
import type { EntityStore } from '../realtime/entity-store.ts';
import { categoryFrame, groupFrame, itemFrame, optionFrame, uuid } from './frames.ts';

export const MENU = {
  catNoodle: uuid(101),
  catDrink: uuid(102),
  catHidden: uuid(103),
  /** ก๋วยเตี๋ยวต้มยำ ฿50: noodle (required 1), spice (required 1), extras (0-3). */
  tomYum: uuid(201),
  /** Sold out. */
  seafood: uuid(202),
  /** Required group whose every option is sold out. */
  boat: uuid(203),
  /** ชาเย็น ฿25, no groups. */
  tea: uuid(204),
  /** In a deactivated category. */
  secret: uuid(205),
  /** Sold on LINE only. */
  lineOnly: uuid(206),
  /** ฿20 on the storefront, ฿25 on LINE. */
  water: uuid(207),
  gNoodle: uuid(301),
  gSpice: uuid(302),
  gExtra: uuid(303),
  gBoat: uuid(304),
  thin: uuid(401),
  wide: uuid(402),
  mild: uuid(403),
  hot: uuid(404),
  egg: uuid(405),
  meatball: uuid(406),
  special: uuid(407),
  boatOpt: uuid(408),
} as const;

export function seedMenu(store: EntityStore): void {
  let rev = 1;
  const next = () => rev++;
  const frames = [
    categoryFrame(MENU.catNoodle, next(), { nameTh: 'ก๋วยเตี๋ยว', nameEn: 'Noodles', sort: 1 }),
    categoryFrame(MENU.catDrink, next(), { nameTh: 'เครื่องดื่ม', nameEn: 'Drinks', sort: 2 }),
    categoryFrame(MENU.catHidden, next(), { nameTh: 'ซ่อน', active: false, sort: 3 }),

    groupFrame(MENU.gNoodle, next(), {
      nameTh: 'เส้น',
      nameEn: 'Noodle',
      minSelect: 1,
      maxSelect: 1,
      sort: 1,
    }),
    optionFrame(MENU.thin, MENU.gNoodle, next(), { nameTh: 'เส้นเล็ก', nameEn: 'Thin', sort: 1 }),
    optionFrame(MENU.wide, MENU.gNoodle, next(), { nameTh: 'เส้นใหญ่', nameEn: 'Wide', sort: 2 }),
    groupFrame(MENU.gSpice, next(), {
      nameTh: 'ความเผ็ด',
      nameEn: 'Spice',
      minSelect: 1,
      maxSelect: 1,
      sort: 2,
    }),
    optionFrame(MENU.mild, MENU.gSpice, next(), { nameTh: 'เผ็ดน้อย', nameEn: 'Mild', sort: 1 }),
    optionFrame(MENU.hot, MENU.gSpice, next(), { nameTh: 'เผ็ดมาก', nameEn: 'Hot', sort: 2 }),
    groupFrame(MENU.gExtra, next(), {
      nameTh: 'เพิ่มเติม',
      nameEn: 'Extras',
      minSelect: 0,
      maxSelect: 2,
      sort: 3,
    }),
    optionFrame(MENU.egg, MENU.gExtra, next(), {
      nameTh: 'ไข่ต้ม',
      nameEn: 'Egg',
      priceDeltaSatang: satang(1000),
      sort: 1,
    }),
    optionFrame(MENU.meatball, MENU.gExtra, next(), {
      nameTh: 'ลูกชิ้น',
      nameEn: 'Meatballs',
      priceDeltaSatang: satang(1500),
      sort: 2,
    }),
    optionFrame(MENU.special, MENU.gExtra, next(), {
      nameTh: 'พิเศษ',
      nameEn: 'Special',
      priceDeltaSatang: satang(1000),
      sort: 3,
    }),
    groupFrame(MENU.gBoat, next(), {
      nameTh: 'น้ำซุป',
      nameEn: 'Broth',
      minSelect: 1,
      maxSelect: 1,
    }),
    optionFrame(MENU.boatOpt, MENU.gBoat, next(), { nameTh: 'เลือดหมู', isAvailable: false }),

    itemFrame(MENU.tomYum, next(), {
      categoryId: MENU.catNoodle,
      nameTh: 'ก๋วยเตี๋ยวต้มยำ',
      nameEn: 'Tom yum noodles',
      priceSatang: satang(5000),
      modifierGroupIds: [MENU.gNoodle, MENU.gSpice, MENU.gExtra],
      sort: 1,
    }),
    itemFrame(MENU.seafood, next(), {
      categoryId: MENU.catNoodle,
      nameTh: 'ต้มยำทะเล',
      nameEn: 'Seafood tom yum',
      priceSatang: satang(7000),
      isAvailable: false,
      sort: 2,
    }),
    itemFrame(MENU.boat, next(), {
      categoryId: MENU.catNoodle,
      nameTh: 'ก๋วยเตี๋ยวเรือ',
      nameEn: 'Boat noodles',
      priceSatang: satang(5500),
      modifierGroupIds: [MENU.gBoat],
      sort: 3,
    }),
    itemFrame(MENU.tea, next(), {
      categoryId: MENU.catDrink,
      nameTh: 'ชาเย็น',
      nameEn: 'Thai iced tea',
      priceSatang: satang(2500),
      sort: 1,
    }),
    itemFrame(MENU.water, next(), {
      categoryId: MENU.catDrink,
      nameTh: 'น้ำเปล่า',
      nameEn: 'Water',
      priceSatang: satang(2000),
      channelPrices: { line: satang(2500) },
      sort: 2,
    }),
    itemFrame(MENU.secret, next(), {
      categoryId: MENU.catHidden,
      nameTh: 'เมนูลับ',
      priceSatang: satang(9900),
    }),
    itemFrame(MENU.lineOnly, next(), {
      categoryId: MENU.catDrink,
      nameTh: 'เฉพาะไลน์',
      priceSatang: satang(3000),
      channels: ['line'],
      sort: 3,
    }),
  ];
  store.applyMany(frames);
}
