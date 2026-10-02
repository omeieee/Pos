import { describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { createActivity } from '../lib/activity.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import { deliveryFrame, itemFrame, orderDto, uuid } from '../test-support/frames.ts';
import { MENU, seedMenu } from '../test-support/menu-fixtures.ts';
import { type CartDeps, createCartStore } from './cart-store.ts';

/** `filled`: the delivery details are already typed (most tests are about something else). */
function setup(overrides: Partial<CartDeps> = {}, filled = true) {
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
  if (filled) {
    cart.setBuilding('B1');
    cart.setRecipientName('Fah ตัวอย่าง');
  }
  return { cart, entities, activity, create };
}

const FAH = {
  id: uuid(700),
  building: 'B1',
  recipientName: 'Fah ตัวอย่าง',
  deliveryNote: 'ชั้น 3',
  lastOrderAt: null,
};

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

  test('clear() empties the order and the fields, the recipient too', () => {
    const { cart } = setup();
    cart.addItem(tomYum);
    cart.setNote('ไม่เอาถุง');
    cart.setDeliveryNote('ชั้น 3');
    cart.clear();
    expect(cart.getState()).toMatchObject({
      lines: [],
      note: '',
      deliveryBuilding: '',
      recipientName: '',
      deliveryNote: '',
      phase: 'editing',
    });
  });

  test('starts with no building and no name: nobody is assumed', () => {
    expect(setup({}, false).cart.getState()).toMatchObject({
      deliveryBuilding: '',
      recipientName: '',
      deliveryNote: '',
    });
  });
});

describe('the recipient', () => {
  test('choosing a saved recipient fills building, name and details, all still editable', () => {
    const { cart } = setup({}, false);
    cart.chooseRecipient(FAH);
    expect(cart.getState()).toMatchObject({
      deliveryBuilding: 'B1',
      recipientName: 'Fah ตัวอย่าง',
      deliveryNote: 'ชั้น 3',
    });
    cart.setDeliveryNote('ชั้น 4');
    expect(cart.getState().deliveryNote).toBe('ชั้น 4');
  });

  test('a saved recipient with no details clears the details field', () => {
    const { cart } = setup({}, false);
    cart.setDeliveryNote('old');
    cart.chooseRecipient({ ...FAH, deliveryNote: null });
    expect(cart.getState().deliveryNote).toBe('');
  });

  test('a saved recipient whose building is no longer offered leaves the building unselected', () => {
    const { cart, entities } = setup({}, false);
    entities.apply(deliveryFrame(900, ['A1', 'A2']));
    cart.chooseRecipient(FAH);
    expect(cart.getState()).toMatchObject({ deliveryBuilding: '', recipientName: 'Fah ตัวอย่าง' });
  });

  test('is not an editing step while the order is locked', async () => {
    const { cart, create } = setup();
    create.mockRejectedValueOnce(new ApiClientError('TIMEOUT'));
    cart.addItem(tomYum);
    await cart.submit();
    cart.chooseRecipient({ ...FAH, building: 'D2', recipientName: 'Other' });
    cart.setBuilding('A1');
    cart.setRecipientName('Someone');
    expect(cart.getState()).toMatchObject({ deliveryBuilding: 'B1', recipientName: 'Fah ตัวอย่าง' });
  });
});

