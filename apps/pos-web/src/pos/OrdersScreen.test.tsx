// @vitest-environment jsdom
import { catalogs } from '@sds/i18n';
import { satang } from '@sds/shared';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../api/errors.ts';
import { orderDto, orderFrame, uuid } from '../test-support/frames.ts';
import { MENU } from '../test-support/menu-fixtures.ts';
import { createTestServices, renderScreen } from '../test-support/render.tsx';
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
});

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

describe('the orders board', () => {
  test('shows today’s open orders in their status columns, with number, total and payment status', async () => {
    const env = setup([
      today(1, { status: 'new' }),
      today(2, { status: 'preparing', paymentStatus: 'paid' }),
      today(3, { status: 'ready', channel: 'line', orderNo: 'L-003' }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    for (const status of ['new', 'preparing', 'ready'] as const) {
      expect(
        screen.getByRole('heading', { name: new RegExp(th[`status.order.${status}`]) }),
      ).toBeTruthy();
    }
    const card = screen.getByRole('link', { name: /S-001/ });
    expect(within(card).getByText('฿75.00')).toBeTruthy();
    expect(within(card).getByText(th['status.payment.unpaid'])).toBeTruthy();
    const paid = screen.getByRole('link', { name: /S-002/ });
    expect(within(paid).getByText(th['status.payment.paid'])).toBeTruthy();
    // The channel letter sits next to the number.
    const line = screen.getByRole('link', { name: /L-003/ });
    expect(within(line).getByText('L', { selector: '.ochannel' })).toBeTruthy();
    await waitFor(() => expect(env.api.orders.list).toHaveBeenCalled());
  });

  test('a card says where the order goes: building and name, and the other details', () => {
    const env = setup([
      today(1, {
        status: 'new',
        fulfillment: 'entrance_delivery',
        deliveryBuilding: 'B1',
        recipientName: 'Fah ตัวอย่าง',
        deliveryNote: 'ชั้น 3',
      }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    const card = screen.getByRole('link', { name: /S-001/ });
    expect(within(card).getByText(/B1 · Fah ตัวอย่าง/)).toBeTruthy();
    expect(within(card).getByText(/ชั้น 3/)).toBeTruthy();
  });

  test('leaves out other days and, by default, finished and cancelled orders', () => {
    const env = setup([
      today(1, { status: 'preparing' }),
      today(2, { status: 'completed' }),
      today(3, { status: 'cancelled' }),
      today(4, { status: 'preparing', businessDate: '2030-10-14' }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    expect(screen.getByRole('link', { name: /S-001/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /S-002/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /S-003/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /S-004/ })).toBeNull();
  });

  test('the "all today" filter adds the finished and cancelled columns', () => {
    const env = setup([
      today(1, { status: 'preparing' }),
      today(2, { status: 'completed' }),
      today(3, { status: 'cancelled' }),
      today(4, { status: 'preparing', businessDate: '2030-10-14' }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    fireEvent.click(screen.getByRole('radio', { name: th['orders.filter.all'] }));
    expect(screen.getByRole('link', { name: /S-002/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /S-003/ })).toBeTruthy();
    // Yesterday's order is still not here.
    expect(screen.queryByRole('link', { name: /S-004/ })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: th['orders.filter.open'] }));
    expect(screen.queryByRole('link', { name: /S-002/ })).toBeNull();
  });

  test('a tap on an order goes to its page', () => {
    const env = setup([today(7, { status: 'preparing' })]);
    renderScreen(<OrdersScreen />, env.services);
    expect(screen.getByRole('link', { name: /S-007/ }).getAttribute('href')).toBe(
      `#/orders/${uuid(7)}`,
    );
  });

  test('the oldest order is first in its column, and a card shows how long it has waited', () => {
    const env = setup([
      today(1, { status: 'preparing', placedAt: '2030-10-15T04:55:00Z' }),
      today(2, { status: 'preparing', placedAt: '2030-10-15T04:20:00Z' }),
      today(3, { status: 'preparing', placedAt: '2030-10-15T02:30:00Z' }),
    ]);
    renderScreen(<OrdersScreen />, env.services);
    const links = screen.getAllByRole('link').map((a) => a.textContent ?? '');
    expect(links[0]).toContain('S-003');
    expect(links[1]).toContain('S-002');
    expect(links[2]).toContain('S-001');
    expect(links[2]).toContain('5 นาที');
    expect(links[1]).toContain('40 นาที');
    expect(links[0]).toContain('2 ชม. 30 นาที');
  });

  test('an order that customers say they paid is marked "to check"', () => {
    const env = setup([today(1, { status: 'new', paymentStatus: 'awaiting_confirmation' })]);
    renderScreen(<OrdersScreen />, env.services);
    const card = screen.getByRole('link', { name: /S-001/ });
    expect(within(card).getByText(th['status.payment.awaiting_confirmation'])).toBeTruthy();
    expect(card.className).toContain('ocard--attention');
  });

  test('a realtime frame moves the card to another column and updates its payment status', () => {
    const env = setup([today(1, { status: 'preparing' })]);
    renderScreen(<OrdersScreen />, env.services);
    act(() => {
      env.entities.apply(
        orderFrame(uuid(1), 99, { ...today(1), status: 'ready', paymentStatus: 'paid' }),
      );
    });
    const ready = screen.getByRole('heading', { name: new RegExp(th['status.order.ready']) });
    expect(ready.closest('section')?.textContent).toContain('S-001');
    expect(screen.getByText(th['status.payment.paid'])).toBeTruthy();
  });

  test('says it is loading, then says so when there are no orders', async () => {
    renderScreen(<OrdersScreen />, setup().services);
    expect(screen.getByText(th['orders.loading'])).toBeTruthy();
    expect(await screen.findByText(th['orders.emptyOpen'])).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: th['orders.filter.all'] }));
    expect(screen.getByText(th['orders.empty'])).toBeTruthy();
  });

  test('reads in English', () => {
    renderScreen(<OrdersScreen />, setup([today(1, { status: 'preparing' })]).services, 'en');
    expect(screen.getByRole('heading', { name: en['orders.title'] })).toBeTruthy();
    expect(screen.getByRole('radio', { name: en['orders.filter.open'] })).toBeTruthy();
    expect(screen.getByText(en['status.payment.unpaid'])).toBeTruthy();
  });
});

describe('loading the orders', () => {
  test('fetches today’s orders once, into the store, so a fresh device sees them without waiting for sync', async () => {
    const listed = [today(5, { status: 'preparing' })];
    const env = setup([], listed);
    renderScreen(<OrdersScreen />, env.services);
    await waitFor(() => expect(screen.getByRole('link', { name: /S-005/ })).toBeTruthy());
    expect(env.api.orders.list).toHaveBeenCalledTimes(1);
    expect(env.entities.getState().orders.has(uuid(5))).toBe(true);
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
    await waitFor(() => expect(screen.getByRole('link', { name: /S-005/ })).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('orders already in the store are shown while the list is loading', () => {
    const env = createTestServices({ orders: { list: () => new Promise(() => undefined) } });
    env.entities.apply(orderFrame(uuid(1), 5, { ...today(1), status: 'preparing' }));
    renderScreen(<OrdersScreen />, env.services);
    expect(screen.getByRole('link', { name: /S-001/ })).toBeTruthy();
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
