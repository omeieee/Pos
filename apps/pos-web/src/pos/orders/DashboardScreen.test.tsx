// @vitest-environment jsdom
import { catalogs } from '@sds/i18n';
import {
  type CustomersReport,
  type HeatmapReport,
  type ItemsReport,
  type RevenueReport,
  satang,
} from '@sds/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiClientError } from '../../api/errors.ts';
import { orderFrame, uuid } from '../../test-support/frames.ts';
import { createTestAuth, createTestServices, renderScreen } from '../../test-support/render.tsx';
import { DashboardScreen } from './DashboardScreen.tsx';

const th = catalogs.th;

/** 12:00 in Bangkok on Tuesday 15 Oct 2030: the business day is 2030-10-15. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-10-15T05:00:00Z'));
  Object.defineProperty(window, 'innerWidth', { value: 1180, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const day = (businessDate: string, over: Partial<RevenueReport['days'][number]> = {}) => ({
  businessDate,
  revenueSatang: satang(486000),
  orderCount: 38,
  averageTicketSatang: satang(12789),
  commissionSatang: satang(0),
  byChannel: {
    storefront: satang(223600),
    line: satang(184700),
    grab: satang(77700),
  },
  byMethod: { cash: satang(223600), promptpay: satang(262400) },
  ...over,
});

const totals = (revenue: number, orders: number) => ({
  revenueSatang: satang(revenue),
  orderCount: orders,
  commissionSatang: satang(0),
});

const NO_MARGIN = {
  costedOrderCount: 0,
  costedRevenueSatang: satang(0),
  costSatang: satang(0),
  grossProfitSatang: null,
  marginBp: null,
  uncostedOrderIds: [],
  uncostedRevenueSatang: satang(0),
  uncostedMenuItemIds: [],
};
const NO_COMMISSION = {
  recordedSatang: satang(0),
  recordedOrderCount: 0,
  estimatedSatang: satang(0),
  estimatedOrderCount: 0,
  totalSatang: satang(0),
  rateNotSetOrderIds: [],
  ratesNotSet: [],
};

const TODAY: RevenueReport = {
  from: '2030-10-15',
  to: '2030-10-15',
  excludedOrderIds: [],
  days: [day('2030-10-15')],
  totals: totals(486000, 38),
  margin: NO_MARGIN,
  commission: NO_COMMISSION,
};
const YESTERDAY: RevenueReport = {
  from: '2030-10-14',
  to: '2030-10-14',
  excludedOrderIds: [],
  days: [day('2030-10-14', { revenueSatang: satang(466000), orderCount: 35 })],
  totals: totals(466000, 35),
  margin: NO_MARGIN,
  commission: NO_COMMISSION,
};

const item = (name: string, qty: number) => ({
  menuItemId: uuid(qty),
  name,
  qty,
  revenueSatang: satang(qty * 6000),
  unitShareBp: 0,
  popular: false,
  costedQty: 0,
  costedRevenueSatang: satang(0),
  costSatang: null,
  grossProfitSatang: null,
  marginBp: null,
});
const ITEMS: ItemsReport = {
  from: '2030-10-15',
  to: '2030-10-15',
  excludedOrderIds: [],
  uncostedMenuItemIds: [],
  items: [
    item('ชาเย็น', 17),
    item('ก๋วยเตี๋ยวต้มยำ', 14),
    item('เย็นตาโฟ', 11),
    item('บะหมี่แห้งหมูแดง', 9),
    item('เรือหมูน้ำตก', 7),
    item('ไข่ดาว', 2),
  ],
};

const HEAT: HeatmapReport = {
  from: '2030-10-15',
  to: '2030-10-15',
  excludedOrderIds: [],
  cells: [
    { weekday: 2, hour: 11, orderCount: 6, revenueSatang: satang(60000) },
    { weekday: 2, hour: 12, orderCount: 11, revenueSatang: satang(154000) },
    { weekday: 2, hour: 13, orderCount: 3, revenueSatang: satang(30000) },
  ],
};

const CUSTOMERS: CustomersReport = {
  summary: { new: 2, regular: 5, lapsed: 1 },
  customers: [
    {
      id: uuid(901),
      name: 'สมชาย ใจดี',
      building: 'B2',
      segment: 'regular',
      orderCount: 5,
      totalSpentSatang: satang(50000),
      firstSeenAt: '2030-06-01T05:00:00.000Z',
      lastOrderAt: '2030-10-14T05:00:00.000Z',
      favourites: [
        { menuItemId: uuid(1), name: 'ชาเย็น', qty: 4 },
        { menuItemId: uuid(2), name: 'ต้มยำ', qty: 2 },
      ],
    },
  ],
};

const answerFor = (range: { from: string }) => (range.from === '2030-10-14' ? YESTERDAY : TODAY);

async function open(
  role: 'owner' | 'manager',
  reports: Parameters<typeof createTestServices>[0] extends infer O
    ? O extends { reports?: infer R }
      ? R
      : never
    : never = {},
) {
  const { auth } = await createTestAuth(role);
  const env = createTestServices({
    auth,
    reports: {
      revenue: vi.fn(async (range) => answerFor(range)),
      items: vi.fn(async () => ITEMS),
      heatmap: vi.fn(async () => HEAT),
      customers: vi.fn(async () => CUSTOMERS),
      ...reports,
    },
  });
  renderScreen(<DashboardScreen />, env.services);
  return env;
}

describe('the overview shows real report figures', () => {
  test('asks for today and yesterday and shows revenue, orders and average with the comparison', async () => {
    const env = await open('manager');
    await screen.findByText('฿4,860');
    expect(env.api.reports.revenue).toHaveBeenCalledWith({ from: '2030-10-15', to: '2030-10-15' });
    expect(env.api.reports.revenue).toHaveBeenCalledWith({ from: '2030-10-14', to: '2030-10-14' });
    expect(env.api.reports.items).toHaveBeenCalledWith({ from: '2030-10-15', to: '2030-10-15' });
    expect(env.api.reports.heatmap).toHaveBeenCalledWith({ from: '2030-10-15', to: '2030-10-15' });
    // 4,860 against 4,660: up 200 baht, 4.3 percent
    expect(screen.getByText('เพิ่มขึ้น 4.3%')).toBeTruthy();
    expect(screen.getByText('จากเมื่อวาน ฿4,660')).toBeTruthy();
    // 38 orders against 35
    expect(screen.getByText('38 ใบ')).toBeTruthy();
    expect(screen.getByText('เพิ่มขึ้น 8.6%')).toBeTruthy();
    // average 127.89 against 133.14: down 3.9 percent
    expect(screen.getByText('฿127.89')).toBeTruthy();
    expect(screen.getByText('ลดลง 3.9%')).toBeTruthy();
  });

  test('says there is nothing to compare with when the earlier period had no sales', async () => {
    await open('manager', {
      revenue: vi.fn(async (range) =>
        range.from === '2030-10-14' ? { ...YESTERDAY, days: [], totals: totals(0, 0) } : TODAY,
      ),
    });
    await screen.findByText('฿4,860');
    expect(screen.getAllByText(th['dash.vs.none'])).toHaveLength(3);
    expect(screen.queryByText(/เพิ่มขึ้น/)).toBeNull();
  });

  test('channels: a labelled share and amount per channel, and the same numbers as a table', async () => {
    await open('manager');
    await screen.findByText('฿4,860');
    const bar = screen.getByRole('img', {
      name: 'สัดส่วนช่องทางขาย: หน้าร้าน 46%, LINE 38%, Grab 16%',
    });
    expect(bar.children).toHaveLength(3);
    expect(screen.getByText('46% · ฿2,236')).toBeTruthy();
    expect(screen.getByText('38% · ฿1,847')).toBeTruthy();
    expect(screen.getByText('16% · ฿777')).toBeTruthy();
    fireEvent.click(screen.getByText(th['dash.table.show']));
    // the same numbers as a table, inside the "show as a table" row
    const details = screen.getByText(th['dash.table.show']).closest('details') as HTMLElement;
    const table = within(details).getByRole('table', { hidden: true });
    expect(within(table).getByRole('rowheader', { name: 'LINE', hidden: true })).toBeTruthy();
    expect(within(table).getAllByRole('row', { hidden: true })).toHaveLength(4);
  });

  test('items: best sellers with their units, and the slowest ones apart', async () => {
    await open('manager');
    await screen.findByText('฿4,860');
    const lists = screen.getAllByRole('list').filter((l) => l.className === 'rpt-bars');
    expect(lists).toHaveLength(2);
    expect(
      within(lists[0] as HTMLElement)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'ชาเย็น17 จำนวนที่ขาย',
      'ก๋วยเตี๋ยวต้มยำ14 จำนวนที่ขาย',
      'เย็นตาโฟ11 จำนวนที่ขาย',
      'บะหมี่แห้งหมูแดง9 จำนวนที่ขาย',
      'เรือหมูน้ำตก7 จำนวนที่ขาย',
    ]);
    expect(within(lists[1] as HTMLElement).getAllByRole('listitem')).toHaveLength(1);
    expect(within(lists[1] as HTMLElement).getByText(/ไข่ดาว/)).toBeTruthy();
  });

  test('heatmap: a table with the order count in each busy cell and the busiest slot in its label', async () => {
    await open('manager');
    await screen.findByText('฿4,860');
    const grid = screen.getByRole('table', { name: /คึกคักที่สุดคือ.*12:00 น\. 11 ใบ/ });
    // the busiest cell carries its count as text, so the number reads without the colour
    expect(within(grid).getByTitle(/12:00 น\. · 11 ใบ/).textContent).toBe('11');
    // Monday first: seven rows of body plus the header row
    expect(within(grid).getAllByRole('row')).toHaveLength(8);
  });

  test('the orders waiting for payment come from the live feed, today only', async () => {
    const { auth } = await createTestAuth('manager');
    const env = createTestServices({
      auth,
      reports: {
        revenue: vi.fn(async (range) => answerFor(range)),
        items: vi.fn(async () => ITEMS),
        heatmap: vi.fn(async () => HEAT),
      },
    });
    env.entities.apply(
      orderFrame(uuid(11), 1, {
        orderNo: 'L-014',
        businessDate: '2030-10-15',
        channel: 'line',
        paymentStatus: 'awaiting_confirmation',
        totalSatang: satang(23000),
      }),
    );
    env.entities.apply(
      orderFrame(uuid(12), 2, {
        orderNo: 'S-001',
        businessDate: '2030-10-14',
        paymentStatus: 'unpaid',
      }),
    );
    env.entities.apply(
      orderFrame(uuid(13), 3, {
        orderNo: 'S-077',
        businessDate: '2030-10-15',
        status: 'cancelled',
        paymentStatus: 'unpaid',
      }),
    );
    renderScreen(<DashboardScreen />, env.services);
    await screen.findByText('฿4,860');
    const link = screen.getByRole('link', { name: /L-014 · LINE/ });
    expect(link.getAttribute('href')).toBe(`#/orders/${uuid(11)}`);
    expect(within(link).getByText(th['status.payment.awaiting_confirmation'])).toBeTruthy();
    expect(screen.queryByText(/S-001/)).toBeNull();
    expect(screen.queryByText(/S-077/)).toBeNull();
  });

  test('the VAT meter is still labelled as sample data', async () => {
    await open('manager');
    await screen.findByText('฿4,860');
    const card = screen.getByText(th['dash.vat']).closest('.rpt-card') as HTMLElement;
    expect(within(card).getByText(th['dash.sample'])).toBeTruthy();
  });
});

describe('periods', () => {
  test('week asks for Monday to today and the same span of the week before', async () => {
    const env = await open('manager');
    await screen.findByText('฿4,860');
    fireEvent.click(screen.getByRole('radio', { name: th['dash.range.week'] }));
    await waitFor(() =>
      expect(env.api.reports.revenue).toHaveBeenCalledWith({
        from: '2030-10-14',
        to: '2030-10-15',
      }),
    );
    expect(env.api.reports.revenue).toHaveBeenCalledWith({ from: '2030-10-07', to: '2030-10-08' });
    expect(await screen.findAllByText(/จากสัปดาห์ก่อน/)).toHaveLength(3);
  });

  test('month and year use their own comparison text', async () => {
    const env = await open('manager');
    await screen.findByText('฿4,860');
    fireEvent.click(screen.getByRole('radio', { name: th['dash.range.month'] }));
    await waitFor(() =>
      expect(env.api.reports.revenue).toHaveBeenCalledWith({
        from: '2030-10-01',
        to: '2030-10-15',
      }),
    );
    expect(env.api.reports.revenue).toHaveBeenCalledWith({ from: '2030-09-01', to: '2030-09-15' });
    expect(await screen.findAllByText(/จากเดือนก่อน/)).toHaveLength(3);
    fireEvent.click(screen.getByRole('radio', { name: th['dash.range.year'] }));
    await waitFor(() =>
      expect(env.api.reports.revenue).toHaveBeenCalledWith({
        from: '2030-01-01',
        to: '2030-10-15',
      }),
    );
    expect(await screen.findAllByText(/จากปีก่อน/)).toHaveLength(3);
  });
});

describe('orders left out of the figures', () => {
  test('a warning counts the orders the server set aside, once', async () => {
    await open('manager', {
      revenue: vi.fn(async (range) => ({
        ...answerFor(range),
        excludedOrderIds: ['order-a', 'order-b'],
      })),
      items: vi.fn(async () => ({ ...ITEMS, excludedOrderIds: ['order-b', 'order-c'] })),
    });
    const note = await screen.findByTestId('excluded-orders');
    expect(note.textContent).toContain(th['dash.excluded'].replace('{count}', '3'));
  });

  test('no warning when nothing was left out', async () => {
    await open('manager');
    await screen.findByText('฿4,860');
    expect(screen.queryByTestId('excluded-orders')).toBeNull();
  });
});

describe('loading, errors and roles', () => {
  test('a failed load says so and a retry loads again', async () => {
    const revenue = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError('NETWORK'))
      .mockImplementation(async (range: { from: string }) => answerFor(range));
    await open('manager', { revenue });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(th['dash.error'])).toBeTruthy();
    expect(screen.queryByText('฿4,860')).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: th['common.retry'] }));
    await screen.findByText('฿4,860');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a manager sees no customer list and no export, and the API is never asked for them', async () => {
    const env = await open('manager');
    await screen.findByText('฿4,860');
    expect(screen.queryByText(th['dash.customers.title'])).toBeNull();
    expect(screen.queryByRole('button', { name: th['dash.export.revenue'] })).toBeNull();
    expect(env.api.reports.customers).not.toHaveBeenCalled();
  });

  test('the owner sees the customer segments, the list and the favourites', async () => {
    const env = await open('owner');
    await screen.findByText('฿4,860');
    const card = (await screen.findByText(th['dash.customers.ownerOnly'])).closest(
      '.rpt-card',
    ) as HTMLElement;
    await within(card).findByText('สมชาย ใจดี');
    expect(env.api.reports.customers).toHaveBeenCalledTimes(1);
    expect(within(card).getByText(th['dash.customers.ownerOnly'])).toBeTruthy();
    expect(within(card).getByText('ชาเย็น, ต้มยำ')).toBeTruthy();
    expect(within(card).getByText('฿500')).toBeTruthy();
    // 2 new, 5 regular, 1 lapsed
    const tile = (key: 'new' | 'regular' | 'lapsed') =>
      within(card).getByText(th[`dash.customers.${key}`], { selector: 'span' }).parentElement;
    expect(tile('new')?.textContent).toContain('2');
    expect(tile('regular')?.textContent).toContain('5');
    expect(tile('lapsed')?.textContent).toContain('1');
  });
});

const freshStepUp = (auth: Awaited<ReturnType<typeof createTestAuth>>['auth']) =>
  auth.submitStepUp({ method: 'owner', factors: { password: 'x', totp: '123456' } });

async function openOwner(reports: Parameters<typeof open>[1] = {}, fresh = true) {
  const { auth } = await createTestAuth('owner');
  if (fresh) await freshStepUp(auth);
  const env = createTestServices({
    auth,
    reports: {
      revenue: vi.fn(async (range) => answerFor(range)),
      items: vi.fn(async () => ITEMS),
      heatmap: vi.fn(async () => HEAT),
      customers: vi.fn(async () => CUSTOMERS),
      ...reports,
    },
  });
  renderScreen(<DashboardScreen />, env.services);
  await screen.findByText('฿4,860');
  return env;
}

describe('the accountant exports', () => {
  test('with a fresh step-up the file is fetched for the period on screen, saved and named', async () => {
    const exportCsv = vi.fn(async () => ({
      text: 'ไฟล์',
      filename: 'revenue-2030-10-15-2030-10-15.csv',
    }));
    const env = await openOwner({ exportCsv });
    fireEvent.click(screen.getByRole('button', { name: th['dash.export.revenue'] }));
    await waitFor(() => expect(exportCsv).toHaveBeenCalledTimes(1));
    expect(exportCsv).toHaveBeenCalledWith('revenue', { from: '2030-10-15', to: '2030-10-15' });
    expect(env.files.save).toHaveBeenCalledWith(
      'revenue-2030-10-15-2030-10-15.csv',
      'text/csv',
      'ไฟล์',
    );
    expect(await screen.findByText('บันทึกไฟล์ revenue-2030-10-15-2030-10-15.csv แล้ว')).toBeTruthy();
  });

  test('without one, the owner is asked to confirm first and nothing is sent until then', async () => {
    const exportCsv = vi.fn(async () => ({
      text: 'x',
      filename: 'items-2030-10-15-2030-10-15.csv',
    }));
    await openOwner({ exportCsv }, false);
    fireEvent.click(screen.getByRole('button', { name: th['dash.export.items'] }));
    expect(await screen.findByText(th['auth.stepUp.ownerHint'])).toBeTruthy();
    expect(exportCsv).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: th['common.cancel'] }));
    await waitFor(() => expect(screen.queryByText(th['auth.stepUp.ownerHint'])).toBeNull());
    // cancelling is not an error: no message, no call
    expect(exportCsv).not.toHaveBeenCalled();
    expect(screen.queryByText(th['dash.export.failed'])).toBeNull();
  });

  test('the file follows the period on screen, and a failed export is reported, not hidden', async () => {
    const exportCsv = vi.fn(async () => {
      throw new ApiClientError('NETWORK');
    });
    const env = await openOwner({ exportCsv });
    fireEvent.click(screen.getByRole('radio', { name: th['dash.range.month'] }));
    await waitFor(() =>
      expect(env.api.reports.revenue).toHaveBeenCalledWith({
        from: '2030-10-01',
        to: '2030-10-15',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: th['dash.export.items'] }));
    expect(await screen.findByText(th['dash.export.failed'])).toBeTruthy();
    expect(exportCsv).toHaveBeenCalledWith('items', { from: '2030-10-01', to: '2030-10-15' });
    expect(env.files.save).not.toHaveBeenCalled();
  });
});
