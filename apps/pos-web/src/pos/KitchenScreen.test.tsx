// @vitest-environment jsdom
import { catalogs, translator } from '@sds/i18n';
import { type OrderDto, type StaffRole, satang } from '@sds/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { orderDto, orderFrame, uuid } from '../test-support/frames.ts';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { KitchenScreen } from './KitchenScreen.tsx';

const th = catalogs.th;
const tr = translator('th');

const NOW = Date.parse('2030-01-01T05:30:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const dish = (
  n: number,
  over: Partial<OrderDto['items'][number]> = {},
): OrderDto['items'][number] => ({
  id: uuid(100 + n),
  menuItemId: uuid(200 + n),
  nameTh: 'ก๋วยเตี๋ยวต้มยำ',
  nameEn: 'Tom yum noodles',
  unitPriceSatang: satang(5000),
  qty: 2,
  modifiers: [
    {
      groupId: uuid(300),
      optionId: uuid(301),
      nameTh: 'เส้นเล็ก',
      nameEn: 'Thin',
      priceDeltaSatang: satang(1000),
    },
    {
      groupId: uuid(302),
      optionId: uuid(303),
      nameTh: 'เผ็ดมาก',
      nameEn: 'Hot',
      priceDeltaSatang: satang(0),
    },
  ],
  note: 'ไม่ใส่ถั่วงอก',
  lineTotalSatang: satang(12345),
  ...over,
});

const ticket = (n: number, over: Partial<OrderDto> = {}): OrderDto =>
  orderDto(uuid(n), n, {
    orderNo: `L-${String(n).padStart(3, '0')}`,
    channel: 'line',
    status: 'new',
    placedAt: ago(3),
    items: [dish(n)],
    subtotalSatang: satang(12345),
    totalSatang: satang(12345),
    ...over,
  });

async function setup(
  options: {
    role?: StaffRole;
    orders?: OrderDto[];
    services?: Parameters<typeof createTestServices>[0];
  } = {},
) {
  const { auth } = await createTestAuth(options.role ?? 'kitchen');
  const orders = options.orders ?? [];
  const env = createTestServices({
    auth,
    ...options.services,
    orders: {
      list: async () => ({ day: '2030-01-01', orders }),
      get: async (id) => orders.find((o) => o.id === id) ?? ticket(1),
      ...options.services?.orders,
    },
  });
  return { ...env, orders };
}

const ticketOf = (orderNo: string) => {
  const el = screen.getByText(orderNo, { selector: '.kcard__no' }).closest('.kcard');
  if (!el) throw new Error(`no ticket ${orderNo}`);
  return el as HTMLElement;
};
const orderNos = () =>
  [...document.querySelectorAll('.ktickets .kcard__no')].map((el) => el.textContent);

async function mount(options: Parameters<typeof setup>[0] = {}) {
  const env = await setup(options);
  const view = renderScreen(<KitchenScreen />, env.services);
  await waitFor(() => expect(env.api.orders.list).toHaveBeenCalled());
  return { ...env, view };
}

