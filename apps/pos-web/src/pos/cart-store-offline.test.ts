import { describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { createActivity } from '../lib/activity.ts';
import { createEntityStore } from '../realtime/entity-store.ts';
import { orderDto, uuid } from '../test-support/frames.ts';
import { MENU, PLATFORM_DISH, seedMenu, seedPlatformDish } from '../test-support/menu-fixtures.ts';
import { type CartDeps, createCartStore } from './cart-store.ts';
import type { EnqueueResult } from './outbox-store.ts';

type Outbox = NonNullable<CartDeps['outbox']>;

function setup(
  options: {
    offline?: boolean;
    enqueue?: EnqueueResult;
    mode?: 'storefront' | 'platform';
    create?: CartDeps['api']['orders']['create'];
  } = {},
) {
  const entities = createEntityStore();
  seedMenu(entities);
  seedPlatformDish(entities);
  let n = 0;
  const create = vi.fn<CartDeps['api']['orders']['create']>(
    options.create ??
      (async (_input, request) => ({
        order: orderDto(uuid(900), 500, { orderNo: 'S-007' }),
        replay: false,
        clientRequestId: request?.clientRequestId ?? '',
      })),
  );
  const enqueueOrder = vi.fn<Outbox['enqueueOrder']>(
    async (input) => options.enqueue ?? { ok: true, id: input.clientRequestId, label: 'XK-01' },
  );
  const offlineNow = { value: options.offline ?? false };
  const cart = createCartStore({
    api: { orders: { create } },
    entities,
    activity: createActivity(),
    newId: () => uuid(1000 + ++n),
    outbox: { enqueueOrder, isOffline: () => offlineNow.value },
    ...(options.mode ? { mode: options.mode } : {}),
  });
  return { cart, create, enqueueOrder, entities, offlineNow };
}

function fill(cart: ReturnType<typeof setup>['cart']) {
  cart.setBuilding('B1');
  cart.setRecipientName('Fah ตัวอย่าง');
  cart.addItem({ itemId: MENU.tea });
}

describe('an order placed while the device is offline', () => {
  test('is saved to the outbox without trying the network, and the cart is free again', async () => {
    const { cart, create, enqueueOrder } = setup({ offline: true });
    fill(cart);
    const outcome = await cart.submit();
    expect(create).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: true, queued: { id: uuid(1001), label: 'XK-01' } });
    expect(cart.getState()).toMatchObject({ lines: [], phase: 'editing', clientRequestId: null });
    const saved = enqueueOrder.mock.calls[0]?.[0];
    expect(saved?.clientRequestId).toBe(uuid(1001));
    expect(saved?.body).toMatchObject({
      channel: 'storefront',
      fulfillment: 'entrance_delivery',
      deliveryBuilding: 'B1',
      recipientName: 'Fah ตัวอย่าง',
      items: [{ menuItemId: MENU.tea, qty: 1 }],
    });
    expect(saved?.estimateSatang).toBe(2500);
    expect(saved?.lines[0]).toMatchObject({ qty: 1, name: { th: 'ชาเย็น' } });
  });

  test('is not pretended saved when the device refuses: the order stays on screen, editable', async () => {
    const { cart } = setup({ offline: true, enqueue: { ok: false, reason: 'storage' } });
    fill(cart);
    const outcome = await cart.submit();
    expect(outcome).toEqual({ ok: false, reason: 'notSaved', cause: 'storage' });
    expect(cart.getState()).toMatchObject({ phase: 'editing', saveError: 'storage' });
    expect(cart.getState().lines).toHaveLength(1);
  });

  test('a full queue says so', async () => {
    const { cart } = setup({ offline: true, enqueue: { ok: false, reason: 'full' } });
    fill(cart);
    expect(await cart.submit()).toEqual({ ok: false, reason: 'notSaved', cause: 'full' });
  });

  test('an order that cannot be placed is still not saved', async () => {
    const { cart, enqueueOrder } = setup({ offline: true });
    cart.setBuilding('B1');
    cart.setRecipientName('Fah');
    cart.addItem({ itemId: MENU.seafood });
    expect(await cart.submit()).toEqual({ ok: false, reason: 'invalid' });
    expect(enqueueOrder).not.toHaveBeenCalled();
  });

  test('a second tap while it is being saved saves one', async () => {
    const { cart, enqueueOrder } = setup({ offline: true });
    fill(cart);
    const [a, b] = await Promise.all([cart.submit(), cart.submit()]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(enqueueOrder).toHaveBeenCalledTimes(1);
  });

  test('editing after a failed save keeps the request id: the body did not change', async () => {
    const { cart, enqueueOrder } = setup({
      offline: true,
      enqueue: { ok: false, reason: 'storage' },
    });
    fill(cart);
    await cart.submit();
    await cart.submit();
    expect(enqueueOrder.mock.calls[1]?.[0].clientRequestId).toBe(
      enqueueOrder.mock.calls[0]?.[0].clientRequestId,
    );
  });
});

