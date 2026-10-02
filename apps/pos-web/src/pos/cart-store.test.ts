import { describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { createActivity } from '../lib/activity.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import { itemFrame, orderDto, uuid } from '../test-support/frames.ts';
import { MENU, seedMenu } from '../test-support/menu-fixtures.ts';
import { type CartDeps, createCartStore } from './cart-store.ts';

function setup(overrides: Partial<CartDeps> = {}) {
  const entities = createEntityStore();
  seedMenu(entities);
  const activity = createActivity();
  let n = 0;
  const create = vi.fn<CartDeps['api']['orders']['create']>(async (_input, options) => ({
    order: orderDto(uuid(900), 500, { orderNo: 'S-007', totalSatang: 5000 as never }),
    replay: false,
    clientRequestId: options?.clientRequestId ?? '',
  }));
  const cart = createCartStore({
    api: { orders: { create } },
    entities,
    activity,
    newId: () => uuid(1000 + ++n),
    ...overrides,
  });
  return { cart, entities, activity, create };
}

const tomYum = { itemId: MENU.tomYum, optionIds: [MENU.thin, MENU.mild] };

describe('building the order', () => {
  test('adds a dish and merges the same dish with the same choices into one line', () => {
    const { cart } = setup();
    cart.addItem(tomYum);
    cart.addItem({ ...tomYum, optionIds: [MENU.mild, MENU.thin] });
    expect(cart.getState().lines).toHaveLength(1);
    expect(cart.getState().lines[0]?.qty).toBe(2);
  });

  test('different choices or a different note make a separate line', () => {
    const { cart } = setup();
    cart.addItem(tomYum);
    cart.addItem({ itemId: MENU.tomYum, optionIds: [MENU.wide, MENU.mild] });
    cart.addItem({ ...tomYum, note: 'ไม่ใส่ผัก' });
    expect(cart.getState().lines).toHaveLength(3);
  });

  test('quantity changes, and zero removes the line', () => {
    const { cart } = setup();
    const key = cart.addItem({ itemId: MENU.tea });
    cart.setQty(key, 4);
    expect(cart.getState().lines[0]?.qty).toBe(4);
    cart.setQty(key, 0);
    expect(cart.getState().lines).toHaveLength(0);
  });

  test('a line holds at most 99, as the server allows', () => {
    const { cart } = setup();
    const key = cart.addItem({ itemId: MENU.tea, qty: 98 });
    cart.addItem({ itemId: MENU.tea });
    cart.addItem({ itemId: MENU.tea });
    expect(cart.getState().lines[0]?.qty).toBe(99);
    cart.setQty(key, 500);
    expect(cart.getState().lines[0]?.qty).toBe(99);
  });

  test('an order holds at most 50 lines, as the server allows', () => {
    const { cart } = setup();
    for (let i = 0; i < 60; i++) cart.addItem({ itemId: MENU.tea, note: `n${i}` });
    expect(cart.getState().lines).toHaveLength(50);
  });

  test('a line can be edited: choices, note and quantity', () => {
    const { cart } = setup();
    const key = cart.addItem(tomYum);
    cart.updateLine(key, { optionIds: [MENU.wide, MENU.hot], note: 'แยกน้ำ', qty: 2 });
    expect(cart.getState().lines[0]).toMatchObject({
      optionIds: [MENU.wide, MENU.hot],
      note: 'แยกน้ำ',
      qty: 2,
    });
  });

  test('editing a line into another identical line merges them', () => {
    const { cart } = setup();
    cart.addItem(tomYum);
    const second = cart.addItem({ itemId: MENU.tomYum, optionIds: [MENU.wide, MENU.mild] });
    cart.updateLine(second, { optionIds: [MENU.thin, MENU.mild] });
    expect(cart.getState().lines).toHaveLength(1);
    expect(cart.getState().lines[0]?.qty).toBe(2);
  });

  test('remembers the last choices made for a dish, for a one-tap repeat', () => {
    const { cart } = setup();
    expect(cart.lastChoice(MENU.tomYum)).toBeUndefined();
    cart.addItem(tomYum);
    expect(cart.lastChoice(MENU.tomYum)).toEqual([MENU.thin, MENU.mild]);
  });

  test('clear() empties the order and the fields', () => {
    const { cart } = setup();
    cart.addItem(tomYum);
    cart.setNote('ไม่เอาถุง');
    cart.setFulfillment('room_delivery');
    cart.setRoomNo('1204');
    cart.clear();
    expect(cart.getState()).toMatchObject({ lines: [], note: '', roomNo: '', phase: 'editing' });
  });

  test('starts as dine-in', () => {
    expect(setup().cart.getState().fulfillment).toBe('dine_in');
  });
});

describe('submitting', () => {
  test('sends the order without any price, with the request id in body and header position', async () => {
    const { cart, create } = setup();
    cart.addItem({ ...tomYum, qty: 2, note: 'ไม่ใส่ผัก' });
    cart.addItem({ itemId: MENU.tea });
    cart.setFulfillment('takeaway');
    cart.setNote('รีบ');
    const outcome = await cart.submit();
    expect(outcome.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    const [input, options] = create.mock.calls[0] ?? [];
    expect(input).toEqual({
      channel: 'storefront',
      fulfillment: 'takeaway',
      note: 'รีบ',
      items: [
        {
          menuItemId: MENU.tomYum,
          qty: 2,
          modifierOptionIds: [MENU.thin, MENU.mild],
          note: 'ไม่ใส่ผัก',
        },
        { menuItemId: MENU.tea, qty: 1, modifierOptionIds: [] },
      ],
    });
    expect(JSON.stringify(input)).not.toMatch(/price|total|satang/i);
    expect(options?.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('room delivery sends the room number', async () => {
    const { cart, create } = setup();
    cart.addItem({ itemId: MENU.tea });
    cart.setFulfillment('room_delivery');
    cart.setRoomNo(' 1204 ');
    await cart.submit();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      fulfillment: 'room_delivery',
      roomNo: '1204',
    });
  });

  test('other fulfilments never send a room number left over in the field', async () => {
    const { cart, create } = setup();
    cart.addItem({ itemId: MENU.tea });
    cart.setFulfillment('room_delivery');
    cart.setRoomNo('1204');
    cart.setFulfillment('dine_in');
    await cart.submit();
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('roomNo');
  });

  test('success: the order goes into the store, the cart empties, and the order is returned', async () => {
    const { cart, entities } = setup();
    cart.addItem(tomYum);
    const outcome = await cart.submit();
    expect(outcome).toMatchObject({ ok: true, order: { orderNo: 'S-007' } });
    expect(entities.getState().orders.get(uuid(900))?.orderNo).toBe('S-007');
    expect(cart.getState()).toMatchObject({
      lines: [],
      phase: 'editing',
      clientRequestId: null,
      error: null,
    });
  });

  test('a double tap sends ONE request: the second submit is refused at once', async () => {
    let release!: () => void;
    const { cart, create } = setup();
    create.mockImplementationOnce(
      (_input, options) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              order: orderDto(uuid(900), 500),
              replay: false,
              clientRequestId: options?.clientRequestId ?? '',
            });
        }),
    );
    cart.addItem(tomYum);
    const first = cart.submit();
    const second = await cart.submit();
    expect(second).toEqual({ ok: false, reason: 'busy' });
    expect(cart.getState().phase).toBe('sending');
    release();
    expect((await first).ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test('while sending, the order cannot be changed', async () => {
    let release!: () => void;
    const { cart, create } = setup();
    create.mockImplementationOnce(
      (_input, options) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              order: orderDto(uuid(900), 500),
              replay: false,
              clientRequestId: options?.clientRequestId ?? '',
            });
        }),
    );
    const key = cart.addItem(tomYum);
    const sending = cart.submit();
    cart.addItem({ itemId: MENU.tea });
    cart.setQty(key, 9);
    cart.setNote('x');
    expect(cart.getState().lines).toHaveLength(1);
    expect(cart.getState().lines[0]?.qty).toBe(1);
    release();
    await sending;
  });

  test('an empty order is not sent', async () => {
    const { cart, create } = setup();
    expect(await cart.submit()).toEqual({ ok: false, reason: 'empty' });
    expect(create).not.toHaveBeenCalled();
  });

  test('an order that cannot be placed (a required choice is missing) is not sent', async () => {
    const { cart, create } = setup();
    cart.addItem({ itemId: MENU.tomYum, optionIds: [MENU.thin] });
    expect(await cart.submit()).toEqual({ ok: false, reason: 'invalid' });
    expect(create).not.toHaveBeenCalled();
  });

  test('room delivery without a room number is not sent', async () => {
    const { cart, create } = setup();
    cart.addItem({ itemId: MENU.tea });
    cart.setFulfillment('room_delivery');
    cart.setRoomNo('   ');
    expect(await cart.submit()).toEqual({ ok: false, reason: 'roomRequired' });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('when the request fails', () => {
  test('a refusal by the server keeps the order and its lines, and shows the line errors', async () => {
    const { cart, create } = setup();
    const refusal = new ApiClientError('ORDER_INVALID', {
      status: 422,
      lineErrors: [{ code: 'ITEM_UNAVAILABLE', lineIndex: 0 }],
    });
    create.mockRejectedValueOnce(refusal);
    cart.addItem(tomYum);
    const outcome = await cart.submit();
    expect(outcome).toEqual({ ok: false, reason: 'error', error: refusal });
    expect(cart.getState()).toMatchObject({ phase: 'editing', error: refusal });
    expect(cart.getState().lines).toHaveLength(1);
  });

  test('an unanswered request (network, timeout) may have created the order: the same id is retried and the order is locked', async () => {
    const { cart, create } = setup();
    create.mockRejectedValueOnce(new ApiClientError('TIMEOUT'));
    const key = cart.addItem(tomYum);
    await cart.submit();
    const failedId = create.mock.calls[0]?.[1]?.clientRequestId;
    expect(cart.getState().phase).toBe('unsure');
    // Locked: the order must stay exactly as it was sent.
    cart.setQty(key, 5);
    cart.addItem({ itemId: MENU.tea });
    expect(cart.getState().lines).toHaveLength(1);
    expect(cart.getState().lines[0]?.qty).toBe(1);
    // Retrying sends the same request id, so the server cannot create a second order.
    await cart.submit();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[1]?.clientRequestId).toBe(failedId);
    expect(cart.getState().lines).toHaveLength(0);
  });

  test('a garbled answer or a server error is also treated as unsure', async () => {
    for (const error of [
      new ApiClientError('RESPONSE_INVALID', { status: 201 }),
      new ApiClientError('INTERNAL', { status: 500 }),
    ]) {
      const { cart, create } = setup();
      create.mockRejectedValueOnce(error);
      cart.addItem(tomYum);
      await cart.submit();
      expect(cart.getState().phase).toBe('unsure');
    }
  });

  test('after a refusal, changing the order gives the next attempt a new request id', async () => {
    const { cart, create } = setup();
    create.mockRejectedValueOnce(new ApiClientError('ORDER_INVALID', { status: 422 }));
    const key = cart.addItem(tomYum);
    await cart.submit();
    cart.setQty(key, 2);
    expect(cart.getState().error).toBeNull();
    await cart.submit();
    expect(create.mock.calls[1]?.[1]?.clientRequestId).not.toBe(
      create.mock.calls[0]?.[1]?.clientRequestId,
    );
  });

  test('retrying an unsure order ignores a menu that changed meanwhile: same body, same id', async () => {
    const { cart, create, entities } = setup();
    create.mockRejectedValueOnce(new ApiClientError('TIMEOUT'));
    cart.addItem(tomYum);
    await cart.submit();
    const failedId = create.mock.calls[0]?.[1]?.clientRequestId;
    const firstBody = create.mock.calls[0]?.[0];
    // The dish sold out while we waited: a fresh order would be refused, but this one may exist.
    entities.apply(itemFrame(MENU.tomYum, 900, { isAvailable: false }));
    const outcome = await cart.submit();
    expect(outcome.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[1]?.clientRequestId).toBe(failedId);
    expect(create.mock.calls[1]?.[0]).toEqual(firstBody);
  });

  test('a fresh order that is no longer valid is still not sent', async () => {
    const { cart, create, entities } = setup();
    cart.addItem(tomYum);
    entities.apply(itemFrame(MENU.tomYum, 900, { isAvailable: false }));
    expect(await cart.submit()).toEqual({ ok: false, reason: 'invalid' });
    expect(create).not.toHaveBeenCalled();
  });

  test('clearing a locked order discards it and its request id', async () => {
    const { cart, create } = setup();
    create.mockRejectedValueOnce(new ApiClientError('NETWORK'));
    cart.addItem(tomYum);
    await cart.submit();
    cart.clear();
    expect(cart.getState()).toMatchObject({ phase: 'editing', clientRequestId: null, lines: [] });
  });

  test('a new order after success gets its own request id', async () => {
    const { cart, create } = setup();
    cart.addItem(tomYum);
    await cart.submit();
    cart.addItem(tomYum);
    await cart.submit();
    const ids = create.mock.calls.map((c) => c[1]?.clientRequestId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('work a page reload would lose', () => {
  test('the app is busy while the order has lines, and idle when it is empty again', () => {
    const { cart, activity } = setup();
    expect(activity.isBusy()).toBe(false);
    const key = cart.addItem(tomYum);
    expect(activity.isBusy()).toBe(true);
    cart.setQty(key, 0);
    expect(activity.isBusy()).toBe(false);
  });

  test('stays busy while sending and after an unsure failure; idle after success', async () => {
    const { cart, activity, create } = setup();
    create.mockRejectedValueOnce(new ApiClientError('TIMEOUT'));
    cart.addItem(tomYum);
    await cart.submit();
    expect(activity.isBusy()).toBe(true);
    await cart.submit();
    expect(activity.isBusy()).toBe(false);
  });
});

describe('reset (sign-out)', () => {
  test('forgets the order and the remembered choices of the person who left', () => {
    const { cart, activity } = setup();
    cart.addItem(tomYum);
    cart.reset();
    expect(cart.getState().lines).toHaveLength(0);
    expect(cart.lastChoice(MENU.tomYum)).toBeUndefined();
    expect(activity.isBusy()).toBe(false);
  });
});