describe('submitting', () => {
  test('sends the order without any price, with the request id in body and header position', async () => {
    const { cart, create } = setup();
    cart.addItem({ ...tomYum, qty: 2, note: 'ไม่ใส่ผัก' });
    cart.addItem({ itemId: MENU.tea });
    cart.setNote('รีบ');
    const outcome = await cart.submit();
    expect(outcome.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    const [input, options] = create.mock.calls[0] ?? [];
    expect(input).toEqual({
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B1',
      recipientName: 'Fah ตัวอย่าง',
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

  test('building, name and details are trimmed; empty details are not sent', async () => {
    const { cart, create } = setup({}, false);
    cart.addItem({ itemId: MENU.tea });
    cart.setBuilding('A2');
    cart.setRecipientName('  Nok  ');
    cart.setDeliveryNote('   ');
    await cart.submit();
    const body = create.mock.calls[0]?.[0];
    expect(body).toMatchObject({ deliveryBuilding: 'A2', recipientName: 'Nok' });
    expect(body).not.toHaveProperty('deliveryNote');
    expect(body).not.toHaveProperty('customerId');
    expect(body).not.toHaveProperty('roomNo');
  });

  test('details are sent trimmed, apart from the kitchen note', async () => {
    const { cart, create } = setup();
    cart.addItem({ itemId: MENU.tea });
    cart.setDeliveryNote(' ชั้น 3 ');
    cart.setNote('ไม่เผ็ด');
    await cart.submit();
    expect(create.mock.calls[0]?.[0]).toMatchObject({ deliveryNote: 'ชั้น 3', note: 'ไม่เผ็ด' });
  });

  describe('the customer id of a chosen recipient', () => {
    async function placeAfter(change: (cart: ReturnType<typeof setup>['cart']) => void) {
      const { cart, create } = setup({}, false);
      cart.addItem({ itemId: MENU.tea });
      cart.chooseRecipient(FAH);
      change(cart);
      await cart.submit();
      return create.mock.calls[0]?.[0];
    }

    test('is sent while building and name are as chosen', async () => {
      expect(await placeAfter(() => {})).toMatchObject({
        customerId: FAH.id,
        deliveryBuilding: 'B1',
        deliveryNote: 'ชั้น 3',
      });
    });

    test('is still sent when only the other details are edited', async () => {
      expect(await placeAfter((c) => c.setDeliveryNote('ชั้น 4'))).toMatchObject({
        customerId: FAH.id,
        deliveryNote: 'ชั้น 4',
      });
    });

    test('is still sent for the same name typed with other case or spacing', async () => {
      expect(await placeAfter((c) => c.setRecipientName('  fah   ตัวอย่าง '))).toMatchObject({
        customerId: FAH.id,
      });
    });

    test('is dropped when the building is edited (the server would rename the customer)', async () => {
      expect(await placeAfter((c) => c.setBuilding('B2'))).not.toHaveProperty('customerId');
    });

    test('is dropped when the name is edited', async () => {
      expect(await placeAfter((c) => c.setRecipientName('Fah Other'))).not.toHaveProperty(
        'customerId',
      );
    });

    test('an unsure retry sends the very same body and id', async () => {
      const { cart, create } = setup({}, false);
      create.mockRejectedValueOnce(new ApiClientError('TIMEOUT'));
      cart.addItem({ itemId: MENU.tea });
      cart.chooseRecipient(FAH);
      await cart.submit();
      await cart.submit();
      expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
      expect(create.mock.calls[1]?.[1]?.clientRequestId).toBe(
        create.mock.calls[0]?.[1]?.clientRequestId,
      );
      expect(create.mock.calls[1]?.[0]).toMatchObject({ customerId: FAH.id });
    });
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

  test('an order without a building or without a name is not sent', async () => {
    const { cart, create } = setup({}, false);
    cart.addItem({ itemId: MENU.tea });
    expect(await cart.submit()).toEqual({ ok: false, reason: 'deliveryRequired' });
    cart.setBuilding('B1');
    cart.setRecipientName('   ');
    expect(await cart.submit()).toEqual({ ok: false, reason: 'deliveryRequired' });
    cart.setRecipientName('x'.repeat(61));
    expect(await cart.submit()).toEqual({ ok: false, reason: 'deliveryRequired' });
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

  test('changing the building, name or details gives the next attempt a new request id', async () => {
    const { cart, create } = setup();
    create.mockRejectedValueOnce(new ApiClientError('ORDER_INVALID', { status: 422 }));
    cart.addItem(tomYum);
    await cart.submit();
    cart.setBuilding('C1');
    await cart.submit();
    expect(create.mock.calls[1]?.[1]?.clientRequestId).not.toBe(
      create.mock.calls[0]?.[1]?.clientRequestId,
    );
  });

  test('after success the recipient is forgotten: the next order is somebody else', async () => {
    const { cart } = setup({}, false);
    cart.addItem(tomYum);
    cart.chooseRecipient(FAH);
    await cart.submit();
    expect(cart.getState()).toMatchObject({
      deliveryBuilding: '',
      recipientName: '',
      deliveryNote: '',
      chosen: null,
    });
  });

  test('a new order after success gets its own request id', async () => {
    const { cart, create } = setup();
    cart.addItem(tomYum);
    await cart.submit();
    // The recipient was cleared with the order: the next one is typed again.
    cart.setBuilding('B1');
    cart.setRecipientName('Fah ตัวอย่าง');
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

  describe('a request that was sent before the person left', () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }
    type Created = Awaited<ReturnType<CartDeps['api']['orders']['create']>>;
    const created = (n: number): Created => ({
      order: orderDto(uuid(900 + n), 500 + n, { orderNo: `S-00${n}` }),
      replay: false,
      clientRequestId: '',
    });

    test('its late success is dropped: the next person gets no order in the store', async () => {
      const first = deferred<Created>();
      const { cart, entities, create } = setup();
      create.mockReturnValueOnce(first.promise);
      cart.addItem(tomYum);
      const pending = cart.submit();
      cart.reset();
      first.resolve(created(1));
      expect(await pending).toEqual({ ok: false, reason: 'stale' });
      expect(entities.getState().orders.size).toBe(0);
      expect(cart.getState().phase).toBe('editing');
    });

    test("its late failure does not lock the next person's cart as unsure", async () => {
      const first = deferred<Created>();
      const { cart, create } = setup();
      create.mockReturnValueOnce(first.promise);
      cart.addItem(tomYum);
      const pending = cart.submit();
      cart.reset();
      cart.addItem({ itemId: MENU.tea });
      first.reject(new ApiClientError('NETWORK'));
      expect(await pending).toEqual({ ok: false, reason: 'stale' });
      expect(cart.getState()).toMatchObject({ phase: 'editing', error: null });
    });

    test("its late answer cannot clear the guard of the next person's own request", async () => {
      const first = deferred<Created>();
      const second = deferred<Created>();
      const { cart, entities, create } = setup();
      create.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      cart.addItem(tomYum);
      const stale = cart.submit();
      cart.reset();
      cart.setBuilding('A1');
      cart.setRecipientName('Next Person');
      cart.addItem({ itemId: MENU.tea });
      const current = cart.submit();
      first.resolve(created(1));
      await stale;
      // The second request is still in flight: a double tap must still be refused.
      expect(await cart.submit()).toEqual({ ok: false, reason: 'busy' });
      expect(cart.getState().phase).toBe('sending');
      second.resolve(created(2));
      expect((await current).ok).toBe(true);
      expect([...entities.getState().orders.keys()]).toEqual([uuid(902)]);
    });
  });
});
