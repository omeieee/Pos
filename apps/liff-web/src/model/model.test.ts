import type { CheckoutInfo, MyOrder, PublicMenuResponse } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import {
  addLine,
  estimateTotal,
  groupProblem,
  itemCount,
  missingLines,
  selectionIsValid,
  setQty,
  toOrderItems,
} from './cart.ts';
import { clock, createRequestIds, formProblems, prefilled } from './checkout.ts';
import { nextPollDelayMs } from './poll.ts';

const ids = (n: number) => `0191a8f0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOODLES = ids(1);
const WATER = ids(2);
const THIN = ids(11);
const EGG = ids(12);

const menu = {
  channel: 'line',
  categories: [
    {
      id: ids(100),
      nameTh: 'หมวด',
      nameEn: null,
      items: [
        {
          id: NOODLES,
          nameTh: 'ก๋วยเตี๋ยว',
          nameEn: null,
          descriptionTh: null,
          descriptionEn: null,
          priceSatang: 5000,
          imageUrl: null,
          modifierGroups: [
            {
              id: ids(20),
              nameTh: 'เส้น',
              nameEn: null,
              minSelect: 1,
              maxSelect: 1,
              options: [{ id: THIN, nameTh: 'เล็ก', nameEn: null, priceDeltaSatang: 0 }],
            },
            {
              id: ids(21),
              nameTh: 'เพิ่ม',
              nameEn: null,
              minSelect: 0,
              maxSelect: 2,
              options: [{ id: EGG, nameTh: 'ไข่', nameEn: null, priceDeltaSatang: 500 }],
            },
          ],
        },
        {
          id: WATER,
          nameTh: 'น้ำ',
          nameEn: null,
          descriptionTh: null,
          descriptionEn: null,
          priceSatang: 1000,
          imageUrl: null,
          modifierGroups: [],
        },
      ],
    },
  ],
} as unknown as PublicMenuResponse;

describe('cart', () => {
  test('the same item, options and note merge; options are a set', () => {
    let cart = addLine([], { menuItemId: NOODLES, optionIds: [THIN, EGG], qty: 1 });
    cart = addLine(cart, { menuItemId: NOODLES, optionIds: [EGG, THIN], qty: 2 });
    expect(cart).toHaveLength(1);
    expect(cart[0]?.qty).toBe(3);
    cart = addLine(cart, { menuItemId: NOODLES, optionIds: [THIN], qty: 1 });
    expect(cart).toHaveLength(2);
    cart = addLine(cart, { menuItemId: NOODLES, optionIds: [THIN], qty: 1, note: ' ไม่ผัก ' });
    expect(cart).toHaveLength(3);
    expect(itemCount(cart)).toBe(5);
  });

  test('quantity changes, zero removes, and 99 is the ceiling', () => {
    let cart = addLine([], { menuItemId: WATER, optionIds: [], qty: 1 });
    const key = cart[0]?.key ?? '';
    expect(setQty(cart, key, 5)[0]?.qty).toBe(5);
    expect(setQty(cart, key, 500)[0]?.qty).toBe(99);
    expect(setQty(cart, key, 0)).toEqual([]);
    cart = addLine(cart, { menuItemId: WATER, optionIds: [], qty: 98 });
    expect(cart[0]?.qty).toBe(99);
  });

  test('the estimate is the menu price plus options, times quantity, in satang', () => {
    const cart = addLine(addLine([], { menuItemId: NOODLES, optionIds: [THIN, EGG], qty: 2 }), {
      menuItemId: WATER,
      optionIds: [],
      qty: 1,
    });
    expect(estimateTotal(cart, menu)).toBe(2 * 5500 + 1000);
  });

  test('an item that left the menu counts nothing and is reported', () => {
    const cart = addLine([], { menuItemId: ids(999), optionIds: [], qty: 1 });
    expect(estimateTotal(cart, menu)).toBe(0);
    expect(missingLines(cart, menu)).toHaveLength(1);
  });

  test('group minimum and maximum', () => {
    const noodles = menu.categories[0]?.items[0];
    if (!noodles) throw new Error('fixture');
    const [type, extras] = noodles.modifierGroups;
    if (!type || !extras) throw new Error('fixture');
    expect(groupProblem(type, [])).toBe('too_few');
    expect(groupProblem(type, [THIN])).toBeNull();
    expect(groupProblem(extras, [])).toBeNull();
    expect(selectionIsValid(noodles, [])).toBe(false);
    expect(selectionIsValid(noodles, [THIN, EGG])).toBe(true);
  });

  test('the order lines carry ids and quantities only, never a price', () => {
    const cart = addLine([], { menuItemId: NOODLES, optionIds: [THIN], qty: 2, note: 'เผ็ด' });
    const items = toOrderItems(cart);
    expect(items).toEqual([
      { menuItemId: NOODLES, qty: 2, modifierOptionIds: [THIN], note: 'เผ็ด' },
    ]);
    expect(JSON.stringify(items)).not.toMatch(/price|satang|total/i);
  });
});

const info = (over: Partial<CheckoutInfo> = {}): CheckoutInfo => ({
  delivery: { open: true, window: { openMinute: 780, closeMinute: 1380 } },
  buildings: ['A1', 'B1'],
  methods: ['cash', 'promptpay'],
  lastRecipient: null,
  privacyAcknowledged: true,
  privacyVersion: 'v',
  promptpayConfigured: true,
  ...over,
});

describe('checkout', () => {
  test('the form needs a listed building, a name and a method on offer, and an open shop', () => {
    const ok = { building: 'B1', name: 'ฟ้า', note: '', method: 'cash' as const };
    expect(formProblems(ok, info())).toEqual([]);
    expect(formProblems({ ...ok, building: 'Z9' }, info())).toEqual(['building']);
    expect(formProblems({ ...ok, name: '  ' }, info())).toEqual(['name']);
    expect(formProblems({ ...ok, method: 'gov_copay' }, info())).toEqual(['method']);
    expect(formProblems({ ...ok, method: '' }, info())).toEqual(['method']);
    expect(formProblems(ok, info({ delivery: { open: false, window: null } }))).toEqual(['closed']);
  });

  test('the last recipient is filled in only while its building is still on the list', () => {
    const last = { building: 'B1', recipientName: 'ฟ้า', deliveryNote: 'ชั้น 3' };
    expect(prefilled(info({ lastRecipient: last }))).toMatchObject({
      building: 'B1',
      name: 'ฟ้า',
      note: 'ชั้น 3',
      method: 'promptpay',
    });
    expect(prefilled(info({ lastRecipient: { ...last, building: 'Q7' } }))).toMatchObject({
      building: '',
      name: '',
    });
    expect(prefilled(info({ methods: ['cash'] })).method).toBe('cash');
  });

  test('one request id per content: a retry reuses it, a change makes a new one, a success resets', () => {
    let n = 0;
    const requests = createRequestIds(() => `id-${++n}`);
    expect(requests.forSignature('a')).toBe('id-1');
    expect(requests.forSignature('a')).toBe('id-1');
    expect(requests.forSignature('b')).toBe('id-2');
    requests.reset();
    expect(requests.forSignature('b')).toBe('id-3');
  });

  test('clock formats minutes', () => {
    expect(clock(780)).toBe('13:00');
    expect(clock(1380)).toBe('23:00');
    expect(clock(1440)).toBe('00:00');
  });
});

describe('polling', () => {
  const order = (over: Partial<MyOrder>): MyOrder =>
    ({ status: 'new', paymentStatus: 'unpaid', ...over }) as MyOrder;
  test('quick in the foreground, slow in the background, backing off on failures, stopping when done', () => {
    expect(nextPollDelayMs(order({}), false, 0)).toBe(4000);
    expect(nextPollDelayMs(order({}), true, 0)).toBe(30_000);
    expect(nextPollDelayMs(order({}), false, 2)).toBe(16_000);
    expect(nextPollDelayMs(order({}), false, 20)).toBe(60_000);
    expect(nextPollDelayMs(null, false, 0)).toBe(4000);
    expect(nextPollDelayMs(order({ status: 'cancelled' }), false, 0)).toBeNull();
    expect(
      nextPollDelayMs(order({ status: 'completed', paymentStatus: 'paid' }), false, 0),
    ).toBeNull();
    // finished but not yet paid: still worth watching
    expect(nextPollDelayMs(order({ status: 'completed' }), false, 0)).toBe(4000);
  });
});
