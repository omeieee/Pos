import { createHash } from 'node:crypto';
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

  test('an order without a recipient hashes exactly as it did before recipients existed', () => {
    // Orders saved earlier carry this fingerprint: a retry after an upgrade must still match it.
    const canonical = JSON.stringify({
      channel: 'storefront',
      fulfillment: 'takeaway',
      roomNo: null,
      customerId: null,
      note: 'ห่อกลับ',
      items: base.items.map((item) => ({
        menuItemId: item.menuItemId,
        qty: item.qty,
        modifierOptionIds: [...item.modifierOptionIds].sort(),
        note: item.note ?? null,
      })),
    });
    expect(hash()).toBe(createHash('sha256').update(canonical).digest('hex'));
  });

  describe('an entrance delivery', () => {
    const entrance: Partial<CreateOrderInput> = {
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B1',
      recipientName: 'Test Recipient',
    };

    test('is the same order when only an empty note is added', () => {
      expect(hash({ ...entrance, deliveryNote: '' })).toBe(hash(entrance));
    });

    test.each([
      ['the building', { deliveryBuilding: 'B2' }],
      ['the name', { recipientName: 'Other Recipient' }],
      ['the note', { deliveryNote: 'ชั้น 3' }],
    ])('differs when %s differs', (_label, change) => {
      expect(hash({ ...entrance, ...change })).not.toBe(hash(entrance));
    });

    test('differs from the same order without a recipient', () => {
      expect(hash(entrance)).not.toBe(hash({ fulfillment: 'entrance_delivery' }));
    });
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

describe('orderRequestHash and the member form', () => {
  test('an order sent without a form keeps the fingerprint it was saved with', () => {
    expect(orderRequestHash(base, undefined)).toBe(hash());
  });

  test('the form is part of the request: another value, or a cleared field, is another fingerprint', () => {
    const form = { fullName: 'ทดสอบ', phone: '0812345678' };
    expect(orderRequestHash(base, form)).not.toBe(hash());
    expect(orderRequestHash(base, form)).toBe(orderRequestHash(base, { ...form }));
    expect(orderRequestHash(base, { ...form, phone: '0898765432' })).not.toBe(
      orderRequestHash(base, form),
    );
    // Leaving a field out (keep) is not the same as clearing it (null).
    expect(orderRequestHash(base, { fullName: 'ทดสอบ', phone: null })).not.toBe(
      orderRequestHash(base, { fullName: 'ทดสอบ' }),
    );
  });
});