describe('the tickets', () => {
  test('are the new and preparing orders, oldest first, with the channel letter and the number', async () => {
    await mount({
      orders: [
        ticket(1, {
          status: 'preparing',
          placedAt: ago(5),
          channel: 'storefront',
          orderNo: 'S-001',
        }),
        ticket(2, { status: 'new', placedAt: ago(12), orderNo: 'L-002' }),
        ticket(3, { status: 'new', placedAt: ago(1), channel: 'grab', orderNo: 'G-003' }),
        ticket(4, { status: 'completed', orderNo: 'S-004' }),
        ticket(5, { status: 'cancelled', orderNo: 'S-005' }),
      ],
    });
    await waitFor(() => expect(orderNos()).toEqual(['L-002', 'S-001', 'G-003']));
    const letters = [...document.querySelectorAll('.ktickets .ochannel')].map((e) => e.textContent);
    expect(letters).toEqual(['L', 'S', 'G']);
    // The channel is also in words, for a screen reader.
    expect(within(ticketOf('L-002')).getByText(th['orders.channel.line'])).toBeTruthy();
  });

  test('show every dish with its quantity, its choices and its note, and the note of the order', async () => {
    await mount({ orders: [ticket(1, { note: 'ห่อกลับ ใส่ถุงสองใบ' })] });
    const card = await waitFor(() => ticketOf('L-001'));
    expect(within(card).getByText(tr('order.detail.qty', { count: 2 }))).toBeTruthy();
    expect(within(card).getByText('ก๋วยเตี๋ยวต้มยำ')).toBeTruthy();
    expect(within(card).getByText(/เส้นเล็ก/)).toBeTruthy();
    expect(within(card).getByText(/เผ็ดมาก/)).toBeTruthy();
    expect(within(card).getByText('ไม่ใส่ถั่วงอก')).toBeTruthy();
    expect(within(card).getByText(/ห่อกลับ ใส่ถุงสองใบ/)).toBeTruthy();
  });

  test('show where it goes: the way it is served, and the room for a delivery', async () => {
    await mount({
      orders: [
        ticket(1, { fulfillment: 'room_delivery', roomNo: '1204' }),
        ticket(2, { fulfillment: 'takeaway', placedAt: ago(2) }),
      ],
    });
    const room = await waitFor(() => ticketOf('L-001'));
    expect(within(room).getByText(th['pos.orderEntry.fulfilment.room_delivery'])).toBeTruthy();
    expect(within(room).getByText(tr('order.detail.room', { room: '1204' }))).toBeTruthy();
    expect(
      within(ticketOf('L-002')).getByText(th['pos.orderEntry.fulfilment.takeaway']),
    ).toBeTruthy();
  });

  test('show the payment as information only: unpaid, awaiting confirmation, paid', async () => {
    await mount({
      orders: [
        ticket(1, { paymentStatus: 'unpaid', placedAt: ago(9) }),
        ticket(2, { paymentStatus: 'awaiting_confirmation', placedAt: ago(8) }),
        ticket(3, { paymentStatus: 'paid', placedAt: ago(7) }),
      ],
    });
    await waitFor(() => ticketOf('L-001'));
    expect(within(ticketOf('L-001')).getByText(th['status.payment.unpaid'])).toBeTruthy();
    expect(
      within(ticketOf('L-002')).getByText(th['status.payment.awaiting_confirmation']),
    ).toBeTruthy();
    expect(within(ticketOf('L-003')).getByText(th['status.payment.paid'])).toBeTruthy();
    // No payment action anywhere on the screen.
    for (const label of [
      th['payment.confirm'],
      th['payment.confirmHint'],
      th['payment.start.promptpay'],
      th['payment.void.button'],
    ]) {
      expect(screen.queryByRole('button', { name: new RegExp(label) })).toBeNull();
    }
  });

  test('never show a price, a total or any money', async () => {
    const { view } = await mount({
      orders: [ticket(1), ticket(2, { status: 'ready', readyAt: ago(1) })],
    });
    await waitFor(() => ticketOf('L-001'));
    fireEvent.click(screen.getByRole('button', { name: /พร้อมรับ รอส่งมอบ/ }));
    const text = view.container.textContent ?? '';
    expect(text).not.toContain('฿');
    expect(text).not.toContain('123.45');
    expect(text).not.toContain('50.00');
  });

  test('show how long each has waited, with a word as well as a colour when it is long', async () => {
    await mount({
      orders: [
        ticket(1, { placedAt: ago(4) }),
        ticket(2, { placedAt: ago(12) }),
        ticket(3, { placedAt: ago(25) }),
      ],
    });
    await waitFor(() => ticketOf('L-001'));
    expect(ticketOf('L-001').className).toContain('kcard--ok');
    expect(ticketOf('L-002').className).toContain('kcard--warn');
    expect(ticketOf('L-003').className).toContain('kcard--late');
    expect(within(ticketOf('L-001')).queryByText(th['kitchen.level.warn'])).toBeNull();
    expect(within(ticketOf('L-002')).getByText(th['kitchen.level.warn'])).toBeTruthy();
    expect(within(ticketOf('L-003')).getByText(th['kitchen.level.late'])).toBeTruthy();
    expect(within(ticketOf('L-003')).getByText(/25 นาที/)).toBeTruthy();
  });

  test('English shows the English names', async () => {
    const env = await setup({ orders: [ticket(1)] });
    renderScreen(<KitchenScreen />, env.services, 'en');
    const card = await waitFor(() => ticketOf('L-001'));
    expect(within(card).getByText('Tom yum noodles')).toBeTruthy();
    expect(within(card).getByText(/Thin/)).toBeTruthy();
  });

  test('say so when there is nothing to make', async () => {
    await mount({ orders: [] });
    await screen.findByText(th['kitchen.empty']);
  });
});

