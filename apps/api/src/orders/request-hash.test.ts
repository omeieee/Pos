import type { CreateOrderInput } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { orderRequestHash } from './request-hash.ts';

const uuid = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

const base: CreateOrderInput = {
  clientRequestId: uuid(1),
  channel: 'storefront',
  fulfillment: 'takeaway',
  note: 'ห่อกลับ',
  items: [
    { menuItemId: uuid(10), qty: 2, modifierOptionIds: [uuid(20), uuid(21)], note: 'ไม่ใส่ผัก' },
    { menuItemId: uuid(11), qty: 1, modifierOptionIds: [] },
  ],
};

const hash = (over: Partial<CreateOrderInput> = {}) => orderRequestHash({ ...base, ...over });

describe('orderRequestHash', () => {
  test('is a SHA-256 hex digest and does not change for the same order', () => {
    expect(hash()).toMatch(/^[0-9a-f]{64}$/);
    expect(hash()).toBe(hash());
  });

  test('ignores the request id itself (that is the key, not the content)', () => {
    expect(hash({ clientRequestId: uuid(99) })).toBe(hash());
  });

  test('treats an option list as a set: the order the ids come in does not matter', () => {
    const swapped = {
      items: [
        { menuItemId: uuid(10), qty: 2, modifierOptionIds: [uuid(21), uuid(20)], note: 'ไม่ใส่ผัก' },
        { menuItemId: uuid(11), qty: 1, modifierOptionIds: [] },
      ],
    };
    expect(hash(swapped)).toBe(hash());
  });

  test('an optional field that is absent and one that is undefined are the same order', () => {
    const items = [{ menuItemId: uuid(11), qty: 1, modifierOptionIds: [] }];
    const without: CreateOrderInput = {
      clientRequestId: uuid(1),
      channel: 'storefront',
      fulfillment: 'takeaway',
      items,
    };
    expect(orderRequestHash({ ...without, note: undefined, roomNo: undefined })).toBe(
      orderRequestHash(without),
    );
  });

  test.each([
    ['the channel', { channel: 'line' as const }],
    ['the fulfilment', { fulfillment: 'pickup' as const }],
    ['the order note', { note: 'อย่างอื่น' }],
    ['the room', { fulfillment: 'room_delivery' as const, roomNo: '1204' }],
    ['the customer', { customerId: uuid(7) }],
    [
      'a quantity',
      {
        items: [
          { menuItemId: uuid(10), qty: 3, modifierOptionIds: [uuid(20), uuid(21)], note: 'ไม่ใส่ผัก' },
          { menuItemId: uuid(11), qty: 1, modifierOptionIds: [] },
        ],
      },
    ],
    [
      'an option',
      {
        items: [
          { menuItemId: uuid(10), qty: 2, modifierOptionIds: [uuid(20)], note: 'ไม่ใส่ผัก' },
          { menuItemId: uuid(11), qty: 1, modifierOptionIds: [] },
        ],
      },
    ],
    [
      'an item note',
      {
        items: [
          { menuItemId: uuid(10), qty: 2, modifierOptionIds: [uuid(20), uuid(21)] },
          { menuItemId: uuid(11), qty: 1, modifierOptionIds: [] },
        ],
      },
    ],
    ['the item order (it is the order on the ticket)', { items: [...base.items].reverse() }],
    [
      'an extra item',
      { items: [...base.items, { menuItemId: uuid(12), qty: 1, modifierOptionIds: [] }] },
    ],
  ])('differs when %s differs', (_label, over) => {
    expect(hash(over as Partial<CreateOrderInput>)).not.toBe(hash());
  });
});
