// @vitest-environment jsdom
import { catalogs, translator } from '@sds/i18n';
import { type OrderDto, satang } from '@sds/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { orderDto, orderFrame, uuid } from '../test-support/frames.ts';
import { MENU } from '../test-support/menu-fixtures.ts';
import { createTestAuth, createTestServices, renderScreen } from '../test-support/render.tsx';
import { OrdersScreen } from './OrdersScreen.tsx';

const th = catalogs.th;
const en = catalogs.en;

/** 12:00 in Bangkok on 15 Oct 2030: the business day is 2030-10-15. */
const NOON = new Date('2030-10-15T05:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOON);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setWidth(1024);
});

/** The window width decides the layout: 1024 is an iPad (table), 390 an iPhone (cards). */
function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
}

const today = (n: number, over: Parameters<typeof orderDto>[2] = {}) =>
  orderDto(uuid(n), n, {
    orderNo: `S-${String(n).padStart(3, '0')}`,
    businessDate: '2030-10-15',
    placedAt: '2030-10-15T04:50:00Z',
    totalSatang: satang(7500),
    ...over,
  });

function setup(orders: ReturnType<typeof today>[] = [], listed = orders) {
  const env = createTestServices({
    orders: { list: async () => ({ day: '2030-10-15', orders: listed }) },
  });
  for (const order of orders) {
    env.entities.apply({ type: 'order.upserted', id: order.id, rev: order.rev, data: order });
  }
  return env;
}

/** The table row of an order: the button that chooses it names the order. */
const pick = (orderNo: string) =>
  screen.getByRole('button', { name: translator('th')('orders.select', { orderNo }) });
const rowOf = (orderNo: string) => {
  const row = pick(orderNo).closest('tr');
  if (!row) throw new Error(`no row ${orderNo}`);
  return row as HTMLElement;
};
const rowNumbers = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getByRole('button').textContent?.slice(0, 5));
const detail = () => screen.getByRole('complementary', { name: th['orders.detail.label'] });
const filter = (label: string) => screen.getByRole('radio', { name: new RegExp(`^${label}`) });

