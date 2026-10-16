// @vitest-environment jsdom
import { catalogs } from '@sds/i18n';
import { type OrdersSummaryResponse, satang } from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createTestAuth, createTestServices, renderScreen } from '../../test-support/render.tsx';
import { OrdersScreen } from './OrdersScreen.tsx';

const th = catalogs.th;

/** 12:00 in Bangkok on 15 Oct 2030: the business day is 2030-10-15. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-10-15T05:00:00Z'));
  Object.defineProperty(window, 'innerWidth', { value: 1180, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const OCTOBER: OrdersSummaryResponse = {
  month: '2030-10',
  days: [
    { date: '2030-10-10', orderCount: 4, paidCount: 3, paidSatang: satang(125000) },
    { date: '2030-10-15', orderCount: 2, paidCount: 0, paidSatang: satang(0) },
  ],
};

async function open(role: 'owner' | 'cashier', summary = vi.fn(async () => OCTOBER)) {
  const { auth } = await createTestAuth(role);
  const list = vi.fn(async (query?: { day?: string | undefined }) => ({
    day: query?.day ?? '2030-10-15',
    orders: [],
  }));
  const env = createTestServices({ auth, orders: { list, summary } });
  renderScreen(<OrdersScreen />, env.services);
  fireEvent.click(await screen.findByRole('button', { name: th['orders.month.open'] }));
  await waitFor(() => expect(summary).toHaveBeenCalled());
  return { summary, list };
}

describe('the month overview of the orders screen', () => {
  test('asks for the month of the day on screen and shows count and paid revenue per day', async () => {
    const { summary } = await open('owner');
    expect(summary).toHaveBeenCalledWith({ month: '2030-10' });
    const tenth = await screen.findByRole('button', {
      name: /^พฤหัสบดี 10 ต\.ค\. 2573: 4 ออเดอร์ · รับเงินแล้ว ฿1,250 /,
    });
    expect(within(tenth).getByText('฿1,250')).toBeTruthy(); // formatted from 125000 satang
    expect(screen.getByText(/รวมเดือนนี้ 6 ออเดอร์ · รับเงินแล้ว ฿1,250/)).toBeTruthy();
    // Unpaid orders are counted but add no revenue.
    const today = screen.getByRole('button', { name: /^อังคาร 15 ต\.ค\. 2573: 2 ออเดอร์/ });
    expect(today.closest('[aria-current="date"]')).toBeTruthy();
    expect(within(today).getByText('–')).toBeTruthy();
    // Months use the Buddhist Era in Thai.
    expect(screen.getByRole('heading', { name: /2573/ })).toBeTruthy();
  });

  test('a role without report.view sees order counts only, never an amount', async () => {
    await open('cashier');
    await screen.findByRole('button', { name: /^พฤหัสบดี 10 ต\.ค\. 2573: 4 ออเดอร์ · เปิดดู/ });
    expect(screen.queryByText(/฿/)).toBeNull();
    expect(screen.getByText(th['orders.month.legendCounts'])).toBeTruthy();
  });

  test('previous month loads that month; next stops at the current month', async () => {
    const { summary } = await open('owner');
    const next = screen.getByRole('button', { name: th['orders.month.next'] }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: th['orders.month.prev'] }));
    await waitFor(() => expect(summary).toHaveBeenLastCalledWith({ month: '2030-09' }));
    expect(screen.getByRole('heading', { name: /กันยายน 2573/ })).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: th['orders.month.next'] }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: th['orders.month.thisMonth'] }));
    await waitFor(() => expect(summary).toHaveBeenLastCalledWith({ month: '2030-10' }));
  });

  test('tapping a past day opens that day in the day list; days without orders are not buttons', async () => {
    const { list } = await open('owner');
    expect(screen.queryByRole('button', { name: /^จันทร์ 14 ต\.ค\./ })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /^พฤหัสบดี 10 ต\.ค\./ }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith({ day: '2030-10-10' }));
    expect(screen.getByText(/^ออเดอร์ย้อนหลังของ/)).toBeTruthy();
  });

  test('tapping today goes back to the live day list', async () => {
    const { list } = await open('owner');
    fireEvent.click(await screen.findByRole('button', { name: /^อังคาร 15 ต\.ค\./ }));
    await waitFor(() => expect(screen.getByText(th['orders.empty'])).toBeTruthy());
    expect(screen.queryByRole('heading', { name: /2573/ })).toBeNull();
    expect(list).toHaveBeenLastCalledWith({});
  });

  test('a failed load says so and can be tried again', async () => {
    const summary = vi
      .fn<() => Promise<OrdersSummaryResponse>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(OCTOBER);
    await open('owner', summary);
    expect((await screen.findByRole('alert')).textContent).toContain(th['orders.month.failed']);
    fireEvent.click(screen.getByRole('button', { name: th['common.retry'] }));
    await screen.findByRole('button', { name: /^พฤหัสบดี 10 ต\.ค\./ });
    expect(summary).toHaveBeenCalledTimes(2);
  });
});
