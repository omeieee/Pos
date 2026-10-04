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

/** A ticket is an article named by its order number. */
const ticketOf = (orderNo: string) => screen.getByRole('article', { name: orderNo });
const column = (id: 'new' | 'cooking' | 'ready') =>
  screen.getByRole('region', { name: th[`kitchen.col.${id}`] });
const numbersIn = (id: 'new' | 'cooking' | 'ready') =>
  within(column(id))
    .queryAllByRole('article')
    .map((article) => within(article).getByRole('heading', { level: 3 }).textContent);
/** The orders to make, the new column and then the cooking one. */
const orderNos = () => [...numbersIn('new'), ...numbersIn('cooking')];

async function mount(options: Parameters<typeof setup>[0] = {}) {
  const env = await setup(options);
  const view = renderScreen(<KitchenScreen />, env.services);
  await waitFor(() => expect(env.api.orders.list).toHaveBeenCalled());
  return { ...env, view };
}

describe('the tickets', () => {
  test('are the new orders, the ones being made and the ones ready, in three columns, oldest first, with the number and the channel', async () => {
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
    await waitFor(() => expect(numbersIn('new')).toEqual(['L-002', 'G-003']));
    expect(numbersIn('cooking')).toEqual(['S-001']);
    expect(numbersIn('ready')).toEqual([]);
    // The channel is said in words on the ticket.
    expect(ticketOf('L-002').textContent).toContain(th['orders.channel.line']);
    expect(ticketOf('G-003').textContent).toContain(th['orders.channel.grab']);
  });

  test('each column says how many tickets it has', async () => {
    await mount({
      orders: [
        ticket(1),
        ticket(2, { placedAt: ago(5) }),
        ticket(3, { status: 'preparing' }),
        ticket(4, { status: 'ready', readyAt: ago(1) }),
      ],
    });
    await waitFor(() => ticketOf('L-001'));
    expect(within(column('new')).getByText(tr('kitchen.ticketCount', { count: 2 }))).toBeTruthy();
    expect(
      within(column('cooking')).getByText(tr('kitchen.ticketCount', { count: 1 })),
    ).toBeTruthy();
    expect(within(column('ready')).getByText(tr('kitchen.ticketCount', { count: 1 }))).toBeTruthy();
  });

  test('show every dish with its quantity, its choices and its note, and the note of the order', async () => {
    await mount({ orders: [ticket(1, { note: 'ห่อกลับ ใส่ถุงสองใบ' })] });
    const card = await waitFor(() => ticketOf('L-001'));
    // The quantity sits in its own box.
    expect(within(card).getByText('2')).toBeTruthy();
    expect(within(card).getByText('ก๋วยเตี๋ยวต้มยำ')).toBeTruthy();
    expect(within(card).getByText(/เส้นเล็ก/)).toBeTruthy();
    expect(within(card).getByText(/เผ็ดมาก/)).toBeTruthy();
    expect(within(card).getByText('ไม่ใส่ถั่วงอก')).toBeTruthy();
    expect(within(card).getByText(/ห่อกลับ ใส่ถุงสองใบ/)).toBeTruthy();
  });

  test('show where an entrance delivery goes: building and name large, the other details with them', async () => {
    await mount({
      orders: [
        ticket(1, {
          fulfillment: 'entrance_delivery',
          deliveryBuilding: 'B1',
          recipientName: 'Fah ตัวอย่าง',
          deliveryNote: 'ชั้น 3 เสื้อแดง',
          note: 'ไม่เผ็ด',
        }),
      ],
    });
    const card = await waitFor(() => ticketOf('L-001'));
    const where = card.querySelector('.kb-where') as HTMLElement;
    expect(where.textContent).toBe('B1 · Fah ตัวอย่าง');
    expect(within(card).getByText('ชั้น 3 เสื้อแดง')).toBeTruthy();
    expect(within(card).getByText(th['pos.orderEntry.fulfilment.entrance_delivery'])).toBeTruthy();
    expect(card.textContent).toContain(th['orders.channel.line']);
    // The kitchen note is still its own thing.
    expect(within(card).getByText(/ไม่เผ็ด/)).toBeTruthy();
    expect(card.textContent).not.toMatch(/฿|\d+\.\d\d/);
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
    expect(ticketOf('L-001').textContent).toContain(th['status.payment.unpaid']);
    expect(ticketOf('L-002').textContent).toContain(th['kitchen.pay.awaiting']);
    expect(ticketOf('L-003').textContent).toContain(th['status.payment.paid']);
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
    expect(ticketOf('L-002')).toBeTruthy();
    const text = view.container.textContent ?? '';
    expect(text).not.toContain('฿');
    expect(text).not.toContain('123.45');
    expect(text).not.toContain('50.00');
  });

  test('show how long each has waited as mm:ss, with a word as well as a colour once it is past 8 minutes', async () => {
    await mount({
      orders: [
        ticket(1, { placedAt: ago(4) }),
        ticket(2, { placedAt: ago(8) }),
        ticket(3, { placedAt: ago(25) }),
      ],
    });
    await waitFor(() => ticketOf('L-001'));
    expect(ticketOf('L-001').dataset.level).toBe('ok');
    expect(ticketOf('L-002').dataset.level).toBe('warn');
    expect(ticketOf('L-003').dataset.level).toBe('late');
    expect(within(ticketOf('L-001')).getByText('04:00')).toBeTruthy();
    expect(within(ticketOf('L-001')).queryByText(new RegExp(th['kitchen.level.warn']))).toBeNull();
    expect(within(ticketOf('L-002')).getByText(`08:00 · ${th['kitchen.level.warn']}`)).toBeTruthy();
    expect(within(ticketOf('L-003')).getByText(`25:00 · ${th['kitchen.level.late']}`)).toBeTruthy();
    // A screen reader hears the minutes in words.
    expect(within(ticketOf('L-003')).getByText(/รอมาแล้ว 25 นาที/)).toBeTruthy();
  });

  test('a new ticket glows during its first minute; a late one has a ring', async () => {
    await mount({
      orders: [
        ticket(1, { placedAt: ago(0) }),
        ticket(2, { placedAt: ago(3) }),
        ticket(3, { placedAt: ago(30) }),
      ],
    });
    await waitFor(() => ticketOf('L-001'));
    expect(ticketOf('L-001').className).toContain('kb-new');
    expect(ticketOf('L-002').className).not.toContain('kb-new');
    expect(ticketOf('L-003').className).toContain('kb-late');
  });

  test('the board names the 8-minute rule and shows the clock', async () => {
    await mount({ orders: [] });
    expect(screen.getByRole('heading', { level: 1, name: th['kitchen.title'] })).toBeTruthy();
    expect(screen.getByText(tr('kitchen.subtitle', { minutes: 8 }))).toBeTruthy();
    expect(document.querySelector('time')).toBeTruthy();
  });

  test('says how many were handed over today and how long they took', async () => {
    const done = (n: number, took: number) =>
      ticket(n, {
        status: 'completed',
        businessDate: '2030-01-01',
        placedAt: ago(60),
        completedAt: ago(60 - took),
      });
    await mount({ orders: [done(1, 6), done(2, 8)] });
    await screen.findByText(tr('kitchen.handedOverAvg', { count: 2, minutes: 7 }));
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
      within(ticketOf('L-001')).getByRole('button', { name: th['kitchen.move.ready'] }),
    ).toBeTruthy();
    // It moved to the cooking column by itself.
    expect(numbersIn('new')).toEqual([]);
    expect(numbersIn('cooking')).toEqual(['L-001']);
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
      within(ticketOf('L-001')).getByRole('button', { name: th['kitchen.move.ready'] }),
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
      within(ticketOf('L-001')).getByRole('button', { name: th['kitchen.move.ready'] }),
    );
    await waitFor(() => expect(env.entities.getState().orders.get(uuid(1))?.status).toBe('ready'));
    expect(orderNos()).toEqual([]);
    expect(numbersIn('ready')).toEqual(['L-001']);
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
    // Ready, waiting for hand-over: information only.
    expect(within(ticketOf('L-003')).queryAllByRole('button')).toHaveLength(0);
  });
});