describe('live updates', () => {
  test('a new order appears without a reload, and a finished one leaves', async () => {
    const env = await mount({ orders: [ticket(1)] });
    await waitFor(() => ticketOf('L-001'));
    act(() => {
      env.entities.apply(
        orderFrame(uuid(7), 70, {
          orderNo: 'L-007',
          status: 'new',
          placedAt: ago(0),
          items: [dish(7)],
        }),
      );
    });
    expect(ticketOf('L-007')).toBeTruthy();
    act(() => {
      env.entities.apply(
        orderFrame(uuid(1), 80, { orderNo: 'L-001', status: 'completed', items: [dish(1)] }),
      );
    });
    expect(orderNos()).toEqual(['L-007']);
  });

  test('an order that another device started moves on by itself', async () => {
    const env = await mount({ orders: [ticket(1)] });
    await waitFor(() => ticketOf('L-001'));
    expect(
      within(ticketOf('L-001')).getByRole('button', { name: th['order.move.preparing'] }),
    ).toBeTruthy();
    act(() => {
      env.entities.apply(
        orderFrame(uuid(1), 80, { orderNo: 'L-001', status: 'preparing', items: [dish(1)] }),
      );
    });
    expect(
      within(ticketOf('L-001')).getByRole('button', { name: th['order.move.ready'] }),
    ).toBeTruthy();
  });

  test('the list is fetched when the screen opens, and a failure says so with a retry', async () => {
    let calls = 0;
    const env = await setup({
      services: {
        orders: {
          list: async () => {
            calls += 1;
            if (calls === 1) throw new ApiClientError('NETWORK');
            return { day: '2030-01-01', orders: [ticket(1)] };
          },
        },
      },
    });
    renderScreen(<KitchenScreen />, env.services);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(th['orders.loadFailed']);
    fireEvent.click(within(alert).getByRole('button', { name: th['common.retry'] }));
    await waitFor(() => ticketOf('L-001'));
  });
});

describe('the moves', () => {
  test('a kitchen role starts a new order with one tap, and the card changes only when the server has answered', async () => {
    let answer!: (o: OrderDto) => void;
    const env = await mount({
      orders: [ticket(1)],
      services: {
        orders: {
          transition: () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        },
      },
    });
    await waitFor(() => ticketOf('L-001'));
    fireEvent.click(
      within(ticketOf('L-001')).getByRole('button', { name: th['order.move.preparing'] }),
    );
    expect(env.api.orders.transition).toHaveBeenCalledWith(uuid(1), { to: 'preparing' });
    // Still the old button, now busy; the order in the store is unchanged.
    const busy = within(ticketOf('L-001')).getByRole('button', {
      name: th['order.move.preparing'],
    });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(env.entities.getState().orders.get(uuid(1))?.status).toBe('new');
    await act(async () => answer({ ...ticket(1, { status: 'preparing' }), rev: 50, version: 2 }));
    expect(
      within(ticketOf('L-001')).getByRole('button', { name: th['order.move.ready'] }),
    ).toBeTruthy();
  });

  test('marking ready moves the order to the waiting-for-hand-over list', async () => {
    const env = await mount({
      orders: [ticket(1, { status: 'preparing' })],
      services: {
        orders: {
          transition: async () => ({
            ...ticket(1, { status: 'ready', readyAt: ago(0) }),
            rev: 50,
            version: 2,
          }),
        },
      },
    });
    await waitFor(() => ticketOf('L-001'));
    fireEvent.click(
      within(ticketOf('L-001')).getByRole('button', { name: th['order.move.ready'] }),
    );
    await waitFor(() => expect(env.entities.getState().orders.get(uuid(1))?.status).toBe('ready'));
    expect(orderNos()).toEqual([]);
    expect(
      screen.getByRole('button', { name: new RegExp(tr('kitchen.ready.toggle', { count: 1 })) }),
    ).toBeTruthy();
  });

  test('a double tap sends one request', async () => {
    const env = await mount({
      orders: [ticket(1)],
      services: { orders: { transition: () => new Promise(() => undefined) } },
    });
    await waitFor(() => ticketOf('L-001'));
    const button = within(ticketOf('L-001')).getByRole('button', {
      name: th['order.move.preparing'],
    });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(env.api.orders.transition).toHaveBeenCalledTimes(1);
  });

  test('a refusal is explained on that card and the order stays', async () => {
    await mount({
      orders: [ticket(1), ticket(2, { placedAt: ago(2) })],
      services: {
        orders: {
          transition: async () => {
            throw new ApiClientError('FORBIDDEN', { status: 403 });
          },
        },
      },
    });
    await waitFor(() => ticketOf('L-001'));
    fireEvent.click(
      within(ticketOf('L-001')).getByRole('button', { name: th['order.move.preparing'] }),
    );
    const alert = await within(ticketOf('L-001')).findByRole('alert');
    expect(alert.textContent).toBeTruthy();
    expect(within(ticketOf('L-002')).queryByRole('alert')).toBeNull();
  });

  test('offers only the moves of the shared order machine: never a cancel or a hand-over', async () => {
    await mount({
      role: 'manager',
      orders: [
        ticket(1, { status: 'new', placedAt: ago(6) }),
        ticket(2, { status: 'preparing', placedAt: ago(5) }),
        ticket(3, { status: 'ready', readyAt: ago(1) }),
      ],
    });
    await waitFor(() => ticketOf('L-001'));
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons).not.toContain(th['order.move.cancelled']);
    expect(buttons).not.toContain(th['order.move.completed']);
    expect(within(ticketOf('L-001')).getAllByRole('button')).toHaveLength(1);
    expect(within(ticketOf('L-002')).getAllByRole('button')).toHaveLength(1);
  });
});