describe('an order whose request got no answer', () => {
  test('is saved with the same request id and body, so the replay cannot duplicate it', async () => {
    const { cart, create, enqueueOrder } = setup({
      create: async () => {
        throw new ApiClientError('TIMEOUT');
      },
    });
    fill(cart);
    const outcome = await cart.submit();
    expect(outcome).toMatchObject({ ok: true, queued: { label: 'XK-01' } });
    const sent = create.mock.calls[0];
    const saved = enqueueOrder.mock.calls[0]?.[0];
    expect(saved?.clientRequestId).toBe(sent?.[1]?.clientRequestId);
    expect(saved?.body).toEqual(sent?.[0]);
    expect(cart.getState().phase).toBe('editing');
  });

  test('a server fault is saved too (the replay is idempotent)', async () => {
    const { cart } = setup({
      create: async () => {
        throw new ApiClientError('INTERNAL', { status: 502 });
      },
    });
    fill(cart);
    expect(await cart.submit()).toMatchObject({ ok: true, queued: {} });
  });

  test('when it cannot be saved either, the cart stays locked as unsure, as before', async () => {
    const { cart } = setup({
      enqueue: { ok: false, reason: 'storage' },
      create: async () => {
        throw new ApiClientError('NETWORK');
      },
    });
    fill(cart);
    expect(await cart.submit()).toEqual({ ok: false, reason: 'notSaved', cause: 'storage' });
    expect(cart.getState()).toMatchObject({ phase: 'unsure', saveError: 'storage' });
  });

  test('retrying while now offline, and failing to save again, stays locked: it may exist', async () => {
    const { cart, offlineNow, enqueueOrder } = setup({
      enqueue: { ok: false, reason: 'storage' },
      create: async () => {
        throw new ApiClientError('NETWORK');
      },
    });
    fill(cart);
    await cart.submit();
    expect(cart.getState().phase).toBe('unsure');
    offlineNow.value = true;
    await cart.submit();
    expect(cart.getState().phase).toBe('unsure');
    expect(enqueueOrder.mock.calls[1]?.[0].clientRequestId).toBe(
      enqueueOrder.mock.calls[0]?.[0].clientRequestId,
    );
  });

  test('a refusal by the server is not saved: nothing was created and the cart stays editable', async () => {
    const { cart, enqueueOrder } = setup({
      create: async () => {
        throw new ApiClientError('ORDER_INVALID', { status: 422 });
      },
    });
    fill(cart);
    expect(await cart.submit()).toMatchObject({ ok: false, reason: 'error' });
    expect(enqueueOrder).not.toHaveBeenCalled();
    expect(cart.getState().phase).toBe('editing');
  });
});

describe('a platform order', () => {
  test('goes out on the platform channel with its code in the note and no recipient', async () => {
    const { cart, create } = setup({ mode: 'platform' });
    cart.setPlatformRef(' GF-12 ');
    cart.setNote('ไม่เผ็ด');
    cart.addItem({ itemId: PLATFORM_DISH });
    expect(await cart.submit()).toMatchObject({ ok: true });
    const body = create.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      channel: 'grab',
      fulfillment: 'platform_delivery',
      note: 'GRAB GF-12 · ไม่เผ็ด',
    });
    expect(body).not.toHaveProperty('deliveryBuilding');
    expect(body).not.toHaveProperty('recipientName');
    expect(body).not.toHaveProperty('customerId');
  });

  test('LINE MAN is chosen with setChannel, and a changed channel is a new body and a new id', async () => {
    const { cart, create } = setup({ mode: 'platform' });
    cart.setPlatformRef('7788');
    cart.addItem({ itemId: PLATFORM_DISH });
    const before = cart.getState().clientRequestId;
    cart.setChannel('lineman');
    expect(cart.getState().channel).toBe('lineman');
    await cart.submit();
    expect(create.mock.calls[0]?.[0]).toMatchObject({ channel: 'lineman', note: 'LINE MAN 7788' });
    expect(create.mock.calls[0]?.[1]?.clientRequestId).not.toBe(before);
  });

  test('needs the platform order code', async () => {
    const { cart, create } = setup({ mode: 'platform' });
    cart.addItem({ itemId: PLATFORM_DISH });
    expect(await cart.submit()).toEqual({ ok: false, reason: 'refRequired' });
    expect(create).not.toHaveBeenCalled();
  });

  test('a dish that is not on the platform cannot be ordered through it', async () => {
    const { cart, create } = setup({ mode: 'platform' });
    cart.setPlatformRef('GF-1');
    cart.addItem({ itemId: MENU.lineOnly });
    expect(await cart.submit()).toEqual({ ok: false, reason: 'invalid' });
    expect(create).not.toHaveBeenCalled();
  });

  test('is queued like any other order when offline, with the channel in the stored body', async () => {
    const { cart, enqueueOrder } = setup({ mode: 'platform', offline: true });
    cart.setPlatformRef('GF-12');
    cart.addItem({ itemId: PLATFORM_DISH });
    expect(await cart.submit()).toMatchObject({ ok: true, queued: {} });
    expect(enqueueOrder.mock.calls[0]?.[0].body).toMatchObject({
      channel: 'grab',
      fulfillment: 'platform_delivery',
    });
  });

  test('success empties the order and the code; the channel choice stays for the next one', async () => {
    const { cart } = setup({ mode: 'platform' });
    cart.setChannel('lineman');
    cart.setPlatformRef('7788');
    cart.addItem({ itemId: PLATFORM_DISH });
    await cart.submit();
    expect(cart.getState()).toMatchObject({ lines: [], platformRef: '', channel: 'lineman' });
  });

  test('the storefront cart is a separate store: it knows no platform fields', () => {
    const { cart } = setup();
    expect(cart.getState().channel).toBe('storefront');
  });
});