describe('the orders table (iPad and laptop)', () => {
  test('shows today’s orders as rows, newest first, with number, channel, items, total and payment', async () => {
    const env = setup([
      today(1, { status: 'new', placedAt: '2030-10-15T04:40:00Z' }),
      today(2, {
        status: 'preparing',
        paymentStatus: 'paid',
        channel: 'grab',
        placedAt: '2030-10-15T04:55:00Z',
      }),
      today(3, {
        status: 'ready',
        channel: 'line',
        orderNo: 'L-003',
        placedAt: '2030-10-15T04:45:00Z',
      }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    expect(rowNumbers()).toEqual(['S-002', 'L-003', 'S-001']);
    const first = rowOf('S-001');
    expect(within(first).getByText('฿75.00')).toBeTruthy();
    expect(within(first).getByText(th['status.payment.unpaid'])).toBeTruthy();
    expect(within(first).getByText(th['status.order.new'])).toBeTruthy();
    expect(within(rowOf('S-002')).getByText(th['status.payment.paid'])).toBeTruthy();
    expect(within(rowOf('S-002')).getByText(th['orders.channel.grab'])).toBeTruthy();
    // The time of the order sits under its number (Bangkok time).
    expect(within(rowOf('S-001')).getByText('11:40')).toBeTruthy();
    await waitFor(() => expect(env.api.orders.list).toHaveBeenCalled());
  });

  test('the dishes of a row are listed by name, with a quantity from two up; the detail prices them', () => {
    const line = (
      n: number,
      nameTh: string,
      qty: number,
      cents: number,
    ): OrderDto['items'][number] => ({
      id: uuid(100 + n),
      menuItemId: uuid(200 + n),
      nameTh,
      nameEn: null,
      unitPriceSatang: satang(cents),
      qty,
      modifiers:
        n === 1
          ? [
              {
                groupId: uuid(300),
                optionId: uuid(301),
                nameTh: 'เส้นใหญ่',
                nameEn: null,
                priceDeltaSatang: satang(0),
              },
            ]
          : [],
      note: null,
      lineTotalSatang: satang(cents * qty),
    });
    const env = setup([
      today(1, {
        status: 'new',
        totalSatang: satang(14500),
        items: [line(1, 'เย็นตาโฟ', 1, 6000), line(2, 'ชาเย็น', 3, 2500)],
      }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    expect(within(rowOf('S-001')).getByText('เย็นตาโฟ, ชาเย็น ×3')).toBeTruthy();
    const panel = detail();
    expect(within(panel).getByText('เย็นตาโฟ · เส้นใหญ่ ×1')).toBeTruthy();
    expect(within(panel).getByText('฿60.00')).toBeTruthy();
    expect(within(panel).getByText('ชาเย็น ×3')).toBeTruthy();
    expect(within(panel).getByText('฿75.00')).toBeTruthy();
  });

  test('leaves out other days, and the "all" view includes finished and cancelled orders', () => {
    const env = setup([
      today(1, { status: 'preparing' }),
      today(2, { status: 'completed', paymentStatus: 'paid' }),
      today(3, { status: 'cancelled' }),
      today(4, { status: 'preparing', businessDate: '2030-10-14' }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    expect(rowNumbers().sort()).toEqual(['S-001', 'S-002', 'S-003']);
    // A cancelled order shows that, not a payment it will never get.
    expect(
      within(rowOf('S-003')).getAllByText(th['status.order.cancelled']).length,
    ).toBeGreaterThan(0);
    expect(within(rowOf('S-003')).queryByText(th['status.payment.unpaid'])).toBeNull();
  });

  test('the filters are the payment groups, each with its count', () => {
    const env = setup([
      today(1, { status: 'new', paymentStatus: 'awaiting_confirmation' }),
      today(2, { status: 'preparing', paymentStatus: 'unpaid' }),
      today(3, { status: 'preparing', paymentStatus: 'unpaid' }),
      today(4, { status: 'completed', paymentStatus: 'paid' }),
      today(5, { status: 'cancelled', paymentStatus: 'unpaid' }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    expect(filter(th['orders.filter.all']).closest('label')?.textContent).toContain('5');
    expect(
      filter(th['status.payment.awaiting_confirmation']).closest('label')?.textContent,
    ).toContain('1');
    // The cancelled order owes nothing, so it is not in "not yet paid".
    expect(filter(th['status.payment.unpaid']).closest('label')?.textContent).toContain('2');
    expect(filter(th['status.payment.paid']).closest('label')?.textContent).toContain('1');

    fireEvent.click(filter(th['status.payment.awaiting_confirmation']));
    expect(rowNumbers()).toEqual(['S-001']);
    fireEvent.click(filter(th['status.payment.unpaid']));
    expect(rowNumbers().sort()).toEqual(['S-002', 'S-003']);
    fireEvent.click(filter(th['status.payment.paid']));
    expect(rowNumbers()).toEqual(['S-004']);
    fireEvent.click(filter(th['orders.filter.all']));
    expect(rowNumbers()).toHaveLength(5);
  });

  test('the search finds an order by number, recipient name or room, and says when nothing matches', () => {
    const env = setup([
      today(1, {
        status: 'new',
        fulfillment: 'entrance_delivery',
        deliveryBuilding: 'B1',
        recipientName: 'Fah ตัวอย่าง',
      }),
      today(2, { status: 'new', fulfillment: 'room_delivery', roomNo: '1204' }),
      today(3, { status: 'new' }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    const box = screen.getByRole('searchbox', { name: th['common.search'] });
    fireEvent.change(box, { target: { value: 's-003' } });
    expect(rowNumbers()).toEqual(['S-003']);
    fireEvent.change(box, { target: { value: 'fah' } });
    expect(rowNumbers()).toEqual(['S-001']);
    fireEvent.change(box, { target: { value: '1204' } });
    expect(rowNumbers()).toEqual(['S-002']);
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText(th['orders.noMatch'])).toBeTruthy();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    fireEvent.change(box, { target: { value: '' } });
    expect(rowNumbers()).toHaveLength(3);
  });

  test('the first row is open in the detail panel; choosing a row shows that order', () => {
    const env = setup([
      today(1, { status: 'new', placedAt: '2030-10-15T04:40:00Z' }),
      today(2, { status: 'preparing', placedAt: '2030-10-15T04:50:00Z' }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    expect(within(detail()).getByRole('heading', { name: 'ออเดอร์ S-002' })).toBeTruthy();
    fireEvent.click(pick('S-001'));
    expect(within(detail()).getByRole('heading', { name: 'ออเดอร์ S-001' })).toBeTruthy();
    expect(pick('S-001').getAttribute('aria-pressed')).toBe('true');
    expect(pick('S-002').getAttribute('aria-pressed')).toBe('false');
    // Clicking anywhere on the row chooses it too.
    fireEvent.click(rowOf('S-002'));
    expect(within(detail()).getByRole('heading', { name: 'ออเดอร์ S-002' })).toBeTruthy();
  });

  test('the detail says where the order goes, the dishes with their prices, and the total', () => {
    const env = setup([
      today(1, {
        status: 'new',
        fulfillment: 'entrance_delivery',
        deliveryBuilding: 'B1',
        recipientName: 'Fah ตัวอย่าง',
        deliveryNote: 'ชั้น 3',
        totalSatang: satang(7500),
      }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    const panel = detail();
    expect(within(panel).getByText(/B1 · Fah ตัวอย่าง/)).toBeTruthy();
    expect(within(panel).getByText(/ชั้น 3/)).toBeTruthy();
    expect(within(panel).getAllByText('฿75.00').length).toBeGreaterThan(0);
    expect(within(panel).getByText(th['orders.detail.amountDue'])).toBeTruthy();
  });

  test('its main button opens the order page and never pays: review, charge or just open', () => {
    const env = setup([
      today(1, {
        status: 'new',
        paymentStatus: 'awaiting_confirmation',
        placedAt: '2030-10-15T04:51:00Z',
      }),
      today(2, { status: 'new', paymentStatus: 'unpaid', placedAt: '2030-10-15T04:52:00Z' }),
      today(3, { status: 'preparing', paymentStatus: 'paid', placedAt: '2030-10-15T04:53:00Z' }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    const link = (name: string) => within(detail()).getByRole('link', { name });
    fireEvent.click(pick('S-001'));
    expect(link(th['orders.cta.review']).getAttribute('href')).toBe(`#/orders/${uuid(1)}`);
    // The customer's “paid” claim is only a claim: what to check is said, and nothing confirms here.
    expect(within(detail()).getByText(th['orders.hint.awaiting'])).toBeTruthy();
    const notify = within(detail()).getByRole('button', { name: th['orders.notifyCustomer'] });
    expect((notify as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(detail()).queryByRole('button', { name: new RegExp(th['payment.confirm']) }),
    ).toBeNull();
    fireEvent.click(pick('S-002'));
    expect(link(th['orders.cta.charge']).getAttribute('href')).toBe(`#/orders/${uuid(2)}`);
    fireEvent.click(pick('S-003'));
    expect(link(th['orders.cta.open']).getAttribute('href')).toBe(`#/orders/${uuid(3)}`);
  });

  test('a waiting order shows how long it has waited in the detail', () => {
    const env = setup([today(1, { status: 'preparing', placedAt: '2030-10-15T02:30:00Z' })]);
    renderScreen(<OrdersScreen />, env.services);
    expect(within(detail()).getByText(/2 ชม. 30 นาที/)).toBeTruthy();
  });

  test('a realtime frame changes the row and the detail', () => {
    const env = setup([today(1, { status: 'preparing' })]);
    renderScreen(<OrdersScreen />, env.services);
    act(() => {
      env.entities.apply(
        orderFrame(uuid(1), 99, { ...today(1), status: 'ready', paymentStatus: 'paid' }),
      );
    });
    expect(within(rowOf('S-001')).getByText(th['status.payment.paid'])).toBeTruthy();
    expect(within(rowOf('S-001')).getByText(th['status.order.ready'])).toBeTruthy();
    expect(within(detail()).getByText(th['orders.cta.open'])).toBeTruthy();
  });

  test('says it is loading, then says so when there are no orders', async () => {
    renderScreen(<OrdersScreen />, setup().services);
    expect(screen.getByText(th['orders.loading'])).toBeTruthy();
    expect(await screen.findByText(th['orders.empty'])).toBeTruthy();
    expect(screen.getByText(th['orders.detail.empty'])).toBeTruthy();
  });

  test('a group with no orders says so', () => {
    const env = setup([today(1, { status: 'new' })]);
    renderScreen(<OrdersScreen />, env.services);
    fireEvent.click(filter(th['status.payment.paid']));
    expect(screen.getByText(th['orders.emptyFilter'])).toBeTruthy();
  });

  test('reads in English', () => {
    renderScreen(<OrdersScreen />, setup([today(1, { status: 'preparing' })]).services, 'en');
    expect(screen.getByRole('heading', { level: 1, name: en['nav.ordersPayments'] })).toBeTruthy();
    expect(
      screen.getByRole('radio', { name: new RegExp(`^${en['orders.filter.all']}`) }),
    ).toBeTruthy();
    expect(screen.getAllByText(en['status.payment.unpaid']).length).toBeGreaterThan(0);
  });
});

describe('the orders list on an iPhone', () => {
  beforeEach(() => setWidth(390));

  const phoneSetup = async (
    orders: ReturnType<typeof today>[],
    role: 'manager' | 'cashier' = 'manager',
  ) => {
    const { auth } = await createTestAuth(role);
    const env = createTestServices({
      auth,
      orders: { list: async () => ({ day: '2030-10-15', orders }) },
    });
    for (const order of orders) {
      env.entities.apply({ type: 'order.upserted', id: order.id, rev: order.rev, data: order });
    }
    return env;
  };
  const cards = () =>
    screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('#/orders/'));

  test('each order is a card that opens the order page, newest first, with number, total and payment', async () => {
    const env = await phoneSetup([
      today(1, { status: 'new', placedAt: '2030-10-15T04:40:00Z' }),
      today(2, { status: 'preparing', paymentStatus: 'paid', placedAt: '2030-10-15T04:55:00Z' }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    const links = cards();
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      `#/orders/${uuid(2)}`,
      `#/orders/${uuid(1)}`,
    ]);
    expect(links[0]?.textContent).toContain('S-002');
    expect(links[0]?.textContent).toContain('฿75.00');
    expect(within(links[0] as HTMLElement).getByText(th['status.payment.paid'])).toBeTruthy();
    // The time of day and the status are in the line under the number.
    expect(links[1]?.textContent).toContain('11:40 น.');
    expect(links[1]?.textContent).toContain(th['status.order.new']);
  });

  test('the card of an order whose payment is claimed asks to check, an unpaid one to charge', async () => {
    const env = await phoneSetup([
      today(1, {
        status: 'new',
        paymentStatus: 'awaiting_confirmation',
        placedAt: '2030-10-15T04:55:00Z',
      }),
      today(2, { status: 'new', placedAt: '2030-10-15T04:50:00Z' }),
      today(3, { status: 'ready', paymentStatus: 'paid', placedAt: '2030-10-15T04:45:00Z' }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    const [claimed, unpaid, done] = cards();
    expect(within(claimed as HTMLElement).getByText(th['orders.cta.review'])).toBeTruthy();
    expect(claimed?.textContent).toContain(th['orders.hint.awaiting']);
    expect(within(unpaid as HTMLElement).getByText(th['orders.cta.charge'])).toBeTruthy();
    expect(done?.textContent).not.toContain(th['orders.cta.charge']);
    expect(done?.textContent).not.toContain(th['orders.cta.review']);
  });

  test('the chips are all, to pay, cooking and done', async () => {
    const env = await phoneSetup([
      today(1, { status: 'new', paymentStatus: 'awaiting_confirmation' }),
      today(2, { status: 'preparing', paymentStatus: 'unpaid' }),
      today(3, { status: 'ready', paymentStatus: 'paid' }),
      today(4, { status: 'completed', paymentStatus: 'paid' }),
      today(5, { status: 'cancelled', paymentStatus: 'unpaid' }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    const seen = () =>
      cards()
        .map((a) => a.textContent?.slice(0, 5))
        .sort();
    expect(seen()).toHaveLength(5);
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(th['orders.filter.pay']) }));
    expect(seen()).toEqual(['S-001', 'S-002']);
    fireEvent.click(screen.getByRole('radio', { name: th['orders.filter.cooking'] }));
    expect(seen()).toEqual(['S-001', 'S-002']);
    fireEvent.click(screen.getByRole('radio', { name: th['orders.filter.done'] }));
    expect(seen()).toEqual(['S-003', 'S-004']);
  });

  test('the day’s receipts show for a role that may see reports, and not for the cashier', async () => {
    const orders = [
      today(1, { status: 'completed', paymentStatus: 'paid', totalSatang: satang(10000) }),
      today(2, { status: 'preparing', paymentStatus: 'paid', totalSatang: satang(5000) }),
      today(3, { status: 'new', paymentStatus: 'unpaid', totalSatang: satang(9900) }),
    ];
    renderScreen(<OrdersScreen />, (await phoneSetup(orders, 'manager')).services);
    expect(screen.getByText(th['orders.paidToday'])).toBeTruthy();
    expect(screen.getByText('฿150.00')).toBeTruthy();
    cleanup();
    renderScreen(<OrdersScreen />, (await phoneSetup(orders, 'cashier')).services);
    expect(screen.queryByText(th['orders.paidToday'])).toBeNull();
    expect(cards()).toHaveLength(3);
  });

  test('search is behind the magnifier and finds by number', async () => {
    const env = await phoneSetup([today(1, { status: 'new' }), today(2, { status: 'new' })]);
    renderScreen(<OrdersScreen />, env.services);
    fireEvent.click(screen.getByRole('button', { name: th['common.search'] }));
    fireEvent.change(screen.getByRole('searchbox', { name: th['common.search'] }), {
      target: { value: 'S-002' },
    });
    expect(cards()).toHaveLength(1);
  });
});

describe('loading the orders', () => {
  test('fetches today’s orders once, into the store, so a fresh device sees them without waiting for sync', async () => {
    const listed = [today(5, { status: 'preparing' })];
    const env = setup([], listed);
    renderScreen(<OrdersScreen />, env.services);
    await waitFor(() => expect(pick('S-005')).toBeTruthy());
    expect(env.api.orders.list).toHaveBeenCalledTimes(1);
    expect(env.entities.getState().orders.has(uuid(5))).toBe(true);
  });

  test('choosing an earlier day loads that day (any status) and its orders can be opened; "today" goes back', async () => {
    const old = today(7, {
      status: 'completed',
      paymentStatus: 'paid',
      businessDate: '2030-10-10',
      placedAt: '2030-10-10T04:50:00Z',
    });
    const list = vi.fn(async (query?: { day?: string | undefined }) =>
      query?.day === '2030-10-10'
        ? { day: '2030-10-10', orders: [old] }
        : { day: '2030-10-15', orders: [today(5, { status: 'preparing' })] },
    );
    const env = createTestServices({ orders: { list } });
    renderScreen(<OrdersScreen />, env.services);
    await waitFor(() => expect(pick('S-005')).toBeTruthy());

    fireEvent.change(screen.getByLabelText(th['orders.day.label']), {
      target: { value: '2030-10-10' },
    });
    await waitFor(() => expect(pick('S-007')).toBeTruthy());
    expect(list).toHaveBeenLastCalledWith({ day: '2030-10-10' });
    expect(screen.queryByRole('button', { name: /S-005/ })).toBeNull();
    expect(screen.getByText(/^ออเดอร์ย้อนหลังของ/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: th['orders.day.today'] }));
    await waitFor(() => expect(pick('S-005')).toBeTruthy());
  });

  test('a failed load says the list may be incomplete and can be tried again', async () => {
    let calls = 0;
    const env = createTestServices({
      orders: {
        list: async () => {
          calls += 1;
          if (calls === 1) throw new ApiClientError('NETWORK');
          return { day: '2030-10-15', orders: [today(5, { status: 'preparing' })] };
        },
      },
    });
    renderScreen(<OrdersScreen />, env.services);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(th['orders.loadFailed']);
    fireEvent.click(screen.getByRole('button', { name: th['common.retry'] }));
    await waitFor(() => expect(pick('S-005')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('orders already in the store are shown while the list is loading', () => {
    const env = createTestServices({ orders: { list: () => new Promise(() => undefined) } });
    env.entities.apply(orderFrame(uuid(1), 5, { ...today(1), status: 'preparing' }));
    renderScreen(<OrdersScreen />, env.services);
    expect(pick('S-001')).toBeTruthy();
  });
});

describe('the way out of an unsure order', () => {
  function unsureEnv() {
    return createTestServices({
      create: async () => {
        throw new ApiClientError('TIMEOUT');
      },
      orders: { list: async () => ({ day: '2030-10-15', orders: [] }) },
    });
  }

  test('a cart whose order may exist says to look here, with a way back to it', async () => {
    const env = unsureEnv();
    env.cart.setBuilding('B1');
    env.cart.setRecipientName('Tester');
    env.cart.addItem({ itemId: MENU.tea });
    await env.cart.submit();
    expect(env.cart.getState().phase).toBe('unsure');
    renderScreen(<OrdersScreen />, env.services);
    expect(screen.getByText(th['orders.unsureCart'])).toBeTruthy();
    expect(
      screen.getByRole('link', { name: th['orders.unsureCartBack'] }).getAttribute('href'),
    ).toBe('#/new');
  });

  test('an ordinary cart gets no such notice', () => {
    const env = unsureEnv();
    env.cart.addItem({ itemId: MENU.tea });
    renderScreen(<OrdersScreen />, env.services);
    expect(screen.queryByText(th['orders.unsureCart'])).toBeNull();
  });
});
