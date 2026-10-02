import { describe, expect, test } from 'vitest';
import { createEntityStore } from '../realtime/entity-store.ts';
import { deliveryFrame, orderDto, uuid } from '../test-support/frames.ts';
import {
  chipLabel,
  deliveryBuildings,
  deliveryLabel,
  deliveryReady,
  recipientChips,
} from './delivery-model.ts';

describe('the label of a delivery', () => {
  test('is the building and the name, with the other details apart', () => {
    const order = orderDto(uuid(1), 1, {
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B1',
      recipientName: 'ฟ้า ตัวอย่าง',
      deliveryNote: 'เสื้อแดง',
    });
    expect(deliveryLabel(order)).toEqual({ headline: 'B1 · ฟ้า ตัวอย่าง', note: 'เสื้อแดง' });
  });

  test('has no note when there are no other details', () => {
    expect(
      deliveryLabel({ deliveryBuilding: 'A2', recipientName: 'Tester', deliveryNote: null }),
    ).toEqual({ headline: 'A2 · Tester', note: null });
    expect(
      deliveryLabel({ deliveryBuilding: 'A2', recipientName: 'Tester', deliveryNote: '' })?.note,
    ).toBeNull();
  });

  test('is null for an order that carries no recipient (a platform or old order)', () => {
    expect(
      deliveryLabel({ deliveryBuilding: null, recipientName: null, deliveryNote: null }),
    ).toBeNull();
  });
});

describe('the recipient chips', () => {
  const saved = (name: string, building = 'B1', note: string | null = null) => ({
    id: uuid(9),
    building,
    recipientName: name,
    deliveryNote: note,
    lastOrderAt: null,
  });

  test('read "building · name" and carry the saved details as a hint', () => {
    expect(chipLabel(saved('Fah'))).toEqual({ label: 'B1 · Fah', hint: null });
    expect(chipLabel(saved('Fah', 'B1', 'ชั้น 3'))).toEqual({ label: 'B1 · Fah', hint: 'ชั้น 3' });
  });

  test('keep the order the server gave', () => {
    const list = [saved('Z'), saved('A')];
    expect(recipientChips(list).map((c) => c.label)).toEqual(['B1 · Z', 'B1 · A']);
  });
});

describe('the buildings on offer', () => {
  test('come from the synced delivery setting', () => {
    const store = createEntityStore();
    expect(deliveryBuildings(store.getState().settings)).toBeNull();
    store.apply(deliveryFrame(5, ['A1', 'Z9']));
    expect(deliveryBuildings(store.getState().settings)).toEqual(['A1', 'Z9']);
  });
});

describe('whether the delivery details are enough to place an order', () => {
  const buildings = ['A1', 'B1'];
  const ok = { building: 'B1', name: 'Fah' };

  test('needs a building from the list and a name', () => {
    expect(deliveryReady(ok, buildings)).toBe(true);
    expect(deliveryReady({ ...ok, building: '' }, buildings)).toBe(false);
    expect(deliveryReady({ ...ok, building: 'C9' }, buildings)).toBe(false);
    expect(deliveryReady({ ...ok, name: '   ' }, buildings)).toBe(false);
  });

  test('a name is at most 60 characters after trimming', () => {
    expect(deliveryReady({ ...ok, name: ` ${'x'.repeat(60)} ` }, buildings)).toBe(true);
    expect(deliveryReady({ ...ok, name: 'x'.repeat(61) }, buildings)).toBe(false);
  });

  test('does not know the list yet: not ready', () => {
    expect(deliveryReady(ok, null)).toBe(false);
  });
});