describe('ready, waiting for hand-over', () => {
  test('is the third column: the order that has waited longest first, with where it goes and no moves', async () => {
    await mount({
      orders: [
        ticket(1),
        ticket(2, {
          status: 'ready',
          readyAt: ago(2),
          orderNo: 'L-002',
          fulfillment: 'entrance_delivery',
          deliveryBuilding: 'A2',
          recipientName: 'Nok',
        }),
        ticket(3, {
          status: 'ready',
          readyAt: ago(9),
          orderNo: 'L-003',
          fulfillment: 'entrance_delivery',
          deliveryBuilding: 'B1',
          recipientName: 'Fah',
        }),
      ],
    });
    await waitFor(() => ticketOf('L-001'));
    // The longest waiting first.
    expect(numbersIn('ready')).toEqual(['L-003', 'L-002']);
    expect(within(ticketOf('L-003')).getByText('B1 · Fah')).toBeTruthy();
    expect(within(column('ready')).queryAllByRole('button')).toHaveLength(0);
    // How long it has waited since it became ready, in words for a screen reader.
    expect(within(ticketOf('L-003')).getByText(/พร้อมมาแล้ว 9 นาที/)).toBeTruthy();
  });

  test('says so when nothing waits for hand-over', async () => {
    await mount({ orders: [ticket(1)] });
    await waitFor(() => ticketOf('L-001'));
    expect(within(column('ready')).getByText(th['kitchen.ready.empty'])).toBeTruthy();
  });
});

