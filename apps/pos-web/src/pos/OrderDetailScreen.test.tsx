// @vitest-environment jsdom
import { catalogs, translator } from '@sds/i18n';
import { type OrderDto, type StaffRole, satang } from '@sds/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { orderDto, orderFrame, uuid } from '../test-support/frames.ts';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { OrderDetailScreen } from './OrderDetailScreen.tsx';

const th = catalogs.th;
const tr = translator('th');
const ID = uuid(900);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-10-15T05:00:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const withItems = (over: Partial<OrderDto> = {}, id = ID) =>
  orderDto(id, 40, {
    orderNo: 'S-007',
    fulfillment: 'room_delivery',
    roomNo: '1204',
    status: 'new',
    paymentStatus: 'unpaid',
    subtotalSatang: satang(6500),
    totalSatang: satang(6500),
    note: 'ไม่เอาถุง',
    items: [
      {
        id: uuid(1),
        menuItemId: uuid(2),
        nameTh: 'ก๋วยเตี๋ยวต้มยำ',
        nameEn: 'Tom yum noodles',
        unitPriceSatang: satang(5000),
        qty: 1,
        modifiers: [
          {
            groupId: uuid(3),
            optionId: uuid(4),
            nameTh: 'ไข่ต้ม',
            nameEn: 'Egg',
            priceDeltaSatang: satang(1000),
          },
        ],
        note: 'แยกน้ำ',
        lineTotalSatang: satang(6000),
      },
      {
        id: uuid(5),
        menuItemId: uuid(6),
        nameTh: 'ชาเย็น',
        nameEn: null,
        unitPriceSatang: satang(500),
        qty: 1,
        modifiers: [],
        note: null,
        lineTotalSatang: satang(500),
      },
    ],
    ...over,
  });

async function setup(
  options: {
    role?: StaffRole;
    order?: OrderDto;
    services?: Parameters<typeof createTestServices>[0];
  } = {},
) {
  const { auth } = await createTestAuth(options.role ?? 'cashier');
  const env = createTestServices({ auth, ...options.services });
  if (options.order) {
    env.entities.apply({
      type: 'order.upserted',
      id: options.order.id,
      rev: options.order.rev,
      data: options.order,
    });
  }
  return env;
}

