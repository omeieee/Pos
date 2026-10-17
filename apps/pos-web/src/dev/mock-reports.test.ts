import { type OrderDto, satang } from '@sds/shared';
import { describe, expect, test } from 'vitest';
import { createMockReports } from './mock-reports.ts';

const order = (id: string, over: Partial<OrderDto> = {}): OrderDto =>
  ({
    id,
    orderNo: `S-${id}`,
    businessDate: '2030-10-15',
    channel: 'storefront',
    status: 'completed',
    paymentStatus: 'paid',
    totalSatang: satang(10000),
    placedAt: '2030-10-15T05:30:00.000Z',
    items: [
      {
        id: `${id}-i`,
        menuItemId: '0192f3a0-0000-7000-8000-000000000001',
        nameTh: 'ชาเย็น',
        nameEn: null,
        unitPriceSatang: satang(5000),
        qty: 2,
        modifiers: [],
        note: null,
        lineTotalSatang: satang(10000),
      },
    ],
    ...over,
  }) as OrderDto;

function mock(list: OrderDto[]) {
  const orders = new Map(list.map((o) => [o.id, o]));
  return createMockReports({ orders });
}

const q = (from: string, to: string) => new URLSearchParams({ from, to });
const owner = { role: 'owner' as const, stepUpFresh: true };

describe('the dev mock of the report API', () => {
  test('revenue counts paid, not-cancelled orders per business day, by channel', () => {
    const reports = mock([
      order('a'),
      order('b', { channel: 'line', totalSatang: satang(5000) }),
      order('c', { status: 'cancelled' }),
      order('d', { paymentStatus: 'unpaid' }),
      order('e', { businessDate: '2030-10-16' }),
    ]);
    const answer = reports.handle(
      'GET',
      '/v1/reports/revenue',
      q('2030-10-15', '2030-10-15'),
      owner,
    );
    expect(answer?.status).toBe(200);
    expect(answer?.body).toMatchObject({
      from: '2030-10-15',
      to: '2030-10-15',
      totals: { revenueSatang: 15000, orderCount: 2, commissionSatang: 0 },
      days: [
        {
          businessDate: '2030-10-15',
          revenueSatang: 15000,
          orderCount: 2,
          averageTicketSatang: 7500,
          byChannel: { storefront: 10000, line: 5000 },
        },
      ],
    });
  });

  test('items sum units and line totals, best seller first', () => {
    const answer = mock([order('a'), order('b')]).handle(
      'GET',
      '/v1/reports/items',
      q('2030-10-15', '2030-10-15'),
      owner,
    );
    expect(answer?.body).toMatchObject({
      items: [{ name: 'ชาเย็น', qty: 4, revenueSatang: 20000 }],
    });
  });

  test('heatmap uses the Bangkok hour of placing and the weekday of the business day', () => {
    const answer = mock([order('a')]).handle(
      'GET',
      '/v1/reports/heatmap',
      q('2030-10-15', '2030-10-15'),
      owner,
    );
    // 05:30Z is 12:30 in Bangkok; 2030-10-15 is a Tuesday (ISO 2)
    expect(answer?.body).toMatchObject({
      cells: [{ weekday: 2, hour: 12, orderCount: 1, revenueSatang: 10000 }],
    });
  });

  test('a bad range is refused, and a cashier is refused', () => {
    const reports = mock([]);
    expect(
      reports.handle('GET', '/v1/reports/revenue', q('2030-10-16', '2030-10-15'), owner)?.status,
    ).toBe(400);
    expect(
      reports.handle('GET', '/v1/reports/revenue', q('2030-10-15', '2030-10-15'), {
        role: 'cashier',
        stepUpFresh: false,
      })?.status,
    ).toBe(403);
  });

  test('the customer list is the owner only', () => {
    const reports = mock([]);
    expect(
      reports.handle('GET', '/v1/reports/customers', q('2030-10-15', '2030-10-15'), owner)?.status,
    ).toBe(200);
    expect(
      reports.handle('GET', '/v1/reports/customers', new URLSearchParams(), {
        role: 'manager',
        stepUpFresh: false,
      })?.status,
    ).toBe(403);
  });

  test('other paths are not its business', () => {
    expect(mock([]).handle('GET', '/v1/orders', new URLSearchParams(), owner)).toBeNull();
  });

  test('demo orders: two weeks of paid orders, repeatable, that the three reports can read', () => {
    const NOW = Date.parse('2030-10-15T05:00:00Z');
    const orders = new Map<string, OrderDto>();
    const reports = createMockReports({ orders, now: () => NOW });
    const made = reports.seedDemoOrders();
    expect(made).toBe(orders.size);
    expect(made).toBeGreaterThan(80);
    expect([...orders.values()].every((o) => o.paymentStatus === 'paid')).toBe(true);
    const again = createMockReports({ orders: new Map(), now: () => NOW });
    expect(again.seedDemoOrders()).toBe(made);

    const range = q('2030-10-02', '2030-10-15');
    const revenue = reports.handle('GET', '/v1/reports/revenue', range, owner)?.body as {
      days: unknown[];
      totals: { orderCount: number; revenueSatang: number };
    };
    expect(revenue.days).toHaveLength(14);
    expect(revenue.totals.orderCount).toBe(made);
    expect(revenue.totals.revenueSatang).toBeGreaterThan(0);
    const items = reports.handle('GET', '/v1/reports/items', range, owner)?.body as {
      items: { name: string }[];
    };
    expect(items.items.length).toBeGreaterThan(3);
    const heat = reports.handle('GET', '/v1/reports/heatmap', range, owner)?.body as {
      cells: { hour: number }[];
    };
    expect(Math.min(...heat.cells.map((c) => c.hour))).toBeGreaterThanOrEqual(10);
    expect(Math.max(...heat.cells.map((c) => c.hour))).toBeLessThanOrEqual(19);
  });
});
