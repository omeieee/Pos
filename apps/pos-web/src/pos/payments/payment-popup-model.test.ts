import { describe, expect, test } from 'vitest';
import { itemDto, orderDto, uuid } from '../../test-support/frames.ts';
import {
  buildPopupContent,
  dismissFirst,
  enqueue,
  MAX_QUEUED,
  type PopupEntry,
} from './payment-popup-model.ts';

const entry = (n: number, kind: PopupEntry['kind'] = 'paid'): PopupEntry => ({
  orderId: uuid(n),
  orderNo: `L-${String(n).padStart(3, '0')}`,
  kind,
});

describe('the pop-up queue', () => {
  test('keeps the order alerts came in, and the shown one is the first', () => {
    const queue = enqueue(enqueue(enqueue([], entry(1)), entry(2)), entry(3, 'slip_review'));
    expect(queue.map((e) => e.orderNo)).toEqual(['L-001', 'L-002', 'L-003']);
    expect(dismissFirst(queue).map((e) => e.orderNo)).toEqual(['L-002', 'L-003']);
  });

  test('the same order and kind twice is one pop-up; another kind for the same order is its own', () => {
    const once = enqueue([], entry(1));
    expect(enqueue(once, entry(1))).toHaveLength(1);
    expect(enqueue(once, entry(1, 'slip_review'))).toHaveLength(2);
  });

  test('does not change its input, and dismissing an empty queue is empty', () => {
    const queue = [entry(1)];
    enqueue(queue, entry(2));
    dismissFirst(queue);
    expect(queue).toHaveLength(1);
    expect(dismissFirst([])).toEqual([]);
  });

  test('a runaway is capped, keeping the one on screen and the newest', () => {
    let queue: PopupEntry[] = [];
    for (let n = 1; n <= MAX_QUEUED + 5; n += 1) queue = enqueue(queue, entry(n));
    expect(queue).toHaveLength(MAX_QUEUED);
    expect(queue[0]?.orderNo).toBe('L-001');
    expect(queue[queue.length - 1]?.orderNo).toBe(`L-0${MAX_QUEUED + 5}`);
  });
});

describe('what a pop-up says', () => {
  const dish = uuid(100);
  const order = orderDto(uuid(1), 1, {
    orderNo: 'L-001',
    channel: 'line',
    roomNo: '1204',
    note: 'ไม่เผ็ด',
    deliveryNote: 'ชั้น 5',
    recipientName: ' Pim ',
    deliveryBuilding: 'D1',
    totalSatang: 6200 as never,
    line: { displayName: 'พิม', pictureUrl: 'https://profile.line-scdn.net/x' },
    member: {
      fullName: 'Pim Example',
      nickname: null,
      building: null,
      phone: '0812345678',
    } as never,
    items: [
      {
        id: uuid(200),
        menuItemId: dish,
        nameTh: 'ต้มยำ',
        nameEn: 'Tom yum',
        unitPriceSatang: 5000 as never,
        qty: 2,
        modifiers: [],
        note: 'ไม่ใส่ผักชี',
        lineTotalSatang: 10000 as never,
      },
    ],
  });
  const items = new Map([[dish, itemDto(dish, 1, { photoVersion: 3 })]]);

  test('has the LINE who, the web-order name, the building, the dishes with photos and the total', () => {
    const content = buildPopupContent(entry(1), order, items, true);
    expect(content).toMatchObject({
      kind: 'paid',
      orderNo: 'L-001',
      loaded: true,
      line: { displayName: 'พิม', pictureUrl: 'https://profile.line-scdn.net/x' },
      recipientName: 'Pim',
      deliveryBuilding: 'D1',
      totalSatang: 6200,
    });
    expect(content.dishes).toEqual([
      {
        id: uuid(200),
        qty: 2,
        nameTh: 'ต้มยำ',
        nameEn: 'Tom yum',
        photoPath: `/v1/menu/items/${dish}/photo?v=3`,
      },
    ]);
  });

  test('never carries a phone number, a room or a note', () => {
    const text = JSON.stringify(buildPopupContent(entry(1), order, items, true));
    for (const secret of ['0812345678', '1204', 'ไม่เผ็ด', 'ชั้น 5', 'ไม่ใส่ผักชี']) {
      expect(text).not.toContain(secret);
    }
  });

  test('a dish that left the menu has no photo; no total for a role without money', () => {
    const content = buildPopupContent(entry(1), order, new Map(), false);
    expect(content.dishes[0]?.photoPath).toBeNull();
    expect(content.totalSatang).toBeNull();
  });

  test('an order not in the store yet shows only its number, with the kind of the alert', () => {
    const content = buildPopupContent(entry(7, 'slip_review'), undefined, items, true);
    expect(content).toMatchObject({
      kind: 'slip_review',
      orderNo: 'L-007',
      loaded: false,
      line: null,
      dishes: [],
      totalSatang: null,
    });
  });

  test('blank names and no LINE data become nothing', () => {
    const bare = orderDto(uuid(2), 2, {
      recipientName: '  ',
      deliveryBuilding: null,
      line: { displayName: ' ', pictureUrl: null },
    });
    const content = buildPopupContent(entry(2), bare, items, true);
    expect(content).toMatchObject({ line: null, recipientName: null, deliveryBuilding: null });
  });
});