describe('the order page', () => {
  test('shows the order from the store: the number, the status, the lines and the SERVER total', async () => {
    const { services } = await setup({ order: withItems() });
    renderScreen(<OrderDetailScreen id={ID} />, services);
    expect(screen.getByRole('heading', { name: 'ออเดอร์ S-007' })).toBeTruthy();
    expect(screen.getAllByText(th['status.order.new']).length).toBeGreaterThan(0);
    expect(screen.getByText(th['status.payment.unpaid'])).toBeTruthy();
    expect(screen.getByText(/ก๋วยเตี๋ยวต้มยำ/)).toBeTruthy();
    // The quantity sign comes from the catalog, not from the component.
    expect(screen.getAllByText(tr('order.detail.qty', { count: 1 })).length).toBe(2);
    expect(screen.getByText(/ไข่ต้ม/)).toBeTruthy();
    expect(screen.getByText(/แยกน้ำ/)).toBeTruthy();
    expect(screen.getByText(/ห้อง 1204/)).toBeTruthy();
    expect(screen.getByText(th['order.detail.serverTotal'])).toBeTruthy();
    expect(screen.getAllByText('฿65.00').length).toBeGreaterThan(0);
  });

  test('has a way back to the orders list', async () => {
    const { services } = await setup({ order: withItems() });
    renderScreen(<OrderDetailScreen id={ID} />, services);
    expect(screen.getByRole('link', { name: th['order.detail.back'] }).getAttribute('href')).toBe(
      '#/orders',
    );
  });

  test('follows the store: a newer frame of the same order updates the page', async () => {
    const { services, entities } = await setup({ order: withItems() });
    renderScreen(<OrderDetailScreen id={ID} />, services);
    act(() => {
      entities.apply(
        orderFrame(ID, 41, { orderNo: 'S-007', status: 'preparing', paymentStatus: 'paid' }),
      );
    });
    expect(screen.getAllByText(th['status.order.preparing']).length).toBeGreaterThan(0);
    expect(screen.getAllByText(th['status.payment.paid']).length).toBeGreaterThan(0);
  });

  test('an order that is not in the store is fetched, and put into the store', async () => {
    const { services, entities, getOrder } = await setup({
      services: { getOrder: async () => withItems() },
    });
    renderScreen(<OrderDetailScreen id={ID} />, services);
    expect(screen.getByText(th['order.detail.loading'])).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'ออเดอร์ S-007' })).toBeTruthy());
    expect(getOrder).toHaveBeenCalledWith(ID);
    expect(entities.getState().orders.has(ID)).toBe(true);
  });

  test('a past order that is not in the store also gets its payments over REST (a fresh device has no closed history)', async () => {
    const { services, api } = await setup({
      services: {
        getOrder: async () => withItems({ status: 'completed', paymentStatus: 'paid' }),
        payments: { list: async () => ({ payments: [] }) },
      },
    });
    renderScreen(<OrderDetailScreen id={ID} />, services);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'ออเดอร์ S-007' })).toBeTruthy());
    await waitFor(() => expect(api.payments.list).toHaveBeenCalledWith(ID));
  });

  test('an order that does not exist says so, with a way back', async () => {
    const { services } = await setup({
      services: {
        getOrder: async () => {
          throw new ApiClientError('NOT_FOUND', { status: 404 });
        },
      },
    });
    renderScreen(<OrderDetailScreen id={ID} />, services);
    expect(await screen.findByText(th['order.detail.notFound'])).toBeTruthy();
    expect(
      screen.getByRole('link', { name: th['order.detail.takeAnother'] }).getAttribute('href'),
    ).toBe('#/new');
  });

  test('a malformed id is not looked up: it is simply not found', async () => {
    const { services, getOrder } = await setup();
    renderScreen(<OrderDetailScreen id="not-a-uuid" />, services);
    expect(screen.getByText(th['order.detail.notFound'])).toBeTruthy();
    expect(getOrder).not.toHaveBeenCalled();
  });

  test('a failed load shows our own message and can be retried', async () => {
    let calls = 0;
    const { services } = await setup({
      services: {
        getOrder: async () => {
          calls += 1;
          if (calls === 1) throw new ApiClientError('NETWORK');
          return withItems();
        },
      },
    });
    renderScreen(<OrderDetailScreen id={ID} />, services);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(th['error.network']);
    fireEvent.click(screen.getByRole('button', { name: th['common.retry'] }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'ออเดอร์ S-007' })).toBeTruthy());
  });

  test('shows why a cancelled order was cancelled', async () => {
    const { services } = await setup({
      order: withItems({ status: 'cancelled', cancelReason: 'ลูกค้าเปลี่ยนใจ' }),
    });
    renderScreen(<OrderDetailScreen id={ID} />, services);
    expect(screen.getByText(/ลูกค้าเปลี่ยนใจ/)).toBeTruthy();
  });
});

describe('who sees the payment section', () => {
  test('a cashier does', async () => {
    const env = await setup({ order: withItems({ fulfillment: 'dine_in' }) });
    renderScreen(<OrderDetailScreen id={ID} />, env.services);
    expect(await screen.findByRole('heading', { name: th['payment.title'] })).toBeTruthy();
    expect(env.api.payments.list).toHaveBeenCalledWith(ID);
  });

  test('the kitchen does not, and does not ask for the payments either', async () => {
    const env = await setup({ role: 'kitchen', order: withItems() });
    renderScreen(<OrderDetailScreen id={ID} />, env.services);
    expect(screen.queryByRole('heading', { name: th['payment.title'] })).toBeNull();
    expect(env.api.payments.list).not.toHaveBeenCalled();
  });
});