describe('the way back', () => {
  test('goes to the first page the role may open besides the kitchen', async () => {
    await mount({ role: 'kitchen' });
    expect(screen.getByRole('link', { name: th['common.back'] }).getAttribute('href')).toBe(
      '#/orders',
    );
    cleanup();
    await mount({ role: 'cashier' });
    expect(screen.getByRole('link', { name: th['common.back'] }).getAttribute('href')).toBe(
      '#/new',
    );
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

describe('the keepalive and the owner password session', () => {
  test('is not started for an owner password session: its short idle limit stays', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    const { auth } = await createTestAuth('owner');
    const session = auth.getState().session;
    if (!session) throw new Error('no session');
    const ownerState = { ...auth.getState(), session: { ...session, method: 'owner' as const } };
    const ownerAuth = {
      ...auth,
      getState: () => ownerState,
    };
    const env = createTestServices({
      auth: ownerAuth,
      orders: { list: async () => ({ day: '2030-01-01', orders: [] }) },
    });
    renderScreen(<KitchenScreen />, env.services);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000);
    });
    expect(env.api.auth.me).not.toHaveBeenCalled();
  });
});

describe('the sound control', () => {
  const control = () => screen.getByRole('group', { name: th['kitchen.sound.label'] });
  const switchOf = () => within(control()).getByRole('switch', { name: th['kitchen.sound.short'] });

  test('starts off, says so, and offers to turn it on with the switch', async () => {
    await mount();
    const group = control();
    expect(within(group).getByText(th['kitchen.sound.state.off'])).toBeTruthy();
    expect((switchOf() as HTMLInputElement).checked).toBe(false);
    expect(within(group).getByText(th['kitchen.sound.hint.off'])).toBeTruthy();
  });

  test('a tap unlocks the audio at once, then says it is on, and a second tap turns it off', async () => {
    const env = await mount();
    fireEvent.click(switchOf());
    // Inside the same tick as the tap, before anything is awaited.
    expect(env.audio.engine.unlock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(within(control()).getByText(th['kitchen.sound.state.on'])).toBeTruthy(),
    );
    expect((switchOf() as HTMLInputElement).checked).toBe(true);
    expect(env.audio.played).toEqual(['newOrder']);
    expect(await env.soundPrefs.prefs.load()).toBe(true);
    fireEvent.click(switchOf());
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
    expect((switchOf() as HTMLInputElement).checked).toBe(false);
    fireEvent.click(switchOf());
    await waitFor(() =>
      expect(within(control()).getByText(th['kitchen.sound.state.on'])).toBeTruthy(),
    );
  });

  test('where the browser cannot play sound it says so and the switch is disabled', async () => {
    const env = await setup();
    env.audio.engine.supported = false;
    renderScreen(<KitchenScreen />, env.services);
    // `supported` is read when the player's state is next refreshed: ask it to.
    await act(async () => {
      await env.sound.turnOn();
    });
    const group = control();
    expect(within(group).getByText(th['kitchen.sound.state.unsupported'])).toBeTruthy();
    expect((switchOf() as HTMLInputElement).disabled).toBe(true);
    expect(within(group).getByText(th['kitchen.sound.hint.unsupported'])).toBeTruthy();
  });
});
