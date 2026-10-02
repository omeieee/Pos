// @vitest-environment jsdom
import { catalogs } from '@sds/i18n';
import { satang } from '@sds/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client.ts';
import { ApiClientError } from '../api/errors.ts';
import { govCopayFrame, orderDto, paymentDto, uuid } from '../test-support/frames.ts';
import { MENU, PLATFORM_DISH, seedPlatformDish } from '../test-support/menu-fixtures.ts';
import { fixClock, loaded, ORDER, orderOf, setup } from '../test-support/payment-env.tsx';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { OrderDetailScreen } from './OrderDetailScreen.tsx';
import { OrderEntryScreen } from './OrderEntryScreen.tsx';
import { OrdersScreen } from './OrdersScreen.tsx';
import { OutboxBadge } from './OutboxBadge.tsx';
import { PaymentPanel } from './PaymentPanel.tsx';

const th = catalogs.th;

beforeEach(() => {
  window.location.hash = '#/new';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const click = (element: HTMLElement) => fireEvent.click(element);
const tile = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

type Create = ApiClient['orders']['create'];
type Pay = ApiClient['payments']['create'];

const serverOrder = (orderNo = 'S-021') =>
  orderDto(uuid(900), 500, { orderNo, totalSatang: satang(2500), subtotalSatang: satang(2500) });

const okCreate: Create = async (_input, options) => ({
  order: serverOrder(),
  replay: false,
  clientRequestId: options?.clientRequestId ?? '',
});

async function offlineCounter(options: Parameters<typeof createTestServices>[0] = {}) {
  const { auth } = await createTestAuth();
  const made = createTestServices({ queue: true, offline: true, auth, ...options });
  made.cart.setBuilding('B1');
  made.cart.setRecipientName('Fah ตัวอย่าง');
  return made;
}

async function placeTeaOffline(made: Awaited<ReturnType<typeof offlineCounter>>) {
  renderScreen(<OrderEntryScreen />, made.services);
  await settle();
  click(tile('ชาเย็น'));
  click(screen.getByRole('button', { name: th['pos.orderEntry.placeOffline'] }));
  await waitFor(() => expect(made.outbox.getState().items).toHaveLength(1));
  await settle();
  return made.outbox.getState().items[0];
}

describe('order entry while offline', () => {
  test('says the order is saved on the device, and the same button saves it', async () => {
    const made = await offlineCounter();
    renderScreen(<OrderEntryScreen />, made.services);
    await settle();
    click(tile('ชาเย็น'));
    expect(screen.getByText(th['pos.orderEntry.offlineHint'])).toBeTruthy();
    expect(screen.getByRole('button', { name: th['pos.orderEntry.placeOffline'] })).toBeTruthy();
    expect(made.create).not.toHaveBeenCalled();
  });

  test('saving moves to the order page of the waiting order, with a temporary number', async () => {
    const made = await offlineCounter();
    const item = await placeTeaOffline(made);
    expect(made.create).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(`#/orders/${item?.id}`);
    expect(item).toMatchObject({ kind: 'order', state: 'queued' });
    expect(made.cart.getState().lines).toHaveLength(0);
  });

  test('when the device cannot save it, says so and keeps the order on screen', async () => {
    const made = await offlineCounter({
      localStore: {
        persistent: false,
        kv: {
          get: async () => undefined,
          set: async () => undefined,
          remove: async () => undefined,
        },
        outbox: {
          put: async () => undefined,
          list: async () => [],
          remove: async () => undefined,
          count: async () => 0,
        },
      },
    });
    renderScreen(<OrderEntryScreen />, made.services);
    await settle();
    click(tile('ชาเย็น'));
    click(screen.getByRole('button', { name: th['pos.orderEntry.placeOffline'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.error.storage'])).toBeTruthy());
    expect(made.cart.getState().lines).toHaveLength(1);
    expect(window.location.hash).toBe('#/new');
  });
});

describe('the order that is only on the device', () => {
  test('shows its label, the waiting badge, its lines and an estimate labelled as one', async () => {
    const made = await offlineCounter();
    const item = await placeTeaOffline(made);
    cleanup();
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(item?.label ?? 'x');
    expect(screen.getAllByText(th['outbox.state.waiting']).length).toBeGreaterThan(0);
    expect(screen.getByText('ชาเย็น')).toBeTruthy();
    expect(screen.getByText(th['outbox.order.estimateHint'])).toBeTruthy();
    expect(screen.getByText('B1 · Fah ตัวอย่าง')).toBeTruthy();
    // It never asked the server for an order that does not exist there yet.
    expect(made.getOrder).not.toHaveBeenCalled();
  });

  test('offers cash only: PromptPay and ไทยช่วยไทย are not there, and it says why', async () => {
    const made = await offlineCounter();
    const item = await placeTeaOffline(made);
    cleanup();
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    expect(screen.getByText(th['outbox.onlineOnly'])).toBeTruthy();
    expect(
      screen.queryByRole('radio', { name: new RegExp(th['payment.method.promptpay']) }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: th['payment.cash.exact'] })).toBeTruthy();
  });

  test('cash: the change is the usual calculation, the entry waits behind the order, nothing is shown as paid', async () => {
    const made = await offlineCounter();
    const item = await placeTeaOffline(made);
    cleanup();
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    click(screen.getByRole('button', { name: '฿100' }));
    expect(screen.getAllByText('฿75.00').length).toBeGreaterThan(0);
    click(screen.getByRole('button', { name: th['outbox.cash.confirm'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.cash.waiting'])).toBeTruthy());
    expect(screen.getByText('รับ ฿100.00 · ทอน ฿75.00')).toBeTruthy();
    expect(screen.queryByText(th['payment.paid.title'])).toBeNull();
    const kinds = made.outbox.getState().items.map((i) => [i.kind, i.state]);
    expect(kinds).toEqual([
      ['order', 'queued'],
      ['payment', 'queued'],
    ]);
    expect(made.api.payments.create).not.toHaveBeenCalled();
  });

  test('the cash amount can be corrected before it is sent, and the cashier is told', async () => {
    const made = await offlineCounter();
    const item = await placeTeaOffline(made);
    cleanup();
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    click(screen.getByRole('button', { name: '฿100' }));
    click(screen.getByRole('button', { name: th['outbox.cash.confirm'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.cash.waiting'])).toBeTruthy());
    expect(screen.queryByText(th['outbox.cash.changed'])).toBeNull();

    click(screen.getByRole('button', { name: th['outbox.cash.change'] }));
    const dialog = screen.getByRole('dialog');
    click(within(dialog).getByRole('button', { name: th['payment.cash.exact'] }));
    click(within(dialog).getByRole('button', { name: th['outbox.cash.confirm'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.cash.changed'])).toBeTruthy());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/^รับ ฿25\.00/)).toBeTruthy();
    expect(made.outbox.getState().items.filter((i) => i.kind === 'payment')).toHaveLength(1);
  });

  test('once a send was tried the amount can no longer be corrected', async () => {
    const made = await offlineCounter({
      create: okCreate,
      payments: {
        create: (async () => {
          throw new ApiClientError('NETWORK');
        }) as Pay,
      },
    });
    const item = await placeTeaOffline(made);
    cleanup();
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    click(screen.getByRole('button', { name: '฿100' }));
    click(screen.getByRole('button', { name: th['outbox.cash.confirm'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.cash.waiting'])).toBeTruthy());
    expect(screen.getByRole('button', { name: th['outbox.cash.change'] })).toBeTruthy();
    act(() => made.life.goOnline());
    await waitFor(() => expect(made.api.payments.create).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: th['outbox.cash.change'] })).toBeNull(),
    );
  });

  test('when the connection returns the order and the cash sync once, and the page follows the real order', async () => {
    const calls: string[] = [];
    const made = await offlineCounter({
      create: async (input, options) => {
        calls.push('order');
        return okCreate(input, options);
      },
      payments: {
        create: (async (orderId, _input, options) => {
          calls.push('cash');
          return {
            result: {
              payment: paymentDto(uuid(500), orderId, 600, { amountSatang: satang(2500) }),
              order: serverOrder(),
            },
            replay: false,
            clientRequestId: options?.clientRequestId ?? '',
          };
        }) as Pay,
      },
    });
    const item = await placeTeaOffline(made);
    cleanup();
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    click(screen.getByRole('button', { name: '฿100' }));
    click(screen.getByRole('button', { name: th['outbox.cash.confirm'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.cash.waiting'])).toBeTruthy());

    act(() => made.life.goOnline());
    await waitFor(() => expect(made.outbox.getState().items).toHaveLength(0));
    expect(calls).toEqual(['order', 'cash']);
    expect(made.entities.getState().orders.get(uuid(900))?.orderNo).toBe('S-021');
    expect(window.location.hash).toBe(`#/orders/${uuid(900)}`);
  });
});

describe('the orders list with orders waiting', () => {
  test('lists them with the waiting badge and the temporary number, above the board', async () => {
    const made = await offlineCounter();
    const item = await placeTeaOffline(made);
    cleanup();
    renderScreen(<OrdersScreen />, made.services);
    const section = screen.getByRole('region', { name: new RegExp(th['outbox.section.title']) });
    expect(within(section).getByText(item?.label ?? 'x')).toBeTruthy();
    expect(within(section).getByText(th['outbox.state.waiting'])).toBeTruthy();
    expect(within(section).getByText('B1 · Fah ตัวอย่าง')).toBeTruthy();
    expect(screen.getByText(th['outbox.section.hint'])).toBeTruthy();
  });

  test('a refused entry shows the reason, with send again and remove (after a confirmation)', async () => {
    const made = await offlineCounter({
      create: async () => {
        throw new ApiClientError('ORDER_INVALID', { status: 422 });
      },
    });
    const item = await placeTeaOffline(made);
    act(() => made.life.goOnline());
    await waitFor(() => expect(made.outbox.getState().items[0]?.state).toBe('attention'));
    cleanup();
    renderScreen(<OrdersScreen />, made.services);
    expect(screen.getAllByText(th['outbox.state.attention']).length).toBeGreaterThan(0);
    expect(screen.getByRole('alert').textContent).toContain(th['error.orderInvalid']);
    expect(screen.getByRole('button', { name: th['outbox.retry'] })).toBeTruthy();

    click(screen.getByRole('button', { name: th['outbox.discard'] }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(th['outbox.discard.order'])).toBeTruthy();
    click(within(dialog).getByRole('button', { name: th['outbox.discard.keep'] }));
    expect(made.outbox.getState().items).toHaveLength(1);

    click(screen.getByRole('button', { name: th['outbox.discard'] }));
    click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: th['outbox.discard.confirm'],
      }),
    );
    await waitFor(() => expect(made.outbox.getState().items).toHaveLength(0));
    expect(item?.id).toBeTruthy();
  });

  test('a reused request id can only be removed, not sent again', async () => {
    const made = await offlineCounter({
      create: async () => {
        throw new ApiClientError('IDEMPOTENCY_KEY_REUSED', { status: 409 });
      },
    });
    await placeTeaOffline(made);
    act(() => made.life.goOnline());
    await waitFor(() => expect(made.outbox.getState().items[0]?.state).toBe('attention'));
    cleanup();
    renderScreen(<OrdersScreen />, made.services);
    expect(screen.queryByRole('button', { name: th['outbox.retry'] })).toBeNull();
    expect(screen.getByRole('button', { name: th['outbox.discard'] })).toBeTruthy();
  });

  test('shows only a count for entries of another person', async () => {
    const made = await offlineCounter();
    await placeTeaOffline(made);
    const row = (await made.localStore.outbox.list())[0];
    if (!row) throw new Error('no row');
    await made.localStore.outbox.put({ ...row, id: uuid(77), staffId: uuid(78) });
    // Reopen as the same person: the other row is counted, never shown.
    made.unbindOutbox();
    cleanup();
    const again = createTestServices({ queue: true, offline: true, localStore: made.localStore });
    renderScreen(<OrdersScreen />, again.services);
    await settle();
    expect(screen.getByText(th['outbox.others'].replace('{count}', '1'))).toBeTruthy();
    expect(again.outbox.getState().items).toHaveLength(1);
  });
});

describe('the top bar badge', () => {
  test('shows nothing when nothing waits, then how many wait and how many need attention', async () => {
    const made = await offlineCounter({
      create: async () => {
        throw new ApiClientError('ORDER_INVALID', { status: 422 });
      },
    });
    renderScreen(<OutboxBadge />, made.services);
    expect(screen.queryByRole('link')).toBeNull();
    await placeTeaOffline(made);
    expect(screen.getByText(th['outbox.badge.waiting'].replace('{count}', '1'))).toBeTruthy();
    act(() => made.life.goOnline());
    await waitFor(() =>
      expect(screen.getByText(th['outbox.badge.attention'].replace('{count}', '1'))).toBeTruthy(),
    );
    expect(screen.queryByText(th['outbox.badge.waiting'].replace('{count}', '1'))).toBeNull();
  });
});

describe('paying an order the server has, while offline', () => {
  test('cash stays; PromptPay and ไทยช่วยไทย are disabled with "needs the internet"', async () => {
    // Noon on a day inside the test scheme: co-pay would be on offer if the device were online.
    fixClock();
    const env = await setup({ offline: true, frames: [govCopayFrame(6)] });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    const promptpay = screen.getByRole('radio', {
      name: new RegExp(th['payment.method.promptpay']),
    }) as HTMLInputElement;
    const copay = screen.getByRole('radio', {
      name: new RegExp(th['payment.method.gov_copay']),
    }) as HTMLInputElement;
    expect(promptpay.disabled).toBe(true);
    expect(copay.disabled).toBe(true);
    expect(screen.getAllByText(th['payment.copay.reason.needsInternet']).length).toBe(2);
    expect(screen.getByText(th['outbox.onlineOnly'])).toBeTruthy();
    expect(
      (
        screen.getByRole('radio', {
          name: new RegExp(th['payment.method.cash']),
        }) as HTMLInputElement
      ).disabled,
    ).toBe(false);
  });

  test('cash is queued against the SERVER order and its total, not sent', async () => {
    const env = await setup({ offline: true });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    click(screen.getByRole('button', { name: '฿100' }));
    click(screen.getByRole('button', { name: th['outbox.cash.confirm'] }));
    await waitFor(() => expect(screen.getByText(th['outbox.cash.waiting'])).toBeTruthy());
    expect(env.api.payments.create).not.toHaveBeenCalled();
    expect(env.outbox.getState().items[0]).toMatchObject({
      kind: 'payment',
      orderId: ORDER,
      tenderedSatang: 10000,
      totalSatang: 7500,
    });
    expect(screen.getByText('รับ ฿100.00 · ทอน ฿25.00')).toBeTruthy();
    // The other methods are gone while cash waits, so nothing can collide with it.
    expect(
      screen.queryByRole('radio', { name: new RegExp(th['payment.method.promptpay']) }),
    ).toBeNull();
  });

  test('online, nothing changes: the usual call goes to the server', async () => {
    const env = await setup();
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(
      (
        screen.getByRole('radio', {
          name: new RegExp(th['payment.method.promptpay']),
        }) as HTMLInputElement
      ).disabled,
    ).toBe(false);
    expect(screen.queryByText(th['outbox.onlineOnly'])).toBeNull();
  });
});

describe('a Grab / LINE MAN order', () => {
  async function platformServices(options: Parameters<typeof createTestServices>[0] = {}) {
    const { auth } = await createTestAuth();
    const made = createTestServices({ queue: true, auth, ...options });
    seedPlatformDish(made.entities);
    return made;
  }

  test('shows the platform prices, and changing the platform changes them', async () => {
    const made = await platformServices();
    renderScreen(<OrderEntryScreen mode="platform" />, made.services);
    expect(tile('ชามะนาว').textContent).toContain('฿30');
    click(screen.getByRole('radio', { name: 'LINE MAN' }));
    expect(tile('ชามะนาว').textContent).toContain('฿32');
    // A dish not sold on the platform is not on its menu.
    expect(screen.queryByRole('button', { name: /^ชาเย็น/ })).toBeNull();
  });

  test('has no recipient fields, and needs the platform order code before it can be created', async () => {
    const made = await platformServices();
    renderScreen(<OrderEntryScreen mode="platform" />, made.services);
    click(tile('ชามะนาว'));
    expect(screen.queryByText(th['pos.delivery.building'])).toBeNull();
    const create = screen.getByRole('button', { name: th['platform.place'] }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.getByText(th['platform.refNeeded'])).toBeTruthy();
    fireEvent.change(screen.getByLabelText(th['platform.ref']), { target: { value: 'GF-1234' } });
    expect(create.disabled).toBe(false);
  });

  test('is sent on the platform channel and opens the real order', async () => {
    const made = await platformServices({
      create: async (_input, options) => ({
        order: orderDto(uuid(901), 501, { orderNo: 'G-001', channel: 'grab' }),
        replay: false,
        clientRequestId: options?.clientRequestId ?? '',
      }),
    });
    renderScreen(<OrderEntryScreen mode="platform" />, made.services);
    click(tile('ชามะนาว'));
    fireEvent.change(screen.getByLabelText(th['platform.ref']), { target: { value: 'GF-1234' } });
    click(screen.getByRole('button', { name: th['platform.place'] }));
    await waitFor(() => expect(window.location.hash).toBe(`#/orders/${uuid(901)}`));
    expect(made.create.mock.calls[0]?.[0]).toMatchObject({
      channel: 'grab',
      fulfillment: 'platform_delivery',
      note: 'GRAB GF-1234',
      items: [{ menuItemId: PLATFORM_DISH, qty: 1 }],
    });
  });

  test('keyed in while offline it is queued too, as a platform order with no cash offered', async () => {
    const made = await platformServices({ offline: true });
    renderScreen(<OrderEntryScreen mode="platform" />, made.services);
    await settle();
    click(tile('ชามะนาว'));
    fireEvent.change(screen.getByLabelText(th['platform.ref']), { target: { value: 'GF-9' } });
    click(screen.getByRole('button', { name: th['pos.orderEntry.placeOffline'] }));
    await waitFor(() => expect(made.outbox.getState().items).toHaveLength(1));
    const item = made.outbox.getState().items[0];
    expect(item).toMatchObject({ kind: 'order', channel: 'grab', recipient: null });
    cleanup();
    renderScreen(<OrderDetailScreen id={item?.id ?? ''} />, made.services);
    expect(screen.getByText(th['platform.payment.hint'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: th['payment.cash.exact'] })).toBeNull();
  });

  test('warns when the same platform code was already keyed in', async () => {
    const made = await platformServices();
    made.entities.apply({
      type: 'order.upserted',
      id: uuid(950),
      rev: 600,
      data: orderDto(uuid(950), 600, { channel: 'grab', note: 'GRAB GF-1234' }),
    });
    renderScreen(<OrderEntryScreen mode="platform" />, made.services);
    fireEvent.change(screen.getByLabelText(th['platform.ref']), { target: { value: 'gf-1234' } });
    expect(screen.getByText(th['platform.duplicate'])).toBeTruthy();
  });

  test('its payment is the platform one, and co-pay is not offered', async () => {
    const env = await setup({
      order: orderOf({ channel: 'grab', fulfillment: 'platform_delivery' }),
    });
    renderScreen(<PaymentPanel orderId={ORDER} />, env.services);
    await loaded();
    expect(
      screen.getByRole('radio', { name: new RegExp(th['payment.method.platform']) }),
    ).toBeTruthy();
    expect(screen.queryByRole('radio', { name: new RegExp(th['payment.method.cash']) })).toBeNull();
    expect(
      (
        screen.getByRole('radio', {
          name: new RegExp(th['payment.method.gov_copay']),
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByRole('button', { name: th['payment.start.platform'] })).toBeTruthy();
  });
});

describe('the menu of the counter is untouched by the platform cart', () => {
  test('a dish added on the platform screen is not in the counter order', () => {
    const made = createTestServices({ queue: true });
    seedPlatformDish(made.entities);
    made.platformCart.addItem({ itemId: PLATFORM_DISH });
    expect(made.cart.getState().lines).toHaveLength(0);
    expect(MENU.tea).toBeTruthy();
  });
});