describe('moving the order along', () => {
  const buttons = () => screen.queryAllByRole('button').map((b) => b.textContent ?? '');
  /** What the server returns after a move: the same order, one revision on. */
  const later = (over: Partial<OrderDto>): OrderDto => ({ ...withItems(over), rev: 41 });
  const moveButton = (name: string) => screen.getByRole('button', { name });

  test('a cashier may accept or cancel a new order', async () => {
    const env = await setup({ order: withItems({ status: 'new' }) });
    renderScreen(<OrderDetailScreen id={ID} />, env.services);
    expect(buttons()).toContain(th['order.move.preparing']);
    expect(buttons()).toContain(th['order.move.cancelled']);
    expect(buttons()).not.toContain(th['order.move.ready']);
  });

  test('a cashier may advance an order in progress but not cancel it; a manager may', async () => {
    const cashier = await setup({ order: withItems({ status: 'preparing' }) });
    renderScreen(<OrderDetailScreen id={ID} />, cashier.services);
    expect(buttons()).toContain(th['order.move.ready']);
    expect(buttons()).not.toContain(th['order.move.cancelled']);
    cleanup();
    const manager = await setup({ role: 'manager', order: withItems({ status: 'preparing' }) });
    renderScreen(<OrderDetailScreen id={ID} />, manager.services);
    expect(buttons()).toContain(th['order.move.cancelled']);
  });

  test('the kitchen may accept and advance but never cancel', async () => {
    const env = await setup({ role: 'kitchen', order: withItems({ status: 'new' }) });
    renderScreen(<OrderDetailScreen id={ID} />, env.services);
    expect(buttons()).toContain(th['order.move.preparing']);
    expect(buttons()).not.toContain(th['order.move.cancelled']);
  });

  test('a finished order has no moves', async () => {
    const env = await setup({ role: 'owner', order: withItems({ status: 'completed' }) });
    renderScreen(<OrderDetailScreen id={ID} />, env.services);
    for (const key of ['preparing', 'ready', 'completed', 'cancelled'] as const) {
      expect(buttons()).not.toContain(th[`order.move.${key}`]);
    }
  });

  test('a move goes through the API with the target status and shows the order the server returns', async () => {
    const env = await setup({
      order: withItems({ status: 'preparing' }),
      services: {
        orders: {
          transition: async () => later({ status: 'ready' }),
        },
      },
    });
    renderScreen(<OrderDetailScreen id={ID} />, env.services);
    fireEvent.click(moveButton(th['order.move.ready']));
    await waitFor(() => expect(env.entities.getState().orders.get(ID)?.status).toBe('ready'));
    expect(env.api.orders.transition).toHaveBeenCalledWith(ID, { to: 'ready' });
    expect(screen.getByRole('button', { name: th['order.move.completed'] })).toBeTruthy();
  });

  test('a double tap sends one request', async () => {
    let answer!: () => void;
    const env = await setup({
      order: withItems({ status: 'preparing' }),
      services: {
        orders: {
          transition: () =>
            new Promise((resolve) => {
              answer = () => resolve(later({ status: 'ready' }));
            }),
        },
      },
    });
    renderScreen(<OrderDetailScreen id={ID} />, env.services);
    const button = moveButton(th['order.move.ready']);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(env.api.orders.transition).toHaveBeenCalledTimes(1);
    await act(async () => answer());
  });

  test('a refusal is explained and the order is unchanged', async () => {
    const env = await setup({
      order: withItems({ status: 'preparing' }),
      services: {
        orders: {
          transition: async () => {
            throw new ApiClientError('INVALID_TRANSITION', { status: 409 });
          },
        },
      },
    });
    renderScreen(<OrderDetailScreen id={ID} />, env.services);
    fireEvent.click(moveButton(th['order.move.ready']));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(th['error.invalidTransition']);
    expect(env.entities.getState().orders.get(ID)?.status).toBe('preparing');
  });
});