describe('ready, waiting for hand-over', () => {
  test('is a collapsed list with a count; opening it shows the orders, with no moves', async () => {
    await mount({
      orders: [
        ticket(1),
        ticket(2, { status: 'ready', readyAt: ago(9), orderNo: 'L-002' }),
        ticket(3, { status: 'ready', readyAt: ago(2), orderNo: 'L-003' }),
      ],
    });
    await waitFor(() => ticketOf('L-001'));
    const toggle = screen.getByRole('button', {
      name: new RegExp(tr('kitchen.ready.toggle', { count: 2 })),
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('L-002')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const rows = [...document.querySelectorAll('.kready .kready__no')].map((e) => e.textContent);
    // The longest waiting first.
    expect(rows).toEqual(['L-002', 'L-003']);
    const list = document.querySelector('.kready__list') as HTMLElement;
    expect(within(list).queryAllByRole('button')).toHaveLength(0);
    fireEvent.click(toggle);
    expect(screen.queryByText('L-002')).toBeNull();
  });
});

describe('keeping the display alive', () => {
  test('holds the screen awake while open and lets go when the screen closes', async () => {
    const env = await mount({ orders: [] });
    expect(env.wake.calls.acquired).toBe(1);
    expect(env.wake.active()).toBe(1);
    env.view.unmount();
    expect(env.wake.active()).toBe(0);
  });

  test('pings the session about every ten minutes while open and visible, and stops when closed', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    const env = await setup({ orders: [] });
    const view = renderScreen(<KitchenScreen />, env.services);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9 * 60_000);
    });
    expect(env.api.auth.me).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(env.api.auth.me).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000);
    });
    expect(env.api.auth.me).toHaveBeenCalledTimes(1);
  });
});

describe('the sound control', () => {
  const control = () => screen.getByRole('group', { name: th['kitchen.sound.label'] });

  test('starts off, says so, and offers to turn it on', async () => {
    await mount();
    const group = control();
    expect(within(group).getByText(th['kitchen.sound.state.off'])).toBeTruthy();
    expect(within(group).getByRole('button', { name: th['kitchen.sound.turnOn'] })).toBeTruthy();
    expect(within(group).getByText(th['kitchen.sound.hint.off'])).toBeTruthy();
  });

  test('a tap unlocks the audio at once, then says it is on, and a second tap turns it off', async () => {
    const env = await mount();
    const on = within(control()).getByRole('button', { name: th['kitchen.sound.turnOn'] });
    fireEvent.click(on);
    // Inside the same tick as the tap, before anything is awaited.
    expect(env.audio.engine.unlock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(within(control()).getByText(th['kitchen.sound.state.on'])).toBeTruthy(),
    );
    expect(env.audio.played).toEqual(['newOrder']);
    expect(await env.soundPrefs.prefs.load()).toBe(true);
    fireEvent.click(within(control()).getByRole('button', { name: th['kitchen.sound.turnOff'] }));
    await waitFor(() =>
      expect(within(control()).getByText(th['kitchen.sound.state.off'])).toBeTruthy(),
    );
    expect(await env.soundPrefs.prefs.load()).toBe(false);
  });

  test('a remembered "on" that the browser has not unlocked yet shows BLOCKED and asks for a tap', async () => {
    const env = await setup();
    await env.soundPrefs.prefs.save(true);
    await env.sound.init();
    renderScreen(<KitchenScreen />, env.services);
    const group = control();
    expect(within(group).getByText(th['kitchen.sound.state.blocked'])).toBeTruthy();
    expect(within(group).getByText(th['kitchen.sound.hint.blocked'])).toBeTruthy();
    fireEvent.click(within(group).getByRole('button', { name: th['kitchen.sound.unblock'] }));
    await waitFor(() =>
      expect(within(control()).getByText(th['kitchen.sound.state.on'])).toBeTruthy(),
    );
  });

  test('where the browser cannot play sound it says so and offers no button', async () => {
    const env = await setup();
    env.audio.engine.supported = false;
    renderScreen(<KitchenScreen />, env.services);
    // `supported` is read when the player's state is next refreshed: ask it to.
    await act(async () => {
      await env.sound.turnOn();
    });
    const group = control();
    expect(within(group).getByText(th['kitchen.sound.state.unsupported'])).toBeTruthy();
    expect(within(group).queryByRole('button')).toBeNull();
    expect(within(group).getByText(th['kitchen.sound.hint.unsupported'])).toBeTruthy();
  });
});