describe('a move whose answer was lost', () => {
  const later = (over: Partial<OrderDto>): OrderDto => ({ ...withItems(over), rev: 41 });
  const moveButton = (name: string) => screen.getByRole('button', { name });

  test('the first call had worked: the retry shows no INVALID_TRANSITION, the order is read and shown as moved', async () => {
    const env = await setup({
      order: withItems({ status: 'preparing' }),
      services: {
        orders: {
          transition: async () => {
            throw new ApiClientError('INVALID_TRANSITION', { status: 409 });
          },
          get: async () => later({ status: 'ready' }),
        },
      },
    });
    renderScreen(<OrderDetailScreen id={ID} />, env.services);
    fireEvent.click(moveButton(th['order.move.ready']));
    await waitFor(() => expect(env.entities.getState().orders.get(ID)?.status).toBe('ready'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('nothing arrived: the error is shown and the same tap can be repeated', async () => {
    let calls = 0;
    const env = await setup({
      order: withItems({ status: 'preparing' }),
      services: {
        orders: {
          transition: async () => {
            calls += 1;
            if (calls === 1) throw new ApiClientError('TIMEOUT');
            return { ...later({ status: 'ready' }), rev: 42 };
          },
          get: async () => later({ status: 'preparing' }),
        },
      },
    });
    renderScreen(<OrderDetailScreen id={ID} />, env.services);
    fireEvent.click(moveButton(th['order.move.ready']));
    await screen.findByRole('alert');
    fireEvent.click(moveButton(th['order.move.ready']));
    await waitFor(() => expect(env.entities.getState().orders.get(ID)?.status).toBe('ready'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a move that is on its way gives visible feedback: busy, buttons off', async () => {
    let answer!: () => void;
    const env = await setup({
      order: withItems({ status: 'preparing' }),
      services: {
        orders: {
          transition: () =>
            new Promise((resolve) => {
              answer = () => resolve(later({ status: 'ready' }));
            }),
        },
      },
    });
    renderScreen(<OrderDetailScreen id={ID} />, env.services);
    fireEvent.click(moveButton(th['order.move.ready']));
    const button = moveButton(th['order.move.ready']) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await act(async () => answer());
  });
});

describe('cancelling the order', () => {
  async function cancelling(
    cancel: (reason: string) => Promise<OrderDto>,
    role: StaffRole = 'manager',
  ) {
    const env = await setup({
      role,
      order: withItems({ status: 'preparing' }),
      services: { orders: { cancel: async (_id, input) => cancel(input.reason) } },
    });
    renderScreen(<OrderDetailScreen id={ID} />, env.services);
    fireEvent.click(screen.getByRole('button', { name: th['order.move.cancelled'] }));
    return { env, dialog: screen.getByRole('dialog') };
  }

  test('needs a reason, and sends it to /cancel', async () => {
    const { env, dialog } = await cancelling(async () => ({
      ...withItems({ status: 'cancelled', cancelReason: 'ลูกค้าเปลี่ยนใจ' }),
      rev: 41,
    }));
    const confirm = within(dialog).getByRole('button', {
      name: th['order.cancel.confirm'],
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(th['order.cancel.reason']), {
      target: { value: '  ลูกค้าเปลี่ยนใจ  ' },
    });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(env.entities.getState().orders.get(ID)?.status).toBe('cancelled'));
    expect(env.api.orders.cancel).toHaveBeenCalledWith(ID, { reason: 'ลูกค้าเปลี่ยนใจ' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('"keep it" closes the dialog and sends nothing', async () => {
    const { env, dialog } = await cancelling(async () => withItems());
    fireEvent.click(within(dialog).getByRole('button', { name: th['order.cancel.keep'] }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(env.api.orders.cancel).not.toHaveBeenCalled();
  });

  test('a payment that was claimed or received blocks it, and the screen explains what to do first', async () => {
    const { dialog } = await cancelling(async () => {
      throw new ApiClientError('ORDER_HAS_PAYMENT', { status: 409 });
    });
    fireEvent.change(within(dialog).getByLabelText(th['order.cancel.reason']), {
      target: { value: 'ลูกค้าเปลี่ยนใจ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: th['order.cancel.confirm'] }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain(th['order.cancel.hasPayment']);
    // Still open, with the reason kept, so nothing has to be typed again.
    expect(
      (within(dialog).getByLabelText(th['order.cancel.reason']) as HTMLInputElement).value,
    ).toBe('ลูกค้าเปลี่ยนใจ');
  });

  test('another refusal is shown in our own words', async () => {
    const { dialog } = await cancelling(async () => {
      throw new ApiClientError('FORBIDDEN', { status: 403 });
    });
    fireEvent.change(within(dialog).getByLabelText(th['order.cancel.reason']), {
      target: { value: 'x' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: th['order.cancel.confirm'] }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain(th['error.forbidden']);
  });
});
